'use strict';
/* ---------------------------------------------------------------------------
   Monitor 01V96 - app do celular

   Desenha os faders a partir da lista que o bridge manda, fala WebSocket,
   reconecta sozinho quando o Wi-Fi oscila, e conduz a calibracao de cada
   controle sem precisar de terminal na maquina da mesa.
   --------------------------------------------------------------------------- */

const CHAVE_BRIDGE = 'monitor01v96.bridge';
const PASSO_TECLADO = 0.02;
const PASSO_TECLADO_GRANDE = 0.1;
const INTERVALO_ENVIO = 40;   // ms entre lotes de mensagens para o bridge
const BACKOFF_MAX = 5000;     // teto do tempo de espera entre reconexoes

const elCanais = document.getElementById('canais');
const elMestre = document.getElementById('mestre');
const elConexao = document.getElementById('conexao');
const elConexaoTexto = document.getElementById('conexaoTexto');
const elRodape = document.getElementById('rodape');
const elVazio = document.getElementById('vazio');
const elVazioTitulo = document.getElementById('vazioTitulo');
const elVazioTexto = document.getElementById('vazioTexto');
const elVazioAcao = document.getElementById('vazioAcao');
const molde = document.getElementById('moldeFader');

const elAjustes = document.getElementById('ajustes');
const elListaControles = document.getElementById('listaControles');
const elAssistente = document.getElementById('assistente');
const elPainel = document.getElementById('painel');
const elPainelInfo = document.getElementById('painelInfo');
const elPainelEndereco = document.getElementById('painelEndereco');

const faders = new Map(); // id -> componente do fader
let listaControles = [];
let socket = null;
let tentativas = 0;
let timerReconexao = null;
let statusMidi = null;
let conectado = false;

/* ------------------------------- utilidades ------------------------------ */

function limitar01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function definirConexao(estado, texto) {
  document.body.dataset.conexao = estado;
  elConexaoTexto.textContent = texto;
}

function urlDoBridge() {
  const salvo = (localStorage.getItem(CHAVE_BRIDGE) || '').trim();
  if (salvo) return salvo;
  const protocolo = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return protocolo + '//' + location.host;
}

/** O mesmo endereco do bridge, mas em http, para as consultas soltas. */
function urlHttpDoBridge() {
  return urlDoBridge().replace(/^ws/, 'http').replace(/\/+$/, '');
}

function atualizarRodape() {
  if (!conectado) {
    elRodape.textContent = 'sem conexão com o bridge: ' + urlDoBridge();
    return;
  }

  const partes = [];
  if (statusMidi) {
    partes.push(statusMidi.simulado ? 'sem mesa conectada (nada sai daqui)' : 'mesa: ' + statusMidi.saida);
  }
  const semCalibrar = listaControles.filter((c) => !c.calibrated).length;
  if (semCalibrar) partes.push(semCalibrar + ' sem calibrar (*)');
  elRodape.textContent = partes.join('   |   ') || 'conectado';
}

/** Mostra a tela de aviso no lugar dos faders, quando faz sentido. */
function atualizarVazio() {
  if (!conectado) {
    elVazio.hidden = false;
    elVazioTitulo.textContent = 'Sem conexão com o bridge';
    elVazioTexto.textContent =
      'Confira se o programa está rodando na máquina ligada na mesa e se o ' +
      'celular está na mesma rede Wi-Fi.';
    elVazioAcao.hidden = true;
    return;
  }

  if (!listaControles.length) {
    elVazio.hidden = false;
    elVazioTitulo.textContent = 'Nenhum controle ainda';
    elVazioTexto.textContent =
      'Cada controle é o send de um canal da mesa para o Aux do seu fone. ' +
      'Calibre o primeiro para começar.';
    elVazioAcao.hidden = false;
    return;
  }

  elVazio.hidden = true;
}

/* ------------------------------ componente ------------------------------- */

