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
  if (elAjustes.open) {
    desenharListaAjustes();
    desenharGerar();
  }
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
        elDevolverMix.checked = msg.devolverMix === true;
        atualizarRodape();
        desenharEstadoDaMesa();
        desenharGerar();
        break;
      case 'midi:portas':
        desenharPortasDaMesa(msg);
        break;
      case 'gerar:progresso':
      case 'gerar:fim':
      case 'gerar:erro':
        receberDaGeracao(msg);
        break;
      case 'controle:erro':
        // Tambem chega aqui o erro de dar nome a uma cena.
        alert(msg.message || 'Não consegui mudar esse controle.');
        break;
      case 'cena':
        receberCena(msg);
        break;
      case 'cena:relida':
        receberRelida(msg);
        break;
      default:
        if (msg.type && msg.type.startsWith('learn:')) receberDoAssistente(msg);
    }
  });

  socket.addEventListener('close', () => {
    // Cada tentativa de reconexao que falha tambem dispara 'close'. So a queda
    // de verdade (estava conectado) mexe na folha de ajustes.
    const caiuAgora = conectado;
    conectado = false;
    definirConexao('offline', 'reconectando');
    // Sem bridge a cena pode mudar sem a gente saber: o rotulo some ate o
    // bridge contar de novo, logo que reconectar.
    limparAviso();
    desenharCena();
    atualizarRodape();
    atualizarVazio();
    atualizarBotaoAjustes();
    if (gerar.ativo) {
      // Mesma ideia do assistente: a folha fica aberta para a pessoa ler o
      // aviso, em vez de sumir e deixar a duvida se criou ou nao. Fica segura
      // ate a propria pessoa fechar, mesmo que o Wi-Fi volte e caia de novo.
      gerar.segurarFolha = true;
      terminarGerar('', 'A conexão com o bridge caiu no meio da conferência. ' +
        'O que a mesa já confirmou fica salvo; confira a lista quando reconectar.');
    } else if (caiuAgora && elAjustes.open && !gerar.segurarFolha) {
      elAjustes.close();
    } else {
      desenharGerar();
    }
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

    // O nome inteiro e o botao de renomear. Um terceiro botao ao lado de
    // Recalibrar e Remover nao cabe em 360px sem quebrar a linha, e a lista
    // pode chegar a 30 e tantos itens depois de criar os canais.
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'lista__info lista__renomear';
    info.setAttribute('aria-label', 'Renomear "' + controle.label + '"');
    info.addEventListener('click', () => renomearControle(controle));

    const linha = document.createElement('span');
    linha.className = 'lista__linha';

    const nome = document.createElement('span');
    nome.className = 'lista__nome';
    nome.textContent = controle.label;

    linha.append(nome, iconeLapis());

    const estado = document.createElement('span');
    estado.className = 'lista__estado';
    estado.textContent = controle.calibrated ? descreverTipo(controle) : 'falta calibrar';
    if (!controle.calibrated) estado.classList.add('lista__estado--pendente');

    info.append(linha, estado);

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
      if (!conectado) {
        alert('Sem conexão com o bridge. Remova quando reconectar.');
        return;
      }
      if (!confirm('Remover "' + controle.label + '" do seu monitor?')) return;
      enviar({ type: 'controle:remover', control: controle.id });
    });

    acoes.append(calibrar, remover);
    item.append(info, acoes);
    elListaControles.appendChild(item);
  }
}

function descreverTipo(controle) {
  if (controle.type === 'master') return 'volume geral';
  if (controle.type === 'reverb') return 'reverb';
  return canalDaMesa(controle) ? 'canal ' + controle.canal + ' da mesa' : 'canal';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function iconeLapis() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'lista__lapis');
  const traco = document.createElementNS(SVG_NS, 'path');
  traco.setAttribute('d', 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4');
  svg.appendChild(traco);
  return svg;
}

const NOME_MAX = 40;

function renomearControle(controle) {
  if (!conectado) {
    alert('Sem conexão com o bridge. Renomeie quando reconectar.');
    return;
  }

  let sugestao = controle.label;
  for (;;) {
    const digitado = prompt('Novo nome para "' + controle.label + '"', sugestao);
    if (digitado === null) return; // cancelou

    const nome = digitado.trim();
    if (!nome) {
      alert('O nome não pode ficar vazio.');
      continue;
    }
    if (nome.length > NOME_MAX) {
      alert('Use no máximo ' + NOME_MAX + ' letras. Cortei o que passou, confira.');
      sugestao = nome.slice(0, NOME_MAX).trim();
      continue;
    }
    if (nome === controle.label) return;

    // A resposta de sucesso e a lista nova ("controls"), que redesenha tudo.
    enviar({ type: 'controle:renomear', control: controle.id, label: nome });
    return;
  }
}