function criarFader(controle) {
  const no = molde.content.firstElementChild.cloneNode(true);
  no.classList.add('fader--' + (controle.type || 'canal'));
  if (!controle.calibrated) no.classList.add('fader--cru');

  const trilho = no.querySelector('[data-trilho]');
  const saidaValor = no.querySelector('[data-valor]');
  const botaoMudo = no.querySelector('[data-mudo]');
  const rotulo = no.querySelector('[data-rotulo]');

  rotulo.textContent = controle.label;
  trilho.setAttribute('aria-label', controle.label);

  const comp = {
    controle,
    no,
    valor: 0,
    mudo: false,

    /** Atualiza a tela. Se avisar = true, manda o novo valor para o bridge. */
    aplicar(valor, avisar) {
      comp.valor = limitar01(valor);
      const porcento = Math.round(comp.valor * 100);
      no.style.setProperty('--v', String(comp.valor));
      saidaValor.textContent = porcento;
      trilho.setAttribute('aria-valuenow', String(porcento));
      trilho.setAttribute('aria-valuetext', porcento + ' por cento');
      if (avisar) enviarValor(controle.id, comp.valor);
    },

    definirMudo(mudo, avisar) {
      comp.mudo = !!mudo;
      botaoMudo.setAttribute('aria-pressed', comp.mudo ? 'true' : 'false');
      no.dataset.mudo = comp.mudo ? '1' : '0';
      if (avisar) enviar({ type: 'mute', control: controle.id, muted: comp.mudo });
    }
  };

  /* ---- arraste com dedo ou mouse ---------------------------------------
     O movimento e relativo: o fader anda o quanto o dedo andou, e nao pula
     para onde voce encostou. No escuro, encostar sem querer nao estoura o
     volume no ouvido.                                                      */

  let arrastando = false;
  let yInicial = 0;
  let valorInicial = 0;
  let cursoUtil = 1;

  function alturaPunho() {
    const bruto = getComputedStyle(no).getPropertyValue('--punho');
    const n = parseFloat(bruto);
    return Number.isFinite(n) ? n : 30;
  }

  trilho.addEventListener('pointerdown', (ev) => {
    arrastando = true;
    yInicial = ev.clientY;
    valorInicial = comp.valor;
    cursoUtil = Math.max(1, trilho.clientHeight - alturaPunho());
    no.dataset.arrastando = '1';
    try { trilho.setPointerCapture(ev.pointerId); } catch { /* ignora */ }
    ev.preventDefault();
  });

  trilho.addEventListener('pointermove', (ev) => {
    if (!arrastando) return;
    const delta = (yInicial - ev.clientY) / cursoUtil; // para cima aumenta
    comp.aplicar(valorInicial + delta, true);
    ev.preventDefault();
  });

  function soltar(ev) {
    if (!arrastando) return;
    arrastando = false;
    delete no.dataset.arrastando;
    try { trilho.releasePointerCapture(ev.pointerId); } catch { /* ignora */ }
    descarregarFila(); // garante que o valor final chegue sem esperar o lote
  }

  trilho.addEventListener('pointerup', soltar);
  trilho.addEventListener('pointercancel', soltar);

  trilho.addEventListener('keydown', (ev) => {
    let novo = null;
    if (ev.key === 'ArrowUp') novo = comp.valor + PASSO_TECLADO;
    else if (ev.key === 'ArrowDown') novo = comp.valor - PASSO_TECLADO;
    else if (ev.key === 'PageUp') novo = comp.valor + PASSO_TECLADO_GRANDE;
    else if (ev.key === 'PageDown') novo = comp.valor - PASSO_TECLADO_GRANDE;
    else if (ev.key === 'Home') novo = 0;
    else if (ev.key === 'End') novo = 1;
    if (novo === null) return;
    ev.preventDefault();
    comp.aplicar(novo, true);
    descarregarFila();
  });

  botaoMudo.addEventListener('click', () => comp.definirMudo(!comp.mudo, true));

  comp.aplicar(0, false);
  return comp;
}

/* ------------------------------ renderizacao ----------------------------- */

function desenharControles(lista) {
  listaControles = Array.isArray(lista) ? lista : [];
  faders.clear();
  elCanais.textContent = '';
  elMestre.textContent = '';

  for (const controle of listaControles) {
    const comp = criarFader(controle);
    faders.set(controle.id, comp);
    if (controle.type === 'master') elMestre.appendChild(comp.no);
    else elCanais.appendChild(comp.no);
  }

  // Sem nenhum master definido, o painel lateral so ocuparia espaco a toa.
  elMestre.style.display = elMestre.childElementCount ? '' : 'none';

  atualizarRodape();
  atualizarVazio();
  if (elAjustes.open) desenharListaAjustes();
}

function aplicarEstado(valores, mutes) {
  if (valores) {
    for (const [id, valor] of Object.entries(valores)) {
      const comp = faders.get(id);
      if (comp) comp.aplicar(Number(valor), false);
    }
  }
  if (mutes) {
    for (const [id, mudo] of Object.entries(mutes)) {
      const comp = faders.get(id);
      if (comp) comp.definirMudo(mudo === true, false);
    }
  }
}

/* --------------------------- envio para o bridge ------------------------- */

const fila = new Map();
let timerFila = null;

function enviar(objeto) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(objeto));
  }
}

/**
 * Arrastar gera evento a cada quadro de tela. Em vez de mandar tudo, guardamos
 * o ultimo valor de cada fader e despachamos em lote. O ouvido nao percebe a
 * diferenca e a rede e o bridge ficam tranquilos.
 */
function enviarValor(id, valor) {
  fila.set(id, valor);
  if (timerFila) return;
  timerFila = setTimeout(descarregarFila, INTERVALO_ENVIO);
}

function descarregarFila() {
  if (timerFila) {
    clearTimeout(timerFila);
    timerFila = null;
  }
  for (const [id, valor] of fila) {
    enviar({ type: 'set', control: id, value: valor });
  }
  fila.clear();
}

/* ------------------------------- WebSocket ------------------------------- */

function conectar() {
  if (timerReconexao) {
    clearTimeout(timerReconexao);
    timerReconexao = null;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  definirConexao(tentativas === 0 ? 'ligando' : 'offline', tentativas === 0 ? 'ligando' : 'reconectando');

  try {
    socket = new WebSocket(urlDoBridge());
  } catch {
    agendarReconexao();
    return;
  }

  socket.addEventListener('open', () => {
    tentativas = 0;
    conectado = true;
    definirConexao('online', 'conectado');
    atualizarRodape();
    atualizarVazio();
    atualizarBotaoAjustes();
    manterTelaAcesa();
  });

  socket.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'controls':
        desenharControles(msg.controls || []);
        break;
      case 'state':
        aplicarEstado(msg.values, msg.mutes);
        break;
      case 'status':
        statusMidi = msg.midi || null;
        atualizarRodape();
        desenharEstadoDaMesa();
        break;
      case 'midi:portas':
        desenharPortasDaMesa(msg);
        break;
      default:
        if (msg.type && msg.type.startsWith('learn:')) receberDoAssistente(msg);
    }
  });

  socket.addEventListener('close', () => {
    conectado = false;
    definirConexao('offline', 'reconectando');
    atualizarRodape();
    atualizarVazio();
    atualizarBotaoAjustes();
    if (elAjustes.open) elAjustes.close();
    if (assistente.ativo) {
      mostrarErroAssistente('A conexão com o bridge caiu. Refaça quando reconectar.');
    }
    agendarReconexao();
  });

  socket.addEventListener('error', () => {
    try { socket.close(); } catch { /* o close cuida da reconexao */ }
  });
}

function agendarReconexao() {
  tentativas++;
  if (timerReconexao) return;
  const espera = Math.min(BACKOFF_MAX, 500 * Math.pow(2, Math.min(tentativas, 4)));
  timerReconexao = setTimeout(() => {
    timerReconexao = null;
    conectar();
  }, espera);
}