/* ---- criar os outros canais a partir de um calibrado ------------------ */

const TOTAL_CANAIS = 32;
const ESPERA_MAX_GERAR = 20000; // sem noticia do bridge por tanto tempo = travou

const elGerarExplica = document.getElementById('gerarExplica');
const elGerarGrade = document.getElementById('gerarGrade');
const elGerarContagem = document.getElementById('gerarContagem');
const elGerarAtalhos = document.getElementById('gerarAtalhos');
const elGerarProgresso = document.getElementById('gerarProgresso');
const elGerarProgressoTexto = document.getElementById('gerarProgressoTexto');
const elGerarConteudo = document.getElementById('gerarConteudo');
const elGerarBarra = document.getElementById('gerarBarra');
const elGerarBarraTrilho = document.getElementById('gerarBarraTrilho');
const elGerarUltimo = document.getElementById('gerarUltimo');
const elGerarResumo = document.getElementById('gerarResumo');
const elGerarErro = document.getElementById('gerarErro');
const elGerarMotivo = document.getElementById('gerarMotivo');
const elBtnGerar = document.getElementById('btnGerar');

const gerar = {
  ativo: false,
  marcados: new Set(),  // canais escolhidos na grade
  enviados: [],         // o que foi pedido na ultima conferencia
  feitos: 0,
  total: 0,
  resumo: '',
  erro: '',
  vigia: null,
  segurarFolha: false   // a conexao caiu no meio: a folha so fecha pela pessoa
};

elAjustes.addEventListener('close', () => { gerar.segurarFolha = false; });

/** O numero do canal da mesa (1..32) que o controle conhece, ou null. */
function canalDaMesa(controle) {
  const n = controle && controle.canal;
  return Number.isInteger(n) && n >= 1 && n <= TOTAL_CANAIS ? n : null;
}

function controleBase() {
  return listaControles.find((c) => canalDaMesa(c)) || null;
}

function canaisQueJaExistem() {
  const usados = new Set();
  for (const c of listaControles) {
    const n = canalDaMesa(c);
    if (n) usados.add(n);
  }
  return usados;
}

/** Motivo para nao poder conferir agora, ou '' quando a mesa pode responder. */
function motivoMesaIndisponivel() {
  if (!conectado) return 'Sem conexão com o bridge. Espere reconectar para conferir.';
  const aviso = 'A mesa precisa estar ligada no cabo USB para responder. ';
  if (!statusMidi || statusMidi.simulado) return aviso + 'Agora o programa não encontra a mesa.';
  if (statusMidi.entradaSimulada) return aviso + 'Agora o programa manda para a mesa, mas não escuta o que ela responde.';
  return '';
}

/** "13", "13 e 14", "13, 14 e 15" */
function juntarNumeros(lista) {
  const n = [...lista].sort((a, b) => a - b);
  if (n.length <= 1) return n.join('');
  return n.slice(0, -1).join(', ') + ' e ' + n[n.length - 1];
}

/** Por que nao ha molde para criar os outros canais. */
function motivoSemBase() {
  const canalCalibrado = listaControles.some((c) => (c.type || 'canal') === 'canal' && c.calibrated);
  return canalCalibrado
    ? 'O canal calibrado não está no formato do manual da 01V96. Calibre os canais um a um.'
    : 'Calibre um canal primeiro: ele vira o molde para criar os outros.';
}