/* ------------------------------- ajustes --------------------------------- */

function desenharListaAjustes() {
  elListaControles.textContent = '';

  if (!listaControles.length) {
    const vazio = document.createElement('li');
    vazio.className = 'lista__vazio';
    vazio.textContent = 'Nenhum controle ainda.';
    elListaControles.appendChild(vazio);
    return;
  }

  for (const controle of listaControles) {
    const item = document.createElement('li');
    item.className = 'lista__item';

    const info = document.createElement('div');
    info.className = 'lista__info';

    const nome = document.createElement('span');
    nome.className = 'lista__nome';
    nome.textContent = controle.label;

    const estado = document.createElement('span');
    estado.className = 'lista__estado';
    estado.textContent = controle.calibrated
      ? (controle.type === 'master' ? 'volume geral' : controle.type === 'reverb' ? 'reverb' : 'canal')
      : 'falta calibrar';
    if (!controle.calibrated) estado.classList.add('lista__estado--pendente');

    info.append(nome, estado);

    const acoes = document.createElement('div');
    acoes.className = 'lista__acoes';

    const calibrar = document.createElement('button');
    calibrar.className = 'botao botao--pequeno';
    calibrar.type = 'button';
    calibrar.textContent = controle.calibrated ? 'Recalibrar' : 'Calibrar';
    calibrar.addEventListener('click', () => {
      elAjustes.close();
      abrirAssistente(controle);
    });

    const remover = document.createElement('button');
    remover.className = 'botao botao--pequeno botao--fantasma';
    remover.type = 'button';
    remover.textContent = 'Remover';
    remover.addEventListener('click', () => {
      if (!confirm('Remover "' + controle.label + '" do seu monitor?')) return;
      enviar({ type: 'controle:remover', control: controle.id });
    });

    acoes.append(calibrar, remover);
    item.append(info, acoes);
    elListaControles.appendChild(item);
  }
}

/* ---- qual porta MIDI e a mesa ----------------------------------------- */

const elMesaEstado = document.getElementById('mesaEstado');
const elMesaPorta = document.getElementById('mesaPorta');

function desenharEstadoDaMesa() {
  if (!statusMidi) {
    elMesaEstado.textContent = 'procurando';
    return;
  }
  elMesaEstado.textContent = statusMidi.simulado
    ? 'nenhuma mesa encontrada no cabo USB'
    : 'conectada em ' + statusMidi.saida;
  elMesaEstado.classList.toggle('bloco__estado--alerta', !!statusMidi.simulado);
}

function desenharPortasDaMesa(msg) {
  const nomes = msg.saidas || [];
  elMesaPorta.textContent = '';

  // Um select sem nenhuma opcao vira aquele "Sem Opções" do iPhone, que nao
  // explica nada. Sempre existe pelo menos uma linha dizendo o que esta havendo.
  const automatico = document.createElement('option');
  automatico.value = '';
  automatico.textContent = nomes.length ? 'Procurar sozinho' : 'Nenhuma porta MIDI no cabo';
  elMesaPorta.appendChild(automatico);

  for (const nome of nomes) {
    const opcao = document.createElement('option');
    opcao.value = nome;
    opcao.textContent = nome;
    elMesaPorta.appendChild(opcao);
  }

  elMesaPorta.value = msg.escolhida || '';
  elMesaPorta.disabled = !nomes.length;
}

elMesaPorta.addEventListener('change', () => {
  enviar({ type: 'midi:usar', porta: elMesaPorta.value });
});

const elBtnAjustes = document.getElementById('btnAjustes');

elBtnAjustes.addEventListener('click', () => {
  // Sem bridge nao ha nada para ajustar: a lista, a mesa e a calibracao todas
  // dependem dele. Abrir a tela so mostraria campos vazios.
  if (!conectado) {
    elPainelEndereco.value = localStorage.getItem(CHAVE_BRIDGE) || '';
    elPainelInfo.textContent =
      'Ainda não achei o bridge.\nEndereço em uso: ' + urlDoBridge();
    elPainel.showModal();
    return;
  }
  desenharListaAjustes();
  desenharEstadoDaMesa();
  enviar({ type: 'midi:portas' });
  elAjustes.showModal();
});

/* ---- diagnostico para colar numa conversa ----------------------------- */

const elBtnDiagnostico = document.getElementById('btnDiagnostico');

elBtnDiagnostico.addEventListener('click', async () => {
  const original = elBtnDiagnostico.textContent;
  elBtnDiagnostico.disabled = true;
  elBtnDiagnostico.textContent = 'montando';

  let texto;
  try {
    const dados = await fetch(urlHttpDoBridge() + '/api/status', { cache: 'no-store' }).then((r) => r.json());
    const linhas = [
      'Monitor 01V96, diagnóstico de ' + new Date().toLocaleString('pt-BR'),
      'endereço: ' + urlDoBridge(),
      'máquina: ' + dados.maquina.sistema + ', node ' + dados.maquina.node + ', ligado há ' + dados.maquina.ligadoHa,
      'mesa: ' + (dados.midi.simulado ? 'NAO ENCONTRADA' : dados.midi.saida),
      'motivo: ' + (dados.midi.motivo || 'sem erro'),
      'portas MIDI vistas: ' + ((dados.midi.portasVistas || []).join(' | ') || 'nenhuma'),
      'controles: ' + dados.controles + ', sem calibrar: ' + (dados.naoCalibrados.join(', ') || 'nenhum'),
      'celulares conectados: ' + dados.clientes,
      'celular: ' + navigator.userAgent,
      '',
      'últimos avisos do programa:',
      ...(dados.avisos && dados.avisos.length ? dados.avisos : ['nenhum'])
    ];
    texto = linhas.join('\n');
  } catch (erro) {
    texto = 'Monitor 01V96: não consegui falar com o bridge em ' + urlDoBridge() + '\n' + erro.message;
  }

  let copiou = false;
  try {
    await navigator.clipboard.writeText(texto);
    copiou = true;
  } catch { /* alguns navegadores só deixam copiar com o campo na tela */ }

  if (!copiou) {
    // Plano B: mostra o texto selecionado para copiar na mão.
    const campo = document.createElement('textarea');
    campo.value = texto;
    campo.style.cssText = 'position:fixed;inset:auto 10px 10px 10px;height:40dvh;z-index:99;font-size:12px';
    document.body.appendChild(campo);
    campo.select();
    try { copiou = document.execCommand('copy'); } catch { /* ignora */ }
    setTimeout(() => campo.remove(), copiou ? 0 : 20000);
  }

  elBtnDiagnostico.textContent = copiou ? 'copiado' : 'selecione e copie';
  setTimeout(() => {
    elBtnDiagnostico.textContent = original;
    elBtnDiagnostico.disabled = false;
  }, 2200);
});

/** O botao de ajustes fica apagado enquanto nao ha bridge. */
function atualizarBotaoAjustes() {
  elBtnAjustes.classList.toggle('icone-botao--apagado', !conectado);
}

document.getElementById('btnFecharAjustes').addEventListener('click', () => elAjustes.close());

document.getElementById('btnAdicionar').addEventListener('click', () => {
  elAjustes.close();
  abrirAssistente(null);
});

elVazioAcao.addEventListener('click', () => abrirAssistente(null));

/* ------------------------- assistente de calibracao ---------------------- */

const assistente = {
  ativo: false,
  controle: null,  // null quando e um controle novo
  etapa: 'nome',   // nome | min | max | salvando | fim
  tipo: 'canal'
};