function desenharGerar() {
  const base = controleBase();

  // Sem molde, o bloco fica compacto: so o titulo e o que falta.
  elGerarConteudo.hidden = !base;
  if (!base) {
    elGerarExplica.textContent = motivoSemBase();
    return;
  }

  const existentes = canaisQueJaExistem();
  for (const n of existentes) gerar.marcados.delete(n);

  elGerarExplica.textContent =
    'Usa "' + base.label + '" (canal ' + base.canal + '), que já está calibrado, como molde. ' +
    'Antes de criar, confere cada canal marcado com a mesa. Nada muda no som enquanto confere.';

  // Grade: os 32 botoes nascem uma vez e so mudam de estado, para o foco do
  // teclado nao se perder a cada toque.
  if (elGerarGrade.childElementCount !== TOTAL_CANAIS) {
    elGerarGrade.textContent = '';
    for (let n = 1; n <= TOTAL_CANAIS; n++) {
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'opcoes__item grade__canal';
      botao.dataset.canal = String(n);
      botao.textContent = String(n);
      elGerarGrade.appendChild(botao);
    }
  }
  elGerarGrade.dataset.travada = gerar.ativo ? '1' : '0';
  for (const botao of elGerarGrade.children) {
    const n = Number(botao.dataset.canal);
    const existe = existentes.has(n);
    botao.classList.toggle('grade__canal--existe', existe);
    botao.disabled = existe || gerar.ativo;
    if (existe) {
      botao.removeAttribute('aria-pressed');
      botao.setAttribute('aria-label', 'Canal ' + n + ', já está no seu monitor');
    } else {
      botao.setAttribute('aria-pressed', gerar.marcados.has(n) ? 'true' : 'false');
      botao.setAttribute('aria-label', 'Canal ' + n);
    }
  }

  const qtd = gerar.marcados.size;
  elGerarContagem.textContent = qtd === 0 ? 'nenhum marcado' : qtd === 1 ? '1 marcado' : qtd + ' marcados';

  for (const atalho of elGerarAtalhos.querySelectorAll('button')) atalho.disabled = gerar.ativo;

  // Progresso (o texto e aria-live; a barra e um progressbar de verdade)
  elGerarProgresso.hidden = !gerar.ativo;
  if (gerar.ativo) {
    const texto = 'conferindo com a mesa: ' + gerar.feitos + ' de ' + gerar.total;
    // So reescreve quando muda: o leitor de tela anuncia cada troca.
    if (elGerarProgressoTexto.textContent !== texto) elGerarProgressoTexto.textContent = texto;
    elGerarBarra.style.width = (gerar.total ? Math.round((gerar.feitos / gerar.total) * 100) : 0) + '%';
    elGerarBarraTrilho.setAttribute('aria-valuemax', String(Math.max(1, gerar.total)));
    elGerarBarraTrilho.setAttribute('aria-valuenow', String(gerar.feitos));
    elGerarBarraTrilho.setAttribute('aria-valuetext', gerar.feitos + ' de ' + gerar.total + ' canais');
  }

  // Resultado da ultima conferencia
  elGerarResumo.textContent = gerar.resumo;
  elGerarResumo.hidden = !gerar.resumo;
  elGerarErro.textContent = gerar.erro;
  elGerarErro.hidden = !gerar.erro;

  // Botao principal. O motivo e a descricao dele (aria-describedby): fica sem
  // texto quando escondido, para nao ser lido a toa.
  const motivo = motivoMesaIndisponivel();
  const mostrarMotivo = !!motivo && !gerar.ativo;
  elGerarMotivo.textContent = mostrarMotivo ? motivo : '';
  elGerarMotivo.hidden = !mostrarMotivo;
  elBtnGerar.disabled = gerar.ativo || !!motivo || qtd === 0;
  elBtnGerar.textContent = gerar.ativo ? 'Conferindo com a mesa' : 'Conferir com a mesa e criar';
}

elGerarGrade.addEventListener('click', (ev) => {
  const botao = ev.target.closest('[data-canal]');
  if (!botao || botao.disabled || gerar.ativo) return;
  const n = Number(botao.dataset.canal);
  if (gerar.marcados.has(n)) gerar.marcados.delete(n);
  else gerar.marcados.add(n);
  desenharGerar();
});

elGerarAtalhos.addEventListener('click', (ev) => {
  const botao = ev.target.closest('[data-faixa]');
  if (!botao || gerar.ativo) return;

  if (botao.dataset.faixa === 'limpar') {
    gerar.marcados.clear();
  } else {
    // Marca a faixa toda; se ela ja estava toda marcada, desmarca.
    const [de, ate] = botao.dataset.faixa.split('-').map(Number);
    const existentes = canaisQueJaExistem();
    const livres = [];
    for (let n = de; n <= ate; n++) if (!existentes.has(n)) livres.push(n);
    const todosMarcados = livres.length > 0 && livres.every((n) => gerar.marcados.has(n));
    for (const n of livres) {
      if (todosMarcados) gerar.marcados.delete(n);
      else gerar.marcados.add(n);
    }
  }
  desenharGerar();
});

elBtnGerar.addEventListener('click', () => {
  const base = controleBase();
  if (!base || gerar.ativo || !gerar.marcados.size || motivoMesaIndisponivel()) return;
  if (!conectado) {
    alert('Sem conexão com o bridge. Tente de novo quando reconectar.');
    return;
  }

  const canais = [...gerar.marcados].sort((a, b) => a - b);
  gerar.ativo = true;
  gerar.enviados = canais;
  gerar.feitos = 0;
  gerar.total = canais.length;
  gerar.resumo = '';
  gerar.erro = '';
  elGerarUltimo.textContent = '';
  vigiarGerar();
  enviar({ type: 'gerar:canais', base: base.id, canais });
  desenharGerar();
});

/** Se o bridge parar de dar noticia, destrava em vez de deixar a tela presa. */
function vigiarGerar() {
  clearTimeout(gerar.vigia);
  gerar.vigia = setTimeout(() => {
    if (!gerar.ativo) return;
    terminarGerar('', 'O bridge parou de dar notícia da conferência. ' +
      'O que a mesa já confirmou fica salvo; confira a lista acima e marque de novo o que faltou.');
  }, ESPERA_MAX_GERAR);
}

function terminarGerar(resumo, erro) {
  clearTimeout(gerar.vigia);
  gerar.vigia = null;
  gerar.ativo = false;
  gerar.resumo = resumo;
  gerar.erro = erro;
  desenharGerar();
}