const elEtapaNome = document.getElementById('etapaNome');
const elEtapaCaptura = document.getElementById('etapaCaptura');
const elEtapaFim = document.getElementById('etapaFim');
const elAssTitulo = document.getElementById('assTitulo');
const elAssNome = document.getElementById('assNome');
const elAssTipo = document.getElementById('assTipo');
const elAssInstrucao = document.getElementById('assInstrucao');
const elAssContador = document.getElementById('assContador');
const elAssHex = document.getElementById('assHex');
const elAssResumo = document.getElementById('assResumo');
const elAssErro = document.getElementById('assErro');
const elAssSeguir = document.getElementById('assSeguir');
const elAssCancelar = document.getElementById('assCancelar');

function abrirAssistente(controle) {
  if (!conectado) {
    alert('Sem conexão com o bridge. A calibração precisa falar com a mesa.');
    return;
  }

  assistente.ativo = true;
  assistente.controle = controle;
  assistente.etapa = 'nome';
  assistente.tipo = controle ? controle.type : 'canal';

  elAssTitulo.textContent = controle ? 'Recalibrar ' + controle.label : 'Novo controle';
  elAssNome.value = controle ? controle.label : '';
  marcarTipo(assistente.tipo);
  esconderErroAssistente();
  desenharEtapa();
  elAssistente.showModal();
  if (!controle) setTimeout(() => elAssNome.focus(), 60);
}

function marcarTipo(tipo) {
  assistente.tipo = tipo;
  for (const botao of elAssTipo.querySelectorAll('[data-tipo]')) {
    botao.setAttribute('aria-pressed', botao.dataset.tipo === tipo ? 'true' : 'false');
  }
}

elAssTipo.addEventListener('click', (ev) => {
  const botao = ev.target.closest('[data-tipo]');
  if (botao) marcarTipo(botao.dataset.tipo);
});

function desenharEtapa() {
  elEtapaNome.hidden = assistente.etapa !== 'nome';
  elEtapaCaptura.hidden = !(assistente.etapa === 'min' || assistente.etapa === 'max');
  elEtapaFim.hidden = assistente.etapa !== 'fim';

  if (assistente.etapa === 'nome') {
    elAssSeguir.textContent = 'Continuar';
    elAssSeguir.disabled = false;
  } else if (assistente.etapa === 'min') {
    elAssInstrucao.textContent =
      'Na mesa, leve o send de "' + nomeAtual() + '" para o seu Aux até o MÍNIMO, tudo embaixo.';
    elAssSeguir.textContent = 'Capturei o mínimo';
    elAssSeguir.disabled = false;
    zerarMedidor();
  } else if (assistente.etapa === 'max') {
    elAssInstrucao.textContent = 'Agora leve o mesmo controle até o MÁXIMO, tudo em cima.';
    elAssSeguir.textContent = 'Capturei o máximo';
    elAssSeguir.disabled = false;
    zerarMedidor();
  } else if (assistente.etapa === 'salvando') {
    elAssSeguir.textContent = 'Salvando';
    elAssSeguir.disabled = true;
  } else if (assistente.etapa === 'fim') {
    elAssSeguir.textContent = 'Concluir';
    elAssSeguir.disabled = false;
  }
}

function nomeAtual() {
  return elAssNome.value.trim() || (assistente.controle ? assistente.controle.label : 'controle');
}

function zerarMedidor() {
  elAssContador.textContent = 'esperando a mesa falar';
  elAssHex.textContent = '';
  elAssContador.classList.remove('medidor__texto--ativo');
}

function mostrarErroAssistente(texto) {
  elAssErro.textContent = texto;
  elAssErro.hidden = false;
}

function esconderErroAssistente() {
  elAssErro.hidden = true;
  elAssErro.textContent = '';
}

elAssSeguir.addEventListener('click', () => {
  esconderErroAssistente();

  if (assistente.etapa === 'nome') {
    const nome = elAssNome.value.trim();
    if (!nome) {
      mostrarErroAssistente('Dê um nome para este controle.');
      return;
    }
    enviar({
      type: 'learn:iniciar',
      control: assistente.controle ? assistente.controle.id : null,
      label: nome,
      kind: assistente.tipo
    });
    assistente.etapa = 'min';
    desenharEtapa();
    return;
  }

  if (assistente.etapa === 'min' || assistente.etapa === 'max') {
    enviar({ type: 'learn:capturar', step: assistente.etapa });
    return;
  }

  if (assistente.etapa === 'fim') {
    fecharAssistente(false);
  }
});