/** Mensagens gerar:* vindas do bridge. */
function receberDaGeracao(msg) {
  if (msg.type === 'gerar:progresso') {
    // gerar:* so chega para o celular que pediu. Progresso atrasado, depois de
    // a vigia ou a queda ja terem destravado a tela, nao trava de novo.
    if (!gerar.ativo) return;
    gerar.feitos = Number(msg.feitos) || 0;
    gerar.total = Number(msg.total) || gerar.total;
    if (Number.isInteger(msg.canal)) {
      elGerarUltimo.textContent = 'canal ' + msg.canal + ': ' +
        (msg.confirmado ? 'a mesa respondeu' : 'a mesa não respondeu');
    }
    vigiarGerar();
    desenharGerar();
    return;
  }

  if (msg.type === 'gerar:fim') {
    const criados = Array.isArray(msg.criados) ? msg.criados : [];
    const semResposta = Array.isArray(msg.semResposta) ? msg.semResposta : [];
    const jaExistiam = Array.isArray(msg.jaExistiam) ? msg.jaExistiam : [];

    // Fica marcado so o que ainda falta: quem nao respondeu e, se a mesa sumiu
    // no meio, quem nem chegou a ser conferido. Assim "tentar de novo" e um toque.
    const resolvidos = new Set([...criados.map((c) => c.canal), ...jaExistiam]);
    gerar.marcados = new Set(gerar.enviados.filter((n) => !resolvidos.has(n)));
    for (const n of semResposta) gerar.marcados.add(n);

    const qtd = criados.length;
    let resumo = qtd === 0 ? 'Nenhum canal criado.' : qtd === 1 ? '1 canal criado.' : qtd + ' canais criados.';
    if (jaExistiam.length) {
      resumo += jaExistiam.length === 1
        ? ' O canal ' + jaExistiam[0] + ' já existia.'
        : ' Os canais ' + juntarNumeros(jaExistiam) + ' já existiam.';
    }

    const problemas = [];
    if (msg.interrompido) {
      problemas.push('A mesa sumiu no meio da conferência. O que ela confirmou ficou salvo; ' +
        'os que faltaram continuam marcados para tentar de novo quando ela voltar.');
    }
    if (semResposta.length) {
      problemas.push(semResposta.length === 1
        ? 'A mesa não respondeu o canal ' + semResposta[0] + ', ele não foi criado.'
        : 'A mesa não respondeu os canais ' + juntarNumeros(semResposta) + ', eles não foram criados.');
      if (!msg.interrompido) {
        problemas.push(semResposta.length === 1
          ? 'Ele continua marcado para tentar de novo.'
          : 'Eles continuam marcados para tentar de novo.');
      }
    }

    terminarGerar(resumo, problemas.join(' '));
    return;
  }

  if (msg.type === 'gerar:erro') {
    terminarGerar('', msg.message || 'Não consegui criar os canais.');
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

// Fica no celular para ninguem precisar editar o config.json no PC da mesa.
const elDevolverMix = document.getElementById('devolverMix');

elDevolverMix.addEventListener('change', () => {
  enviar({ type: 'config:devolverMix', ligado: elDevolverMix.checked });
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
  desenharGerar();
  desenharCenas();
  enviar({ type: 'midi:portas' });
  elAjustes.showModal();
});

/* ---- cena da mesa ------------------------------------------------------
   Cada tecnico tem a sua cena, e a cena tambem muda os fones. A mesa so conta
   o numero (0 a 99); o nome e dado aqui e vale para todos os celulares.    */

const NOME_CENA_MAX = 30;
const AVISO_TROCA_MS = 6000;
const AVISO_RELIDA_MS = 5000;

const elTopo = document.querySelector('.topo');
const elCena = document.getElementById('cena');
const elCenaNumero = document.getElementById('cenaNumero');
const elCenaPonto = document.getElementById('cenaPonto');
const elCenaNome = document.getElementById('cenaNome');
const elRodapeBarra = elRodape.parentElement;
const elRodapeAviso = document.getElementById('rodapeAviso');
const elCenasExplica = document.getElementById('cenasExplica');
const elListaCenas = document.getElementById('listaCenas');

const cena = {
  conhecida: false, // ja chegou alguma mensagem 'cena' desde que a pagina abriu
  atual: null,      // { numero, nome, em, origem, bruto } ou null
  nomes: new Map(), // numero -> nome
  vistas: []        // numeros em ordem
};

/** 0..99, vindo como numero ou como chave de objeto ("3"); senao null. */
function numeroDeCena(valor) {
  const n = typeof valor === 'string' && /^\d{1,2}$/.test(valor.trim()) ? Number(valor) : valor;
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
}

function nomeDaCena(numero) {
  return cena.nomes.get(numero) || '';
}

/** "Cena 3 · Pedro" ou "Cena 3". */
function rotuloDaCena(numero) {
  const nome = nomeDaCena(numero);
  return 'Cena ' + numero + (nome ? ' · ' + nome : '');
}

function receberCena(msg) {
  const antes = cena.atual ? cena.atual.numero : null;
  const jaConhecida = cena.conhecida;

  const nomes = new Map();
  if (msg.nomes && typeof msg.nomes === 'object') {
    for (const [chave, nome] of Object.entries(msg.nomes)) {
      const n = numeroDeCena(chave);
      const texto = typeof nome === 'string' ? nome.trim() : '';
      if (n !== null && texto) nomes.set(n, texto);
    }
  }

  const vistas = new Set();
  if (Array.isArray(msg.vistas)) {
    for (const v of msg.vistas) {
      const n = numeroDeCena(v);
      if (n !== null) vistas.add(n);
    }
  }

  const atual = msg.atual && typeof msg.atual === 'object' ? msg.atual : null;
  const numero = atual ? numeroDeCena(atual.numero) : null;
  if (numero !== null) {
    vistas.add(numero);
    const nomeAtual = typeof atual.nome === 'string' ? atual.nome.trim() : '';
    if (nomeAtual && !nomes.has(numero)) nomes.set(numero, nomeAtual);
  }

  cena.atual = numero === null ? null : { ...atual, numero };
  cena.nomes = nomes;
  cena.vistas = [...vistas].sort((a, b) => a - b);
  cena.conhecida = true;

  desenharCena();
  if (elAjustes.open) desenharCenas();

  // A primeira mensagem depois de abrir o app so conta onde a mesa esta; nao
  // e troca. Dar nome tambem chega aqui, com o mesmo numero: nao avisa.
  // Cena desconhecida de novo: o aviso da troca anterior ja nao vale.
  if (numero === null) limparAviso();
  else if (jaConhecida && numero !== antes) avisarTrocaDeCena();
}

function receberRelida(msg) {
  // Releitura de uma cena que ja saiu da mesa (troca rapida): a da cena nova
  // vem logo em seguida.
  const numero = numeroDeCena(msg.numero);
  if (cena.atual && numero !== null && numero !== cena.atual.numero) return;

  const lidos = contar(msg.lidos);
  const semResposta = contar(msg.semResposta);
  if (!lidos && !semResposta) return; // nada calibrado para reler

  let texto;
  if (!lidos) {
    texto = 'a mesa não respondeu ao reler os faders';
  } else {
    texto = 'faders atualizados pela mesa';
    if (semResposta) {
      texto += semResposta === 1 ? ' (1 não respondeu)' : ' (' + semResposta + ' não responderam)';
    }
  }
  avisarNoRodape(texto, AVISO_RELIDA_MS);
}

/** Aceita lista ou quantidade. */
function contar(valor) {
  if (Array.isArray(valor)) return valor.length;
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function desenharCena() {
  const atual = conectado ? cena.atual : null;
  elCena.hidden = !atual;
  if (!atual) {
    delete elTopo.dataset.cena;
    return;
  }

  const nome = nomeDaCena(atual.numero);
  elCenaNumero.textContent = String(atual.numero);
  elCenaNome.textContent = nome;
  elCenaNome.hidden = !nome;
  elCenaPonto.hidden = !nome;
  encaixarCena();
}

/**
 * O topo nao pode quebrar em 360px. Tenta a forma inteira; sem espaco, tira o
 * "01V96" da marca; ainda sem espaco, "Cena 3" vira "C3". O nome so corta com
 * reticencias se nem assim couber.
 */
function encaixarCena() {
  if (elCena.hidden) return;
  for (const forma of ['longa', 'compacta', 'curta']) {
    elTopo.dataset.cena = forma;
    if (!cenaTransborda()) return;
  }
}

function cenaTransborda() {
  return elCena.scrollWidth > elCena.clientWidth + 1 ||
    (!elCenaNome.hidden && elCenaNome.scrollWidth > elCenaNome.clientWidth + 1);
}

window.addEventListener('resize', encaixarCena);

function avisarTrocaDeCena() {
  // Tirar e por a classe de novo reinicia o pulso a cada troca.
  elCena.classList.remove('cena--trocou');
  void elCena.offsetWidth;
  elCena.classList.add('cena--trocou');
  avisarNoRodape('a mesa trocou para a ' + rotuloDaCena(cena.atual.numero), AVISO_TROCA_MS);
}

elCena.addEventListener('animationend', () => elCena.classList.remove('cena--trocou'));

let timerAviso = null;

function avisarNoRodape(texto, ms) {
  clearTimeout(timerAviso);
  elRodapeAviso.textContent = texto;
  elRodapeBarra.dataset.aviso = '1';
  timerAviso = setTimeout(limparAviso, ms);
}

function limparAviso() {
  clearTimeout(timerAviso);
  timerAviso = null;
  elRodapeAviso.textContent = '';
  delete elRodapeBarra.dataset.aviso;
}

/* Bloco "Cenas da mesa" nos ajustes. */
function desenharCenas() {
  const numeros = new Set(cena.vistas);
  for (const n of cena.nomes.keys()) numeros.add(n);
  if (cena.atual) numeros.add(cena.atual.numero);
  const lista = [...numeros].sort((a, b) => a - b);

  // Quem estava com o foco num item volta para o mesmo item depois de redesenhar.
  const ativo = document.activeElement;
  const focado = ativo && elListaCenas.contains(ativo) ? ativo.dataset.cena : null;

  elCenasExplica.textContent = lista.length
    ? 'A mesa só informa o número da cena. Toque numa cena para dar um nome; ele aparece em todos os celulares.'
    : 'Nenhuma cena vista ainda. Troque de cena na mesa para ela aparecer aqui. ' +
      'Se não aparecer, ligue PROGRAM CHANGE Tx no menu MIDI da mesa.';

  elListaCenas.textContent = '';
  elListaCenas.hidden = !lista.length;

  for (const numero of lista) {
    const nome = nomeDaCena(numero);
    const ehAtual = !!cena.atual && cena.atual.numero === numero;

    const item = document.createElement('li');
    item.className = 'lista__item';
    if (ehAtual) {
      item.classList.add('lista__item--atual');
      item.setAttribute('aria-current', 'true');
    }

    // Mesmo padrao do renomear de controles: o nome inteiro e o botao.
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'lista__info lista__renomear';
    botao.dataset.cena = String(numero);
    botao.setAttribute('aria-label', nome
      ? 'Renomear a cena ' + numero + ', "' + nome + '"'
      : 'Dar nome à cena ' + numero);
    botao.addEventListener('click', () => nomearCena(numero));

    const linha = document.createElement('span');
    linha.className = 'lista__linha';

    const titulo = document.createElement('span');
    titulo.className = 'lista__nome';
    titulo.textContent = nome || 'Cena ' + numero;
    if (!nome) titulo.classList.add('lista__nome--vazio');

    linha.append(titulo, iconeLapis());

    const estado = document.createElement('span');
    estado.className = 'lista__estado';
    estado.textContent = nome ? 'cena ' + numero : 'sem nome';

    botao.append(linha, estado);
    item.appendChild(botao);

    if (ehAtual) {
      const agora = document.createElement('span');
      agora.className = 'lista__agora';
      agora.textContent = 'agora';
      item.appendChild(agora);
    }

    elListaCenas.appendChild(item);
  }

  if (focado !== null) {
    const volta = elListaCenas.querySelector('[data-cena="' + focado + '"]');
    if (volta) volta.focus();
  }
}

function nomearCena(numero) {
  if (!conectado) {
    alert('Sem conexão com o bridge. Dê o nome quando reconectar.');
    return;
  }

  const atual = nomeDaCena(numero);
  let sugestao = atual;
  for (;;) {
    const digitado = prompt(atual
      ? 'Nome da cena ' + numero + '. Deixe vazio para tirar o nome.'
      : 'Nome para a cena ' + numero + ' (por exemplo, quem usa essa cena)', sugestao);
    if (digitado === null) return; // cancelou

    const nome = digitado.trim();
    if (!nome) {
      if (!atual) return;
      if (!confirm('Tirar o nome "' + atual + '" da cena ' + numero + '?')) return;
      enviar({ type: 'cena:nomear', numero, nome: '' });
      return;
    }
    if (nome.length > NOME_CENA_MAX) {
      alert('Use no máximo ' + NOME_CENA_MAX + ' letras. Cortei o que passou, confira.');
      sugestao = nome.slice(0, NOME_CENA_MAX).trim();
      continue;
    }
    if (nome === atual) return;

    // A resposta de sucesso e uma mensagem 'cena' nova, que redesenha tudo.
    enviar({ type: 'cena:nomear', numero, nome });
    return;
  }
}

/** Linha "cena:" do diagnostico, a partir de /api/status.cena. */
function descreverCenaNoDiagnostico(dado) {
  if (dado === undefined) return 'o programa não informa (versão sem cenas)';
  if (!dado || numeroDeCena(dado.numero) === null) return 'nenhuma vista ainda';

  const partes = [];
  if (dado.origem) partes.push('origem ' + (dado.origem === 'funcao' ? 'função' : dado.origem));
  const bruto = hexDoBruto(dado.bruto);
  if (bruto) partes.push('bruto ' + bruto);
  const quando = quandoNoDiagnostico(dado.em);
  if (quando) partes.push(quando);
  return dado.numero + (partes.length ? ' (' + partes.join(', ') + ')' : '');
}

/** "C0 02", venha como texto ou como lista de bytes. */
function hexDoBruto(bruto) {
  if (typeof bruto === 'string') return bruto.trim().toUpperCase();
  if (Array.isArray(bruto)) {
    return bruto.map((b) => (Number(b) & 0xff).toString(16).toUpperCase().padStart(2, '0')).join(' ');
  }
  return '';
}

/** "às 19:02", ou "em 02/10 às 19:02" quando nao foi hoje. */
function quandoNoDiagnostico(em) {
  if (em === null || em === undefined || em === '') return '';
  const data = new Date(em);
  if (Number.isNaN(data.getTime())) return 'em ' + String(em);
  const hora = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (data.toDateString() === new Date().toDateString()) return 'às ' + hora;
  return 'em ' + data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' às ' + hora;
}

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
      'cena: ' + descreverCenaNoDiagnostico(dados.cena),
      'controles: ' + dados.controles + ', sem calibrar: ' + (dados.naoCalibrados.join(', ') || 'nenhum'),
      'celulares conectados: ' + dados.clientes,
      'versão: ' + ((dados.versao && dados.versao.sha) || 'desconhecida') +
        ((dados.versao && dados.versao.instaladaEm) ? ' (instalada em ' + dados.versao.instaladaEm.slice(0, 10) + ')' : '') +
        ', atualização: ' + ((dados.versao && dados.versao.ultimoResultado) || 'sem registro'),
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
    if (msg.etapa === 'nome') {
      // O bridge recusou comecar (ex.: criando canais agora). Sem isto o
      // assistente ficaria no passo do minimo com um "Capturei" que nao faz nada.
      assistente.etapa = 'nome';
      desenharEtapa();
    } else if (assistente.etapa === 'salvando') {
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