elAssCancelar.addEventListener('click', () => fecharAssistente(true));

elAssistente.addEventListener('cancel', (ev) => {
  ev.preventDefault();
  fecharAssistente(true);
});

function fecharAssistente(avisarBridge) {
  if (avisarBridge && assistente.ativo) enviar({ type: 'learn:cancelar' });
  assistente.ativo = false;
  elAssistente.close();
}

/** Mensagens learn:* vindas do bridge. */
function receberDoAssistente(msg) {
  if (msg.type === 'learn:midi') {
    if (!assistente.ativo) return;
    elAssContador.textContent =
      'a mesa enviou ' + msg.count + (msg.count === 1 ? ' mensagem' : ' mensagens');
    elAssContador.classList.add('medidor__texto--ativo');
    elAssHex.textContent = msg.hex;
    return;
  }

  if (msg.type === 'learn:capturado') {
    if (msg.step === 'min') {
      assistente.etapa = 'max';
      desenharEtapa();
    } else {
      assistente.etapa = 'salvando';
      desenharEtapa();
      enviar({ type: 'learn:salvar' });
    }
    return;
  }

  if (msg.type === 'learn:salvo') {
    assistente.etapa = 'fim';

    const detalhe =
      'valor no byte ' + msg.bytes.offset + ', ' + msg.bytes.length + ' byte(s), ' +
      'faixa ' + msg.faixa.rawMin + ' a ' + msg.faixa.rawMax;

    elAssResumo.textContent = '"' + msg.control.label + '" já responde no seu fone.';
    elAssResumo.dataset.detalhe = detalhe;

    if (msg.avisos && msg.avisos.length) {
      mostrarErroAssistente(msg.avisos.join(' '));
    }
    desenharEtapa();
    return;
  }

  if (msg.type === 'learn:erro') {
    if (assistente.etapa === 'salvando') {
      assistente.etapa = 'min';
      desenharEtapa();
    }
    mostrarErroAssistente(msg.message || 'Não consegui aprender esse controle.');
  }
}

/* ------------------------- painel de conexao ----------------------------- */

elConexao.addEventListener('click', () => {
  const salvo = localStorage.getItem(CHAVE_BRIDGE) || '';
  elPainelEndereco.value = salvo;
  elPainelInfo.textContent =
    'Situação: ' + elConexaoTexto.textContent + '\nEndereço em uso: ' + urlDoBridge();
  elPainel.showModal();
});

elPainel.addEventListener('close', () => {
  if (elPainel.returnValue !== 'salvar') return;

  const valor = elPainelEndereco.value.trim();
  if (valor) localStorage.setItem(CHAVE_BRIDGE, valor);
  else localStorage.removeItem(CHAVE_BRIDGE);

  // Reconecta ja com o endereco novo, do zero.
  tentativas = 0;
  if (socket) {
    try { socket.close(); } catch { /* ignora */ }
  }
  conectar();
});

/* ------------------------------- extras ---------------------------------- */

// Tela apagando no meio do louvor nao ajuda ninguem. O navegador pode negar,
// e nesse caso simplesmente seguimos sem isso.
let travaTela = null;
async function manterTelaAcesa() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      travaTela = await navigator.wakeLock.request('screen');
    }
  } catch { /* sem trava de tela, sem problema */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  manterTelaAcesa();
  // Celular que dormiu costuma voltar com o socket morto sem avisar.
  if (!socket || socket.readyState > WebSocket.OPEN) {
    tentativas = 0;
    conectar();
  }
});

window.addEventListener('online', () => {
  tentativas = 0;
  conectar();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app funciona sem ele */ });
  });
}

atualizarVazio();
atualizarBotaoAjustes();
conectar();
