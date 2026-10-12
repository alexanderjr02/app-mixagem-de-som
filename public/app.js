'use strict';
/* ---------------------------------------------------------------------------
   Monitor 01V96 - app do celular

   O bridge le a mesa inteira sozinho. A pessoa escolhe qual e o fone dela
   (Aux 1 a 8) e recebe os canais com os nomes que estao na mesa. Fala
   WebSocket, reconecta sozinho quando o Wi-Fi oscila e, como plano B, ainda
   conduz a calibracao de cada controle sem terminal na maquina da mesa.
   --------------------------------------------------------------------------- */

const CHAVE_BRIDGE = 'monitor01v96.bridge';
const CHAVE_FONE = 'monitor01v96.fone';
const CHAVE_PLANO_B = 'monitor01v96.planoB';
const PASSO_TECLADO = 0.02;
const PASSO_TECLADO_GRANDE = 0.1;
const INTERVALO_ENVIO = 40;   // ms entre lotes de mensagens para o bridge
const BACKOFF_MAX = 5000;     // teto do tempo de espera entre reconexoes

const elCanais = document.getElementById('canais');
const elMestre = document.getElementById('mestre');
const elRodape = document.getElementById('rodape');
const elVazio = document.getElementById('vazio');
const elVazioTitulo = document.getElementById('vazioTitulo');
const elVazioTexto = document.getElementById('vazioTexto');
const elVazioAcao = document.getElementById('vazioAcao');
const molde = document.getElementById('moldeFader');
const elLegado = document.getElementById('legado');
const elComandoPlano = document.getElementById('comandoPlano');
const elPlanoLegenda = document.getElementById('planoLegenda');

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

/** Valor 0..1 vindo do bridge; o que nao for numero vira 0. */
function valor01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? limitar01(n) : 0;
}

/** 0..1 com 4 casas: sobra precisao para a mesa e a mensagem fica curta. */
function arredondar01(v) {
  return Math.round(limitar01(v) * 10000) / 10000;
}

function textoLimpo(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function inteiroOuZero(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/* O celular pode negar o armazenamento (aba anonima, dados bloqueados). Sem
   ele o app funciona igual; so esquece a escolha ao fechar. */
function lerSalvo(chave) {
  try {
    return localStorage.getItem(chave) || '';
  } catch {
    return '';
  }
}

function salvar(chave, valor) {
  try {
    if (valor === '' || valor === null || valor === undefined) localStorage.removeItem(chave);
    else localStorage.setItem(chave, String(valor));
  } catch { /* sem armazenamento: vale so enquanto o app estiver aberto */ }
}

/** 'ligando' (abrindo o app), 'online' ou 'offline' (caiu e tenta de novo). */
function definirConexao(estado) {
  if (document.body.dataset.conexao === estado) return;
  document.body.dataset.conexao = estado;
  desenharAvisos();
}

/**
 * Escreve um texto com os numeros dados (contagens, progresso) na fonte de
 * mostrador. Monta os nos na mao: o texto pode vir do bridge, nada de HTML.
 */
function escreverComNumeros(el, texto) {
  el.textContent = '';
  for (const pedaco of String(texto).split(/(\d+)/)) {
    if (!pedaco) continue;
    if (/^\d+$/.test(pedaco)) {
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = pedaco;
      el.appendChild(n);
    } else {
      el.appendChild(document.createTextNode(pedaco));
    }
  }
}

/** "03": numero de canal e de cena com dois digitos, como no visor. */
function doisDigitos(n) {
  return String(n).padStart(2, '0');
}

function urlDoBridge() {
  const salvo = lerSalvo(CHAVE_BRIDGE).trim();
  if (salvo) return salvo;
  const protocolo = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return protocolo + '//' + location.host;
}

/** O mesmo endereco do bridge, mas em http, para as consultas soltas. */
function urlHttpDoBridge() {
  return urlDoBridge().replace(/^ws/, 'http').replace(/\/+$/, '');
}

/**
 * Rodape de uma linha, em tom baixo. Com a mesa pronta:
 * "Mesa lida às 19:42 · 11 canais com som no seu fone".
 */
function atualizarRodape() {
  if (!conectado) {
    // O aviso "Sem conexão" ja diz o que houve; aqui fica o endereco tentado.
    elRodape.textContent = 'procurando o programa em ' + urlDoBridge();
    return;
  }

  const partes = [];
  const situacao = usandoMapa() ? estadoDaMesa() : null;
  if (situacao === 'sem-rota' || situacao === 'testando' || situacao === 'desligada' || situacao === 'esperando') {
    // Sem caminho ate a mesa, contagem de canais nao diz nada: o rodape diz onde.
    partes.push(situacao === 'testando' ? 'testando o caminho até a mesa'
      : situacao === 'desligada' ? 'sem mesa no cabo USB'
        : situacao === 'esperando' ? 'esperando a mesa'
          : 'mesa sem resposta' + (statusMidi && statusMidi.saida ? ' em ' + statusMidi.saida : ''));
  } else if (usandoMapa()) {
    if (prontaParaUsar()) {
      const quando = quandoNoDiagnostico(mapa.sincronizadaEm);
      partes.push(quando ? 'Mesa lida ' + quando : 'Mesa lida');
    }
    if (fone.estado) {
      let comSom = 0;
      for (const c of fone.estado.canais.values()) if (temSom(c)) comSom++;
      partes.push(comSom === 1 ? '1 canal com som no seu fone' : comSom + ' canais com som no seu fone');
    }
    const semResposta = canaisSemResposta();
    if (semResposta) {
      partes.push(semResposta === 1 ? '1 sem resposta da mesa' : semResposta + ' sem resposta da mesa');
    }
  } else {
    if (statusMidi) {
      partes.push(statusMidi.simulado
        ? 'sem mesa no cabo USB: nada sai daqui'
        : 'mesa: ' + statusMidi.saida + (mesa.rota ? ', canal MIDI ' + mesa.rota.canalMidi : ''));
    }
    const semCalibrar = listaControles.filter((c) => !c.calibrated).length;
    if (semCalibrar) partes.push(semCalibrar + ' sem calibrar (*)');
  }
  elRodape.textContent = partes.join(' · ');
}

/**
 * Qual tela aparece. A conexao nao troca a tela: sem ela, a tela de sempre
 * fica, apagada, com o aviso "Sem conexão" no topo.
 *  - bridge que nao le a mesa (versao antiga) ou plano B: os controles calibrados;
 *  - sem fone escolhido (ou trocando): "Qual é o seu fone?";
 *  - com fone: os canais dele.
 */
function desenharPalco() {
  const usarLegado = modo === 'legado' || (modo === 'mapa' && planoB && listaControles.length > 0);
  let tela;
  if (usarLegado) tela = listaControles.length ? 'legado' : 'sem-controles';
  else if (!fone.aux || fone.escolhendo) tela = 'escolha';
  else tela = 'fone';

  const antes = document.body.dataset.tela;
  document.body.dataset.tela = tela;

  elFone.hidden = tela !== 'fone';
  elEscolha.hidden = tela !== 'escolha';
  elLegado.hidden = tela !== 'legado';
  elVazio.hidden = tela !== 'sem-controles';
  elVazioAcao.hidden = tela !== 'sem-controles';
  if (tela === 'sem-controles') {
    elVazioTitulo.textContent = 'Nenhum controle ainda';
    elVazioTexto.textContent =
      'Cada controle é o send de um canal da mesa para o Aux do seu fone. ' +
      'Calibre o primeiro para começar.';
  }

  // O comando e o mesmo: no plano B, o titulo diz isso e da o caminho de volta.
  const plano = tela === 'legado' || tela === 'sem-controles';
  elFoneTrocar.hidden = plano;
  elComandoPlano.hidden = !plano;
  elPlanoLegenda.textContent = modo === 'legado' ? 'Monitor 01V96' : 'Plano B';
  // Sem nenhum canal confirmado pela mesa, filtrar "com som" nao faz sentido.
  elFoneFiltro.hidden = plano || !foneComCanais();
  elLegadoVoltar.hidden = !plano || modo === 'legado';

  if (tela === 'escolha') desenharEscolha();
  if (tela === 'fone') desenharTelaDoFone();
  // O nome so pode ser medido com a faixa na tela.
  if (tela === 'legado') for (const comp of faders.values()) comp.encaixar();
  desenharAvisos();
  atualizarRodape();

  // Trocou de tela pelo toque da pessoa: o foco vai junto, para o leitor de
  // tela e o teclado nao ficarem num botao que sumiu.
  if (antes !== tela && document.activeElement && document.activeElement !== document.body &&
      !document.activeElement.offsetParent && !elAjustes.open) {
    if (tela === 'fone') elFoneTrocar.focus();
    else if (tela === 'escolha') elEscolhaTitulo.focus();
  }
}

/* ------------------------------ componente ------------------------------- */

const DESLIZE_QUE_VIRA_ROLAGEM = 12; // px: ate aqui, gesto cancelado era rolar as faixas
const ECO_MS = 600;       // eco do proprio movimento que volta do bridge: ignora por este tempo
const MOTOR_MS = 260;     // deslize da tampa com valor vindo de fora (240 ms + folga)
const NOME_MAIOR = 14;    // px: nome do canal em ate 2 linhas
const NOME_MENOR = 12;    // px: se uma palavra nao couber, desce ate aqui antes de quebrar

/* Dedos em cima de algum fader agora. O aviso que mexe no layout espera
   todos soltarem: nada pode andar debaixo do dedo. */
let dedosNoFader = 0;
const aoSoltarTodos = [];

/**
 * Encaixe do nome: ate 2 linhas a 14 px. Se uma palavra nao cabe na largura,
 * desce 0,5 px por vez ate 12 e so depois quebra a palavra. Roda ao desenhar
 * e ao renomear, nunca a cada quadro. Escondido (sem largura) fica para depois.
 */
function encaixarNome(el, menor = NOME_MENOR) {
  if (!el.clientWidth) return false;
  el.style.fontSize = '';
  el.style.overflowWrap = '';
  let tamanho = parseFloat(getComputedStyle(el).fontSize) || NOME_MAIOR;
  while (el.scrollWidth > el.clientWidth + 0.5 && tamanho > menor) {
    tamanho -= 0.5;
    el.style.fontSize = tamanho + 'px';
  }
  if (el.scrollWidth > el.clientWidth + 0.5) el.style.overflowWrap = 'anywhere';
  return true;
}

/**
 * Uma faixa de fader com valor, trilho, mudo e nome. Nao sabe para onde
 * manda: quem cria passa aoMudarValor e aoMudarMudo (send do fone, ou
 * controle calibrado).
 *
 * opcoes: { tipo, rotulo, rotuloAcessivel, numero, aoMudarValor(v),
 *           aoMudarMudo(mudo), aoTocarInativo() }
 */
function criarFader(opcoes) {
  const no = molde.content.firstElementChild.cloneNode(true);
  const tipo = opcoes.tipo || 'canal';
  no.classList.add(tipo === 'master' ? 'faixa--mestre' : 'faixa--' + tipo);

  const trilho = no.querySelector('[data-trilho]');
  const saidaValor = no.querySelector('[data-valor]');
  const botaoMudo = no.querySelector('button[data-mudo]');
  const rotulo = no.querySelector('[data-rotulo]');
  const numero = no.querySelector('[data-num]');
  const etiqueta = no.querySelector('[data-etiqueta]');
  const antes = no.querySelector('[data-antes]');
  const antesValor = no.querySelector('[data-antes-valor]');
  const pe = no.querySelector('[data-pe]');

  let timerMotor = null;

  const comp = {
    no,
    valor: 0,
    mudo: false,
    ativo: true,
    arrastando: false,
    tocando: false,   // o dedo ja mudou o valor: a assinatura do toque esta na tela
    encaixado: false, // nome ja medido na largura atual
    mexidoEm: 0,      // ultima vez que a pessoa mexeu aqui (para ignorar o eco)

    /**
     * Atualiza a tela. avisar = true manda o valor novo para o bridge.
     * deslizar = true (valor vindo de fora) faz a tampa andar como um fader
     * motorizado; nunca debaixo do dedo.
     */
    aplicar(valor, avisar, deslizar) {
      const novo = limitar01(valor);
      if (deslizar && !comp.arrastando && Math.abs(novo - comp.valor) > 0.004) {
        no.classList.add('faixa--motor');
        clearTimeout(timerMotor);
        timerMotor = setTimeout(() => no.classList.remove('faixa--motor'), MOTOR_MS);
      }
      comp.valor = novo;
      const porcento = Math.round(comp.valor * 100);
      no.style.setProperty('--v', String(comp.valor));
      saidaValor.textContent = comp.ativo ? porcento : '?';
      trilho.setAttribute('aria-valuenow', String(porcento));
      trilho.setAttribute('aria-valuetext', comp.ativo ? porcento + ' de 100' : 'a mesa não confirmou');
      if (comp.tocando) {
        etiqueta.textContent = porcento;
        etiqueta.toggleAttribute('data-abaixo', comp.valor > 0.8);
      }
      if (avisar) {
        comp.mexidoEm = Date.now();
        opcoes.aoMudarValor(comp.valor);
      }
    },

    definirMudo(mudo, avisar) {
      comp.mudo = !!mudo;
      botaoMudo.setAttribute('aria-pressed', comp.mudo ? 'true' : 'false');
      no.dataset.mudo = comp.mudo ? '1' : '0';
      if (avisar) opcoes.aoMudarMudo(comp.mudo);
    },

    /**
     * Nome na tela e o que o leitor de tela fala (pode ser mais completo).
     * Canal sem nome na mesa: "CH" + numero, num tom abaixo.
     */
    renomear(texto, acessivel, extra) {
      const semNome = !!(extra && extra.semNome);
      rotulo.classList.toggle('faixa__nome--sem', semNome);
      if (semNome && extra.numero) {
        rotulo.textContent = 'CH ';
        const n = document.createElement('span');
        n.className = 'n';
        n.textContent = doisDigitos(extra.numero);
        rotulo.appendChild(n);
      } else {
        rotulo.textContent = texto;
      }
      const falado = acessivel || texto;
      trilho.setAttribute('aria-label', falado);
      botaoMudo.setAttribute('aria-label', 'Mudo: ' + falado);
      comp.encaixado = encaixarNome(rotulo);
    },

    /** Mede o nome de novo (faixa que acabou de aparecer, tela girou). */
    encaixar() {
      if (!comp.encaixado) comp.encaixado = encaixarNome(rotulo);
    },

    /** Numero do canal em cima do nome ("05"). */
    numerar(n) {
      numero.textContent = n ? doisDigitos(n) : '';
      numero.hidden = !n;
    },

    /** Texto do pe (o volume geral mostra o Aux: "AUX 3"). */
    definirPe(rotuloPe, n) {
      pe.textContent = rotuloPe ? rotuloPe + ' ' : '';
      if (n) {
        const num = document.createElement('span');
        num.className = 'n';
        num.textContent = String(n);
        pe.appendChild(num);
      }
      pe.hidden = !rotuloPe;
    },

    /** Inativo: aparece apagado, nao mexe e conta por que ao ser tocado. */
    definirAtivo(ativo, dica) {
      comp.ativo = !!ativo;
      no.classList.toggle('faixa--inativo', !comp.ativo);
      trilho.setAttribute('aria-disabled', comp.ativo ? 'false' : 'true');
      botaoMudo.setAttribute('aria-disabled', comp.ativo ? 'false' : 'true');
      if (comp.ativo) no.removeAttribute('title');
      else if (dica) no.title = dica;
      comp.aplicar(comp.valor, false);
    }
  };

  /* ---- assinatura do toque ---------------------------------------------
     Liga no primeiro movimento vertical que muda o valor (nao no toque: a
     rolagem lateral nao pisca nada). As outras faixas recuam, uma etiqueta
     com o numero segue o dedo e uma marca tracejada guarda onde o fader
     estava, para voltar ao ponto exato. Ao soltar, some na hora.          */

  function iniciarToque(valorDeAntes) {
    comp.tocando = true;
    no.classList.add('faixa--tocando');
    document.body.dataset.toque = '1';
    no.style.setProperty('--antes', String(valorDeAntes));
    antesValor.textContent = Math.round(valorDeAntes * 100);
    antes.hidden = false;
    etiqueta.hidden = false;
  }

  function terminarToque() {
    if (!comp.tocando) return;
    comp.tocando = false;
    no.classList.remove('faixa--tocando');
    etiqueta.hidden = true;
    antes.hidden = true;
    if (!document.querySelector('.faixa--tocando')) delete document.body.dataset.toque;
  }

  /* ---- arraste com dedo ou mouse ---------------------------------------
     O movimento e relativo: o fader anda o quanto o dedo andou, e nao pula
     para onde voce encostou. No escuro, encostar sem querer nao estoura o
     volume no ouvido.
     O trilho deixa o navegador rolar as faixas para o lado (touch-action:
     pan-x). Quando ele assume o gesto, chega pointercancel: se o dedo mal
     andou na vertical, era rolagem, e o fader volta para onde estava.     */

  let yInicial = 0;
  let valorInicial = 0;
  let cursoUtil = 1;

  function alturaTampa() {
    const n = parseFloat(getComputedStyle(no).getPropertyValue('--tampa-a'));
    return Number.isFinite(n) ? n : 24;
  }

  trilho.addEventListener('pointerdown', (ev) => {
    if (!comp.ativo) {
      if (opcoes.aoTocarInativo) opcoes.aoTocarInativo();
      return;
    }
    if (comp.arrastando) return;
    comp.arrastando = true;
    dedosNoFader++;
    yInicial = ev.clientY;
    valorInicial = comp.valor;
    cursoUtil = Math.max(1, trilho.clientHeight - alturaTampa());
    no.dataset.arrastando = '1';
    no.classList.remove('faixa--motor');
    try { trilho.setPointerCapture(ev.pointerId); } catch { /* ignora */ }
    ev.preventDefault();
  });

  trilho.addEventListener('pointermove', (ev) => {
    if (!comp.arrastando) return;
    const delta = (yInicial - ev.clientY) / cursoUtil; // para cima aumenta
    const novo = limitar01(valorInicial + delta);
    if (!comp.tocando && Math.round(novo * 100) !== Math.round(valorInicial * 100)) {
      iniciarToque(valorInicial);
    }
    comp.aplicar(novo, true);
    ev.preventDefault();
  });

  function soltar(ev, cancelado) {
    if (!comp.arrastando) return;
    comp.arrastando = false;
    delete no.dataset.arrastando;
    try { trilho.releasePointerCapture(ev.pointerId); } catch { /* ignora */ }
    if (cancelado && Math.abs(ev.clientY - yInicial) < DESLIZE_QUE_VIRA_ROLAGEM && comp.valor !== valorInicial) {
      comp.aplicar(valorInicial, true);
    }
    terminarToque();
    descarregarFila(); // garante que o valor final chegue sem esperar o lote
    dedosNoFader = Math.max(0, dedosNoFader - 1);
    if (!dedosNoFader) {
      for (const fazer of aoSoltarTodos.splice(0)) fazer();
    }
  }

  trilho.addEventListener('pointerup', (ev) => soltar(ev, false));
  trilho.addEventListener('pointercancel', (ev) => soltar(ev, true));

  trilho.addEventListener('keydown', (ev) => {
    if (!comp.ativo) return;
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

  botaoMudo.addEventListener('click', () => {
    if (!comp.ativo) {
      if (opcoes.aoTocarInativo) opcoes.aoTocarInativo();
      return;
    }
    comp.definirMudo(!comp.mudo, true);
  });

  comp.numerar(opcoes.numero || null);
  comp.renomear(opcoes.rotulo, opcoes.rotuloAcessivel);
  comp.aplicar(0, false);
  return comp;
}

/** Algo que mexe no layout e nao pode acontecer com um dedo num fader. */
function semDedoNoFader(fazer) {
  if (!dedosNoFader) {
    fazer();
    return;
  }
  if (!aoSoltarTodos.includes(fazer)) aoSoltarTodos.push(fazer);
}

/** O eco do que a propria pessoa acabou de mexer nao pode puxar o fader de volta. */
function ecoRecente(comp) {
  return !!comp && (comp.arrastando || Date.now() - comp.mexidoEm < ECO_MS);
}

/** Fader de um controle calibrado (plano B). */
function criarFaderDeControle(controle) {
  const comp = criarFader({
    tipo: controle.type || 'canal',
    rotulo: controle.label,
    numero: canalDaMesa(controle),
    aoMudarValor: (valor) => enviarValor(controle.id, valor),
    aoMudarMudo: (mudo) => enviar({ type: 'mute', control: controle.id, muted: mudo })
  });
  comp.controle = controle;
  if (!controle.calibrated) comp.no.classList.add('faixa--cru');
  return comp;
}

/* Girar o celular ou mudar a largura muda a largura do nome: mede de novo
   so as faixas que aparecem (uma vez, quando a tela para de mudar). */
let timerEncaixe = null;
window.addEventListener('resize', () => {
  clearTimeout(timerEncaixe);
  timerEncaixe = setTimeout(() => {
    for (const comp of [...faders.values(), ...fone.faixas.values()]) {
      comp.encaixado = false;
      if (!comp.no.hidden) comp.encaixar();
    }
    if (fone.mestre) {
      fone.mestre.encaixado = false;
      fone.mestre.encaixar();
    }
    if (!elEscolha.hidden) encaixarNomesDosFones();
  }, 150);
});

/* ------------------------------ renderizacao ----------------------------- */

function desenharControles(lista) {
  listaControles = Array.isArray(lista) ? lista : [];
  faders.clear();
  elCanais.textContent = '';
  elMestre.textContent = '';

  for (const controle of listaControles) {
    const comp = criarFaderDeControle(controle);
    faders.set(controle.id, comp);
    if (controle.type === 'master') elMestre.appendChild(comp.no);
    else elCanais.appendChild(comp.no);
  }

  // Sem nenhum master definido, o painel lateral so ocuparia espaco a toa.
  elMestre.style.display = elMestre.childElementCount ? '' : 'none';

  desenharPalco();
  desenharSituacoes(); // "Usar os controles calibrados" depende de haver algum
  if (elAjustes.open) {
    desenharListaAjustes();
    desenharGerar();
    desenharAvancado();
  }
  // A lista nova chega logo depois do learn:salvo, e e ela que diz se o canal
  // salvo ficou no formato do manual.
  if (assistente.ativo && assistente.etapa === 'fim') desenharOfertaPuxar();
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
 * a ultima mensagem de cada fader (pela chave) e despachamos em lote. O ouvido
 * nao percebe a diferenca e a rede e o bridge ficam tranquilos.
 */
function enfileirar(chave, mensagem) {
  fila.set(chave, mensagem);
  if (timerFila) return;
  timerFila = setTimeout(descarregarFila, INTERVALO_ENVIO);
}

/** Controle calibrado (plano B). */
function enviarValor(id, valor) {
  enfileirar('set:' + id, { type: 'set', control: id, value: valor });
}

function descarregarFila() {
  if (timerFila) {
    clearTimeout(timerFila);
    timerFila = null;
  }
  for (const mensagem of fila.values()) enviar(mensagem);
  fila.clear();
}

/* Ultimo pedido feito daqui: um controle:erro que chega logo depois e a
   resposta dele, e vai para o lugar certo em vez de um alerta solto. */
let ultimoPedido = { tipo: '', em: 0 };
const ERRO_DO_PEDIDO_MS = 5000;

function marcarPedido(tipo) {
  ultimoPedido = { tipo, em: Date.now() };
}

function receberErroDeControle(mensagem) {
  // Com o teste da mesa pedido e ainda sem resposta, e o bridge dizendo
  // que nao da para testar agora (relendo a cena, sem molde, ocupado).
  if (mesa.fase === 'pedido') {
    recusarTeste(mensagem);
    return;
  }
  const recente = Date.now() - ultimoPedido.em < ERRO_DO_PEDIDO_MS;
  if (recente && ultimoPedido.tipo === 'sincronizar') {
    recusarSincronia(mensagem);
    return;
  }
  if (recente && ultimoPedido.tipo === 'atualizar') {
    recusarAtualizacao(mensagem);
    return;
  }
  // No palco, um alerta no meio da musica trava a tela: o rodape conta.
  if ((recente && ultimoPedido.tipo === 'fone') || (document.body.dataset.tela === 'fone' && !elAjustes.open)) {
    avisarNoRodape(mensagem || 'A mesa não aceitou essa mudança.', AVISO_ERRO_FONE_MS);
    return;
  }
  // Tambem chega aqui o erro de dar nome a uma cena.
  alert(mensagem || 'Não consegui mudar esse controle.');
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

  definirConexao(tentativas === 0 ? 'ligando' : 'offline');

  try {
    socket = new WebSocket(urlDoBridge());
  } catch {
    agendarReconexao();
    return;
  }

  socket.addEventListener('open', () => {
    tentativas = 0;
    conectado = true;
    conectadoEm = Date.now();
    // Passada a carencia, a rota que veio no status ja diz se a mesa responde.
    setTimeout(() => { if (conectado) desenharMapa(); }, CARENCIA_ROTA_MS + 50);
    definirConexao('online');

    // Quem pediu a atualizacao recarrega a pagina na volta: o programa novo
    // pode ter tela nova. O service worker busca a rede primeiro.
    if (atualizacao.reiniciando) {
      atualizacao.reiniciando = false;
      if (atualizacao.pedidaAqui) {
        location.reload();
        return;
      }
      atualizacao.fase = 'voltou';
      desenharAtualizacao();
    }

    // Bridge que le a mesa manda mesa:resumo logo ao conectar. Sem ele ate
    // aqui, e a versao que so conhece os controles calibrados.
    if (!mapa.conhecido) {
      clearTimeout(timerModo);
      timerModo = setTimeout(() => {
        if (mapa.conhecido || !conectado) return;
        modo = 'legado';
        desenharMapa();
        desenharAtualizacao();
      }, ESPERA_MODO);
    }
    // Depois de reconectar, o bridge precisa saber de novo qual e o fone.
    if (fone.aux) pedirFone();

    desenharPalco();
    desenharLeitura();
    desenharAtualizacao();
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
        // Bridge sem o teste da mesa nao manda 'rota': fica como estava.
        if ('rota' in msg) mesa.rota = rotaDoBridge(msg.rota);
        atualizarRodape();
        desenharAvisos(); // mesa fora do cabo USB vira aviso no topo
        desenharSituacoes();
        desenharEstadoDaMesa();
        desenharTesteDaMesa();
        desenharGerar();
        break;
      case 'mesa:teste':
        receberTesteDaMesa(msg);
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
        receberErroDeControle(textoLimpo(msg.message));
        break;
      case 'mesa:resumo':
        receberResumo(msg);
        break;
      case 'mesa:sincronia':
        receberSincronia(msg);
        break;
      case 'fone:estado':
        receberEstadoDoFone(msg);
        break;
      case 'fone:mudou':
        receberMudancaNoFone(msg);
        break;
      case 'atualizar:estado':
        receberAtualizacao(msg);
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
    definirConexao('offline');
    // Sem bridge a cena pode mudar sem a gente saber: o rotulo some ate o
    // bridge contar de novo, logo que reconectar.
    limparAviso();
    desenharCena();
    // O resultado de um teste que estava rodando chega para quem esta
    // conectado; daqui nao da para saber. Na volta, o status conta a rota.
    if (testeEmAndamento()) {
      clearTimeout(mesa.vigia);
      mesa.fase = null;
    }
    // Pedido de leitura sem resposta: a queda responde por ele.
    if (sincronizar.pedido) {
      clearTimeout(sincronizar.vigia);
      sincronizar.pedido = false;
    }
    // Atualizacao no meio (fora da troca): daqui nao da para saber como
    // terminou. Se seguir, o bridge conta de novo.
    if (FASES_ATUALIZANDO.has(atualizacao.fase) && !atualizacao.reiniciando) {
      clearTimeout(atualizacao.vigia);
      atualizacao.fase = null;
    }
    clearTimeout(fone.esperaTimer);
    desenharTesteDaMesa();
    desenharPalco();
    desenharLeitura();
    desenharAtualizacao();
    if (gerar.ativo) {
      // Mesma ideia do assistente: a folha fica aberta para a pessoa ler o
      // aviso, em vez de sumir e deixar a duvida se criou ou nao. Fica segura
      // ate a propria pessoa fechar, mesmo que o Wi-Fi volte e caia de novo.
      gerar.segurarFolha = true;
      terminarGerar('', 'A conexão com o bridge caiu no meio da conferência. ' +
        'O que a mesa já confirmou fica salvo; confira a lista quando reconectar.');
    } else if (caiuAgora && elAjustes.open && !gerar.segurarFolha && !atualizacao.reiniciando) {
      // Na troca de versao a queda e esperada: a folha fica, contando que volta.
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
const DICA_DURACAO_TESTE = 'O teste pode levar até uns 20 segundos; depois a conferência começa sozinha.';

const elBlocoGerar = document.getElementById('blocoGerar');
const elBtnPuxarTodos = document.getElementById('btnPuxarTodos');
const elGerarOuEscolha = document.getElementById('gerarOuEscolha');
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
  base: null,           // id do molde da conferencia em andamento
  enviados: [],         // o que foi pedido na ultima conferencia
  feitos: 0,
  total: 0,
  resumo: '',
  erro: '',
  vigia: null,
  aguardandoTeste: false, // pedido feito durante o teste da mesa: sai quando ele acabar
  paradoPeloTeste: false, // encerrada porque o teste da mesa falhou
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

/** Canais 1..32 que ainda nao estao no monitor, em ordem. */
function canaisLivres() {
  const existentes = canaisQueJaExistem();
  const livres = [];
  for (let n = 1; n <= TOTAL_CANAIS; n++) if (!existentes.has(n)) livres.push(n);
  return livres;
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
  const livres = TOTAL_CANAIS - existentes.size;

  elGerarExplica.textContent = livres === 0 && !gerar.ativo
    ? 'Os ' + TOTAL_CANAIS + ' canais da mesa já estão no seu monitor.'
    : 'Usa "' + base.label + '" (canal ' + base.canal + '), que já está calibrado, como molde. ' +
      'Antes de criar, confere cada canal com a mesa. Nada muda no som enquanto confere.';

  // Sem canal livre nao ha o que puxar nem o que escolher.
  elBtnPuxarTodos.hidden = livres === 0 && !gerar.ativo;
  elGerarOuEscolha.hidden = livres === 0;

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
    // Enquanto o bridge testa o caminho (pedido na espera, ou a conferencia
    // que disparou o teste), nenhum canal foi conferido ainda.
    const testando = gerar.aguardandoTeste || (testeEmAndamento() && gerar.feitos === 0);
    const texto = testando
      ? 'testando o caminho até a mesa antes de conferir'
      : 'conferindo com a mesa: ' + gerar.feitos + ' de ' + gerar.total;
    // O detalhe do teste sai sozinho: o primeiro progresso troca pelo canal.
    if (testando) elGerarUltimo.textContent = DICA_DURACAO_TESTE;
    else if (elGerarUltimo.textContent === DICA_DURACAO_TESTE) elGerarUltimo.textContent = '';
    // So reescreve quando muda: o leitor de tela anuncia cada troca.
    if (elGerarProgressoTexto.textContent !== texto) escreverComNumeros(elGerarProgressoTexto, texto);
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
  // O texto fica: o medidor logo abaixo ja conta o andamento.
  elBtnPuxarTodos.disabled = gerar.ativo || !!motivo || livres === 0;
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

elBtnGerar.addEventListener('click', () => iniciarGerar());

elBtnPuxarTodos.addEventListener('click', () => {
  if (gerar.ativo) return;
  marcarTodosLivres();
  iniciarGerar();
});

function marcarTodosLivres() {
  gerar.marcados = new Set(canaisLivres());
}

/**
 * Comeca a conferencia dos canais marcados. Devolve false quando nao da
 * (sem molde, sem mesa, nada marcado); o motivo ja esta na tela.
 */
function iniciarGerar() {
  const base = controleBase();
  if (!base || gerar.ativo || !gerar.marcados.size || motivoMesaIndisponivel()) return false;

  const canais = [...gerar.marcados].sort((a, b) => a - b);
  gerar.ativo = true;
  gerar.base = base.id;
  gerar.enviados = canais;
  gerar.feitos = 0;
  gerar.total = canais.length;
  gerar.resumo = '';
  gerar.erro = '';
  gerar.paradoPeloTeste = false;
  elGerarUltimo.textContent = '';

  // Durante o teste da mesa o bridge recusaria o pedido. Em vez de mostrar
  // erro, espera o teste acabar e manda sozinho (ver receberTesteDaMesa).
  gerar.aguardandoTeste = testeEmAndamento();
  if (gerar.aguardandoTeste) vigiarGerar(ESPERA_MAX_TESTE);
  else mandarGerar();

  desenharGerar();
  // Quem tocou no botao de baixo tambem precisa ver o andamento, que fica no alto.
  elGerarProgresso.scrollIntoView({ block: 'nearest' });
  return true;
}

function mandarGerar() {
  gerar.aguardandoTeste = false;
  vigiarGerar();
  enviar({ type: 'gerar:canais', base: gerar.base, canais: gerar.enviados });
}

/** Se o bridge parar de dar noticia, destrava em vez de deixar a tela presa. */
function vigiarGerar(ms = ESPERA_MAX_GERAR) {
  clearTimeout(gerar.vigia);
  gerar.vigia = setTimeout(() => {
    if (!gerar.ativo) return;
    terminarGerar('', 'O bridge parou de dar notícia da conferência. ' +
      'O que a mesa já confirmou fica salvo; confira a lista acima e marque de novo o que faltou.');
  }, ms);
}

function terminarGerar(resumo, erro) {
  clearTimeout(gerar.vigia);
  gerar.vigia = null;
  gerar.ativo = false;
  gerar.aguardandoTeste = false;
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
    // Depois de o teste da mesa falhar, o bridge ainda recusa o pedido que
    // estava esperando; o aviso que aponta o bloco Mesa ajuda mais e fica.
    if (!gerar.ativo && gerar.paradoPeloTeste) return;
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

/* ---- teste do caminho ate a mesa ---------------------------------------
   A mesa so obedece no canal MIDI em que RECEBE (Rx), que pode nao ser o
   mesmo em que ela manda. O bridge acha a porta e o canal so com pedidos de
   leitura. O teste pode partir daqui, de outro celular ou do proprio bridge
   (depois da 1a calibracao, quando a mesa conecta): 'mesa:teste' chega para
   todos, e o estado fica no bloco Mesa e no rodape, sem modal.            */

const ESPERA_RESPOSTA_TESTE = 10000; // o bridge nem comecou o teste pedido
const ESPERA_MAX_TESTE = 90000;      // testando sem noticia por tanto tempo = travou
const AVISO_TESTE_OK_MS = 6000;
const AVISO_TESTE_FALHOU_MS = 12000;

const elMesaRota = document.getElementById('mesaRota');
const elMesaFalhou = document.getElementById('mesaFalhou');
const elMesaMotivo = document.getElementById('mesaMotivo');
const elMesaConferirTitulo = document.getElementById('mesaConferirTitulo');
const elMesaConferir = document.getElementById('mesaConferir');
const elMesaTestando = document.getElementById('mesaTestando');
const elMesaTestados = document.getElementById('mesaTestados');
const elMesaRecusa = document.getElementById('mesaRecusa');
const elBtnTestarMesa = document.getElementById('btnTestarMesa');

const mesa = {
  rota: null,    // { saida, canalMidi, em, reconfirmada } que o bridge usa
  fase: null,    // null | 'pedido' | 'testando' | 'ok' | 'falhou' | 'parou'
  faseAntes: null, // resultado que valia antes do pedido (volta se o bridge recusar)
  testados: 0,
  motivo: '',
  conferir: [],  // textos prontos do bridge
  recusa: '',    // o bridge nao pode testar agora: o motivo dele
  vigia: null
};

function rotaValida(rota) {
  return !!rota && typeof rota === 'object' && typeof rota.saida === 'string' &&
    Number.isInteger(rota.canalMidi) && rota.canalMidi >= 1 && rota.canalMidi <= 16;
}

/**
 * Rota que o bridge conferiu, ou a anterior que ele manteve depois de um
 * teste sem resposta (reconfirmada false). Sem o campo, conta como conferida.
 */
function rotaDoBridge(rota, reconfirmadaFora) {
  if (!rotaValida(rota)) return null;
  const marca = typeof rota.reconfirmada === 'boolean' ? rota.reconfirmada
    : typeof reconfirmadaFora === 'boolean' ? reconfirmadaFora : true;
  return { ...rota, reconfirmada: marca };
}

function rotaMantida() {
  return !!mesa.rota && mesa.rota.reconfirmada === false;
}

function testeEmAndamento() {
  return mesa.fase === 'pedido' || mesa.fase === 'testando';
}

elBtnTestarMesa.addEventListener('click', () => {
  if (!conectado || testeEmAndamento()) return;
  mesa.faseAntes = mesa.fase;
  mesa.fase = 'pedido';
  mesa.testados = 0;
  mesa.recusa = '';
  vigiarTeste(ESPERA_RESPOSTA_TESTE);
  enviar({ type: 'mesa:testar' });
  desenharTesteDaMesa();
});

/**
 * O bridge respondeu ao pedido com controle:erro: nao comecou teste nenhum.
 * Volta ao que valia antes, sem esperar a vigia e sem o aviso de programa
 * desatualizado; quem esperava o teste para puxar os canais para aqui.
 */
function recusarTeste(texto) {
  clearTimeout(mesa.vigia);
  mesa.vigia = null;
  mesa.fase = mesa.faseAntes;
  mesa.recusa = (typeof texto === 'string' && texto.trim()) ||
    'O programa não pôde testar a mesa agora. Tente de novo daqui a pouco.';
  desenharTesteDaMesa();
  if (gerar.ativo && gerar.aguardandoTeste) {
    // As marcas ficam: tentar de novo e um toque.
    terminarGerar('', mesa.recusa);
  }
}

function vigiarTeste(ms) {
  clearTimeout(mesa.vigia);
  mesa.vigia = setTimeout(() => {
    if (!testeEmAndamento()) return;
    mesa.motivo = mesa.fase === 'pedido'
      ? 'O programa da mesa não respondeu ao pedido de teste. Ele pode estar desatualizado: ' +
        'copie o diagnóstico abaixo e peça ajuda.'
      : 'O teste parou de dar notícia. Toque em Testar a mesa para tentar de novo.';
    mesa.fase = 'parou';
    mesa.conferir = [];
    desenharTesteDaMesa();
    if (gerar.ativo && gerar.aguardandoTeste) {
      terminarGerar('', 'O teste da mesa não terminou, então nenhum canal foi conferido. Tente de novo.');
    }
  }, ms);
}

/** Mensagem 'mesa:teste' do bridge (para todos os celulares). */
function receberTesteDaMesa(msg) {
  const fase = msg.fase;
  if (fase !== 'testando' && fase !== 'ok' && fase !== 'falhou') return;
  const jaTestava = testeEmAndamento();

  mesa.fase = fase;
  mesa.recusa = '';
  mesa.testados = Number.isFinite(Number(msg.testados)) ? Math.max(0, Math.floor(Number(msg.testados))) : 0;
  mesa.motivo = typeof msg.motivo === 'string' ? msg.motivo.trim() : '';
  mesa.conferir = Array.isArray(msg.conferir)
    ? msg.conferir.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    : [];
  if (fase === 'ok') {
    const nova = rotaDoBridge(msg.rota, msg.reconfirmada);
    if (nova) mesa.rota = { ...nova, em: nova.em || new Date().toISOString() };
  } else if (fase === 'falhou') {
    // A falha mantem a rota anterior (reconfirmada false), se havia uma.
    const mantida = rotaDoBridge(msg.rota, msg.reconfirmada === undefined ? false : msg.reconfirmada);
    const mesmaDeAntes = mantida && mesa.rota && mesa.rota.saida === mantida.saida &&
      mesa.rota.canalMidi === mantida.canalMidi;
    mesa.rota = mantida ? { ...mantida, em: mantida.em || (mesmaDeAntes ? mesa.rota.em : null) } : null;
  }

  clearTimeout(mesa.vigia);
  if (fase === 'testando') vigiarTeste(ESPERA_MAX_TESTE);

  desenharTesteDaMesa();
  desenharMapa(); // mesa sem resposta vira aviso no topo e trava os faders
  atualizarRodape();

  // No palco a folha de ajustes costuma estar fechada: o rodape conta.
  if (fase === 'testando') {
    if (!jaTestava) avisarNoRodape('testando o caminho até a mesa', ESPERA_MAX_TESTE);
  } else if (fase === 'ok') {
    avisarNoRodape('caminho até a mesa conferido' +
      (mesa.rota ? ': canal MIDI ' + mesa.rota.canalMidi : ''), AVISO_TESTE_OK_MS);
  } else if (rotaMantida()) {
    // Sem alarme: o caminho de antes continua em uso.
    avisarNoRodape('teste da mesa sem resposta; segue no canal MIDI ' + mesa.rota.canalMidi, AVISO_TESTE_FALHOU_MS);
  } else {
    avisarNoRodape('a mesa não respondeu ao teste: veja Ajustes, bloco Mesa', AVISO_TESTE_FALHOU_MS);
  }

  if (!gerar.ativo) return;
  if (fase === 'testando') {
    vigiarGerar(ESPERA_MAX_TESTE);
  } else if (fase === 'ok') {
    if (gerar.aguardandoTeste) mandarGerar();
    else vigiarGerar();
  } else {
    // Os marcados continuam marcados: tentar de novo e um toque. Sem resposta
    // no teste, a conferencia tambem ficaria sem resposta: nao vale tentar.
    terminarGerar('', (rotaMantida()
      ? 'A mesa não respondeu ao teste, então nenhum canal foi conferido. '
      : 'O teste não achou o caminho até a mesa, então nenhum canal foi conferido. ') +
      'Veja o que conferir no bloco Mesa, no alto desta tela, e tente de novo.');
    gerar.paradoPeloTeste = true;
  }
  desenharGerar();
}

/* O teste nao tem progresso (sao uns 20 s): um contador honesto,
   "testando · 7 s", em vez de bolinha. */
const elMesaTestandoTexto = document.getElementById('mesaTestandoTexto');
let timerSegundosTeste = null;
let testeComecouEm = 0;

function contarSegundosDoTeste(testando) {
  if (!testando) {
    clearInterval(timerSegundosTeste);
    timerSegundosTeste = null;
    testeComecouEm = 0;
    return;
  }
  if (!testeComecouEm) testeComecouEm = Date.now();
  const escrever = () => escreverComNumeros(elMesaTestandoTexto,
    'testando · ' + Math.floor((Date.now() - testeComecouEm) / 1000) + ' s');
  escrever();
  if (!timerSegundosTeste) timerSegundosTeste = setInterval(escrever, 1000);
}

function desenharTesteDaMesa() {
  const testando = testeEmAndamento();
  // Quem conectou depois da falha nao recebeu o mesa:teste: a rota que veio no
  // status (nula ou nao reconfirmada) ja diz que a mesa nao responde.
  const inferido = !testando && mesa.fase === null && estadoDaMesa() === 'sem-rota';
  const falhou = mesa.fase === 'falhou' || mesa.fase === 'parou' || inferido;
  const conferir = mesa.conferir.length ? mesa.conferir : (falhou ? CONFERIR_NA_MESA : []);

  elMesaTestando.hidden = !testando;
  contarSegundosDoTeste(testando);
  if (testando) {
    elMesaTestados.textContent = (mesa.testados
      ? mesa.testados + (mesa.testados === 1 ? ' caminho testado. ' : ' caminhos testados. ')
      : 'Pode levar até uns 20 segundos. ') + 'Só pedidos de leitura: nada muda no som.';
  }

  desenharRotaDaMesa(testando, falhou);

  elMesaRecusa.textContent = mesa.recusa;
  elMesaRecusa.hidden = !mesa.recusa || testando;

  elMesaFalhou.hidden = !falhou || testando;
  if (falhou) {
    // Com o caminho anterior mantido, a lista e o que olhar se o som nao
    // mudar; sem caminho nenhum, e o que conferir para a mesa responder.
    elMesaConferirTitulo.textContent = rotaMantida()
      ? 'Se o celular não mexer no som, confira na mesa:'
      : 'Confira na mesa:';
    elMesaMotivo.textContent = mesa.motivo ||
      (inferido
        ? 'A mesa não respondeu ao último teste do caminho até ela.'
        : mesa.testados
          ? 'A mesa não respondeu em nenhum dos ' + mesa.testados + ' caminhos testados.'
          : 'A mesa não respondeu ao teste.');
    elMesaConferir.textContent = '';
    for (const texto of conferir) {
      const item = document.createElement('li');
      item.appendChild(destacarMenus(texto));
      elMesaConferir.appendChild(item);
    }
    elMesaConferirTitulo.hidden = !conferir.length;
    elMesaConferir.hidden = !conferir.length;
  }

  elBtnTestarMesa.disabled = testando || !conectado;
  elBtnTestarMesa.textContent = testando ? 'Testando a mesa' : 'Testar a mesa';
}

/**
 * Linha do caminho ate a mesa:
 *  - conferido agora: em destaque, com a hora;
 *  - anterior mantido (o ultimo teste nao reconfirmou): calmo, diz que segue;
 *  - testando de novo: o caminho velho apagado, para nao parecer atual;
 *  - nenhum: "ainda nao conferido" (some se o teste falhou: a falha e o resultado).
 */
function desenharRotaDaMesa(testando, falhou) {
  const rota = mesa.rota;
  elMesaRota.hidden = !rota && (testando || falhou);
  if (!rota) {
    elMesaRota.className = 'bloco__texto';
    elMesaRota.textContent = 'Caminho até a mesa ainda não conferido.';
    return;
  }

  // Espacos que nao quebram: "canal MIDI 2 · às 19:02" desce inteiro.
  const fixo = (texto) => texto.replace(/ /g, '\u00a0');
  const quando = quandoNoDiagnostico(rota.em);
  const caminho = rota.saida + ', ' + fixo('canal MIDI ' + rota.canalMidi);

  if (testando) {
    elMesaRota.className = 'bloco__texto';
    elMesaRota.textContent = 'Testando de novo… Último caminho: ' + caminho +
      (quando && rota.reconfirmada !== false ? fixo(' · ' + quando) : '') + '.';
  } else if (rota.reconfirmada === false) {
    elMesaRota.className = 'bloco__texto';
    elMesaRota.textContent = 'Caminho anterior mantido: ' + caminho +
      ' · não reconfirmado agora. O programa testa de novo sozinho.';
  } else {
    elMesaRota.className = 'bloco__estado';
    elMesaRota.textContent = 'Caminho conferido: ' + caminho + (quando ? fixo(' · ' + quando) : '');
  }
}

/* Nomes de menu e de tecla da mesa, como aparecem no visor: palavras em
   maiusculas (MIDI SETUP, DIO/SETUP, PARAMETER CHANGE), Rx e Tx, e o que vier
   entre aspas. O texto vem do bridge; aqui so ganha destaque, sem HTML.    */
const PALAVRA_MENU = '(?:[A-Z][A-Z0-9]+|Rx|Tx)(?:[/-][A-Z0-9]+)*\\b';
const TRECHO_MENU = new RegExp(
  '"([^"\\n]+)"|“([^”\\n]+)”|\\b(' + PALAVRA_MENU +
  '(?:(?:\\s*[>›]\\s*|\\s+)(?:' + PALAVRA_MENU + '|\\d{1,2}\\b))*)', 'g');

// Siglas em maiusculas que nao sao nome de menu da mesa.
const NAO_E_MENU = new Set(['PC']);

function destacarMenus(texto) {
  const pedacos = document.createDocumentFragment();
  let desde = 0;
  for (const achado of texto.matchAll(TRECHO_MENU)) {
    const menu = achado[1] || achado[2] || achado[3];
    if (NAO_E_MENU.has(menu)) continue;
    const inicio = achado.index + achado[0].indexOf(menu);
    pedacos.append(texto.slice(desde, inicio));
    const forte = document.createElement('strong');
    forte.textContent = menu;
    pedacos.append(forte);
    desde = inicio + menu.length;
  }
  pedacos.append(texto.slice(desde));
  return pedacos;
}

// Fica no celular para ninguem precisar editar o config.json no PC da mesa.
const elDevolverMix = document.getElementById('devolverMix');

elDevolverMix.addEventListener('change', () => {
  enviar({ type: 'config:devolverMix', ligado: elDevolverMix.checked });
});

const elBtnAjustes = document.getElementById('btnAjustes');

/* A engrenagem do comando e as da escolha (retrato e paisagem). Sem bridge
   nao ha nada para ajustar: a lista, a mesa e a calibracao dependem dele, e
   o que ajuda e conferir o endereco do programa. */
function tocarEmAjustes() {
  if (!conectado) {
    abrirPainelConexao();
    return;
  }
  abrirAjustes();
}

elBtnAjustes.addEventListener('click', tocarEmAjustes);
document.getElementById('escolhaAjustes').addEventListener('click', tocarEmAjustes);
document.getElementById('escolhaAjustesRotulo').addEventListener('click', tocarEmAjustes);

function abrirAjustes() {
  desenharListaAjustes();
  desenharEstadoDaMesa();
  desenharTesteDaMesa();
  desenharLeitura();
  desenharAtualizacao();
  desenharGerar();
  desenharCenas();
  desenharAvancado();
  enviar({ type: 'midi:portas' });
  if (!elAjustes.open) elAjustes.showModal();
}

/** A partir da tela do fone: abre os ajustes ja no Testar a mesa. */
function abrirAjustesNaMesa() {
  if (!conectado) return;
  abrirAjustes();
  document.getElementById('blocoMesa').scrollIntoView({ block: 'start' });
  if (!elBtnTestarMesa.disabled) elBtnTestarMesa.focus({ preventScroll: true });
}

/**
 * "Puxar todos" vindo de fora da folha (fim do assistente): abre os ajustes
 * no bloco de criar canais e ja comeca. Sem mesa, so marca e mostra o motivo.
 */
function puxarTodosDeFora() {
  if (!conectado) return;
  abrirAjustes();
  elAvancado.open = true; // o bloco de criar canais mora no Avançado
  if (gerar.ativo) {
    elBlocoGerar.scrollIntoView({ block: 'start' });
    return;
  }
  marcarTodosLivres();
  desenharGerar();
  elBlocoGerar.scrollIntoView({ block: 'start' });
  iniciarGerar();
}

/* ---- cena da mesa ------------------------------------------------------
   Cada tecnico tem a sua cena, e a cena tambem muda os fones. A mesa so conta
   o numero (0 a 99); o nome e dado aqui e vale para todos os celulares.    */

const NOME_CENA_MAX = 30;
const AVISO_TROCA_MS = 4000;
const CENA_INVERTIDA_MS = 600; // a linha da cena fica invertida e volta em 400 ms (CSS)
const CENA_INVERTIDA_CALMA_MS = 1000; // com menos movimento: 1 s invertida, sem fade
const AVISO_RELIDA_MS = 5000;

const elCena = document.getElementById('cena');
const elCenaNumero = document.getElementById('cenaNumero');
const elCenaPonto = document.getElementById('cenaPonto');
const elCenaNome = document.getElementById('cenaNome');
const elRodapeBarra = elRodape.parentElement;
const elRodapeAviso = document.getElementById('rodapeAviso');
const elPassageiro = document.getElementById('passageiro');
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

/** "Cena 03 · Pedro" ou "Cena 03", como no visor da mesa. */
function rotuloDaCena(numero) {
  const nome = nomeDaCena(numero);
  return 'Cena ' + doisDigitos(numero) + (nome ? ' · ' + nome : '');
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

/** Linha da cena no comando. Sem conexao a cena e desconhecida: some. */
function desenharCena() {
  const atual = conectado ? cena.atual : null;
  elCena.hidden = !atual;
  if (!atual) return;

  const nome = nomeDaCena(atual.numero);
  elCenaNumero.textContent = doisDigitos(atual.numero);
  elCenaNome.textContent = nome;
  elCenaNome.hidden = !nome;
  elCenaPonto.hidden = !nome;
}

let timerCena = null;

/* Troca de cena: a linha vira uma etiqueta invertida por 600 ms e volta em
   400 ms, uma vez so. Nada pisca depois disso. */
function avisarTrocaDeCena() {
  const calmo = matchMedia('(prefers-reduced-motion: reduce)').matches;
  clearTimeout(timerCena);
  elCena.classList.add('cena--invertida');
  timerCena = setTimeout(() => elCena.classList.remove('cena--invertida'),
    calmo ? CENA_INVERTIDA_CALMA_MS : CENA_INVERTIDA_MS);
  avisarNoRodape(rotuloDaCena(cena.atual.numero) + ' carregada na mesa', AVISO_TROCA_MS);
}

let timerAviso = null;

/* Aviso passageiro: no rodape em retrato; no trilho, abaixo da cena, quando o
   rodape nao aparece (paisagem e retrato baixo). */
function avisarNoRodape(texto, ms) {
  clearTimeout(timerAviso);
  elRodapeAviso.textContent = texto;
  elRodapeBarra.dataset.aviso = '1';
  elPassageiro.textContent = texto;
  elPassageiro.hidden = false;
  timerAviso = setTimeout(limparAviso, ms);
}

function limparAviso() {
  clearTimeout(timerAviso);
  timerAviso = null;
  elRodapeAviso.textContent = '';
  delete elRodapeBarra.dataset.aviso;
  elPassageiro.textContent = '';
  elPassageiro.hidden = true;
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

const SEM_INFORMACAO = ['o programa não informa (versão antiga do bridge)'];

/** Linha "rota:", a partir de /api/status.rota. */
function descreverRotaNoDiagnostico(rota) {
  if (rota === undefined) return SEM_INFORMACAO[0];
  if (!rota) return 'não conferida';
  const quando = quandoNoDiagnostico(rota.em);
  return rota.saida + ', canal MIDI ' + rota.canalMidi + (quando ? ' (conferida ' + quando + ')' : '') +
    (rota.reconfirmada === false ? ', mantida: o último teste não reconfirmou' : '');
}

/**
 * "19:02:11.284 saiu para Yamaha 01V96-1: F0 43 30 3E ... F7", uma por linha.
 * Contrato: { em, dir, porta, hex }. Aceita tambem { hora, direcao, vezes },
 * o formato que o bridge usava enquanto o contrato era fechado.
 */
function linhasMidiNoDiagnostico(lista) {
  if (lista === undefined) return SEM_INFORMACAO;
  if (!Array.isArray(lista) || !lista.length) return ['nenhuma'];
  return lista.map((m) => {
    const dir = m.dir || m.direcao;
    const sentido = dir === 'entrada' ? 'chegou de ' : dir === 'saida' ? 'saiu para ' : (dir || '?') + ' ';
    const hora = m.em !== undefined ? horaComSegundos(m.em) : String(m.hora || '?');
    const vezes = Number(m.vezes) > 1 ? ' (' + m.vezes + ' vezes)' : '';
    return hora + ' ' + sentido + (m.porta || '?') + ': ' + formatarHex(m.hex) + vezes;
  });
}

/**
 * "Bumbo (bumbo): F0 43 10 ... F7 | valor no byte 9, 3 byte(s) | faixa 0 a 1023"
 * Contrato: o hex vem em `hex`; aceita tambem `template`.
 */
function linhasControlesNoDiagnostico(lista) {
  if (lista === undefined) return SEM_INFORMACAO;
  if (!Array.isArray(lista) || !lista.length) return ['nenhum'];
  return lista.map((c) =>
    (c.rotulo || '?') + ' (' + c.id + '): ' + (formatarHex(c.hex !== undefined ? c.hex : c.template) || 'sem template') +
    ' | valor no byte ' + c.offset + ', ' + c.length + ' byte(s)' +
    ' | faixa ' + c.rawMin + ' a ' + c.rawMax);
}

/**
 * Linhas da leitura da mesa, a partir de /api/status.mapa:
 *   mapa: pronta, resolução alta (crua 1023)
 *   mapa lidos: 1100 de 1100, sem resposta: 2 (...)
 *   mapa sincronizada: às 19:02
 *   nomes dos Aux: 1 Bateria | 2 Baixo | 3 (sem nome) | ...
 * Os nomes vem do mapa quando ele traz; senao, do ultimo mesa:resumo.
 */
function linhasMapaNoDiagnostico(dado) {
  const linhas = [];
  if (dado === undefined || dado === null || typeof dado !== 'object') {
    linhas.push('mapa: ' + (dado === undefined ? 'o programa não informa (versão sem leitura da mesa)' : 'nenhum'));
  } else {
    const crua = dado.resolucaoCrua === undefined || dado.resolucaoCrua === null ? ''
      : ' (crua ' + (typeof dado.resolucaoCrua === 'object' ? JSON.stringify(dado.resolucaoCrua) : String(dado.resolucaoCrua)) + ')';
    linhas.push('mapa: ' + (dado.pronta ? 'pronta' : 'não pronta') +
      ', resolução ' + (dado.resolucao || 'desconhecida') + crua);
    linhas.push('mapa lidos: ' + descreverContagem(dado.lidos) + ' de ' + descreverContagem(dado.total) +
      ', sem resposta: ' + descreverSemResposta(dado.semResposta));
    const quando = quandoNoDiagnostico(dado.sincronizadaEm);
    linhas.push('mapa sincronizada: ' + (quando || 'ainda não'));
  }

  const doMapa = dado && Array.isArray(dado.auxes) ? dado.auxes : null;
  const auxes = doMapa || (mapa.conhecido ? mapa.auxes : []);
  linhas.push('nomes dos Aux: ' + (auxes.length
    ? auxes.map((a) => (a && a.aux) + ' ' + (textoLimpo(a && a.nome) || '(sem nome)')).join(' | ')
    : 'nenhum recebido'));
  return linhas;
}

function descreverContagem(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? String(n) : '?';
}

/** Quantidade, ou a lista (as 8 primeiras). */
function descreverSemResposta(valor) {
  if (Array.isArray(valor)) {
    if (!valor.length) return '0';
    const itens = valor.slice(0, 8).map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    return valor.length + ' (' + itens.join(', ') + (valor.length > 8 ? ', ...' : '') + ')';
  }
  return descreverContagem(valor);
}

/** "F0 43 30 ..." venha com ou sem espacos. Fora disso, devolve como veio. */
function formatarHex(hex) {
  if (typeof hex !== 'string') return hexDoBruto(hex);
  const texto = hex.trim();
  if (/^[0-9a-f]+$/i.test(texto) && texto.length % 2 === 0) {
    return texto.match(/../g).join(' ').toUpperCase();
  }
  return texto.toUpperCase();
}

/** "19:02:11.284", com a data na frente quando nao foi hoje. */
function horaComSegundos(em) {
  const data = new Date(em);
  if (em === null || em === undefined || Number.isNaN(data.getTime())) return String(em);
  const hora = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
    '.' + String(data.getMilliseconds()).padStart(3, '0');
  if (data.toDateString() === new Date().toDateString()) return hora;
  return data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hora;
}

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
      'rota: ' + descreverRotaNoDiagnostico(dados.rota),
      'portas MIDI vistas: ' + ((dados.midi.portasVistas || []).join(' | ') || 'nenhuma'),
      'cena: ' + descreverCenaNoDiagnostico(dados.cena),
      ...linhasMapaNoDiagnostico(dados.mapa),
      'fone deste celular: ' + (fone.aux ? rotuloDoAux(fone.aux) : 'nenhum escolhido') +
        (planoB ? ' (usando os controles calibrados)' : ''),
      'controles: ' + dados.controles + ', sem calibrar: ' + (dados.naoCalibrados.join(', ') || 'nenhum'),
      'celulares conectados: ' + dados.clientes,
      'versão: ' + ((dados.versao && dados.versao.sha) || 'desconhecida') +
        ((dados.versao && dados.versao.instaladaEm) ? ' (instalada em ' + dados.versao.instaladaEm.slice(0, 10) + ')' : '') +
        ', atualização: ' + ((dados.versao && dados.versao.ultimoResultado) || 'sem registro'),
      'celular: ' + navigator.userAgent,
      '',
      'últimas mensagens MIDI:',
      ...linhasMidiNoDiagnostico(dados.ultimosMidi),
      '',
      'controles em hex:',
      ...linhasControlesNoDiagnostico(dados.controlesHex),
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
  tipo: 'canal',
  idSalvo: null    // id do controle que acabou de ser salvo (etapa fim)
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
const elAssPuxar = document.getElementById('assPuxar');
const elAssPuxarTexto = document.getElementById('assPuxarTexto');
const elAssPuxarBotao = document.getElementById('assPuxarBotao');

function abrirAssistente(controle) {
  if (!conectado) {
    alert('Sem conexão com o bridge. A calibração precisa falar com a mesa.');
    return;
  }

  assistente.ativo = true;
  assistente.controle = controle;
  assistente.etapa = 'nome';
  assistente.tipo = controle ? controle.type : 'canal';
  assistente.idSalvo = null;
  elAssPuxar.hidden = true;

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

/**
 * Fim da calibracao de um canal no formato do manual: ele serve de molde, e
 * da para puxar os outros dali mesmo. Oferta, nao obrigacao: Concluir basta.
 */
function desenharOfertaPuxar() {
  const salvo = assistente.etapa === 'fim' && assistente.idSalvo
    ? listaControles.find((c) => c.id === assistente.idSalvo)
    : null;
  const canal = salvo ? canalDaMesa(salvo) : null;
  const livres = canal ? canaisLivres().length : 0;

  elAssPuxar.hidden = !canal || !livres;
  if (elAssPuxar.hidden) return;

  elAssPuxarTexto.textContent =
    'O canal ' + canal + ' ficou no formato do manual da mesa e serve de molde para ' +
    (livres === 1 ? 'o outro canal que falta' : 'os outros ' + livres + ' canais') + '. ' +
    'O programa confere cada um com a mesa antes de criar. Se preferir, conclua e faça isso depois nos ajustes.';
}

elAssPuxarBotao.addEventListener('click', () => {
  fecharAssistente(false);
  puxarTodosDeFora();
});

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
    assistente.idSalvo = msg.control.id;

    if (msg.avisos && msg.avisos.length) {
      mostrarErroAssistente(msg.avisos.join(' '));
    }
    desenharEtapa();
    desenharOfertaPuxar();
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

/* ---------------------------- o fone da pessoa ---------------------------
   O bridge le a mesa sozinho (nomes, sends e on de todos os Aux) e manda um
   resumo para todos. Cada celular escolhe o seu Aux e recebe so os canais
   dele; o que a pessoa mexe vai direto para o send desse Aux na mesa.
   A escolha fica no celular e vai de novo para o bridge a cada conexao.   */

const TOTAL_AUX = 8;
const ESPERA_MODO = 2500;        // sem mesa:resumo ate aqui: bridge que nao le a mesa
const ESPERA_ESTADO = 8000;      // mesa pronta, fone pedido, e nada dos canais
const ESPERA_SINCRONIA = 10000;  // pediu a leitura e o bridge nem comecou
const ESPERA_ATUALIZAR = 15000;  // pediu a atualizacao e o bridge nao respondeu
const AVISO_ERRO_FONE_MS = 8000;
const AVISO_INATIVO_MS = 6000;
const AVISO_LEITURA_MS = 8000;
const AVISO_TROCANDO_MS = 60000; // o texto promete "ate 1 minuto"
const CARENCIA_ROTA_MS = 1500;   // ao conectar, espera o "testando" antes de culpar a rota

/* O que conferir quando a mesa nao responde. O bridge manda esta lista no
   resultado do teste; quem conectou depois da falha nao recebe, e usa esta,
   igual a do bridge (CONFERIR_NA_MESA em src/bridge.js). */
const CONFERIR_NA_MESA = [
  'MIDI | SETUP: PARAMETER CHANGE com Rx ON.',
  'MIDI | SETUP, linha CHANNEL: anote os canais Tx e Rx (o app testa o Rx sozinho, de 1 a 16).',
  'DIO/SETUP | MIDI/HOST: GENERAL Rx PORT e Tx PORT em USB (a mesma USB do cabo).',
  'Feche o "AirFader" (ou o "Studio Manager") neste PC: aberto, ele pode prender a porta da mesa.'
];

let conectadoEm = 0; // quando a conexao com o bridge abriu (carencia da rota)

const elFone = document.getElementById('fone');
const elFoneTrocar = document.getElementById('foneTrocar');
const elFoneAux = document.getElementById('foneAux');
const elFoneApelido = document.getElementById('foneApelido');
const elFoneFiltro = document.getElementById('foneFiltro');
const elAbaComSomN = document.getElementById('abaComSomN');
const elAbaTodosN = document.getElementById('abaTodosN');
const elFoneCanais = document.getElementById('foneCanais');
const elFoneNenhum = document.getElementById('foneNenhum');
const elFoneVerTodos = document.getElementById('foneVerTodos');
const elFoneMestre = document.getElementById('foneMestre');
const elFoneEspera = document.getElementById('foneEspera');
const elEscolha = document.getElementById('escolha');
const elEscolhaTitulo = document.getElementById('escolhaTitulo');
const elEscolhaGrade = document.getElementById('escolhaGrade');
const elEscolhaVoltar = document.getElementById('escolhaVoltar');
const elLegadoVoltar = document.getElementById('legadoVoltar');
const moldeSituacao = document.getElementById('moldeSituacao');

/** 'desconhecido' logo ao conectar; 'mapa' quando o bridge le a mesa; 'legado' quando nao. */
let modo = 'desconhecido';
let timerModo = null;

const mapa = {
  conhecido: false,     // ja chegou algum mesa:resumo
  pronta: false,
  auxes: [],            // [{ aux, nome }] de 1 a 8
  resolucao: null,
  sincronizadaEm: null,
  fase: null,           // ultima mesa:sincronia: 'lendo' | 'pronta' | 'falhou'
  lidos: 0,
  total: 0,
  motivo: ''
};

/** 1..8, venha como numero ou texto ("3"); senao null. */
function numeroDeAux(valor) {
  const n = typeof valor === 'string' && /^\d{1,2}$/.test(valor.trim()) ? Number(valor) : valor;
  return Number.isInteger(n) && n >= 1 && n <= TOTAL_AUX ? n : null;
}

const fone = {
  aux: numeroDeAux(lerSalvo(CHAVE_FONE)),
  estado: null,         // { aux, nome, master: { valor, on } | null, canais: Map canal -> canal }
  filtro: 'com-som',    // 'com-som' | 'todos'
  visiveis: new Set(),  // canais que aparecem em "Só com som"
  faixas: new Map(),    // canal -> fader
  mestre: null,         // fader do volume geral do fone
  escolhendo: false,    // tocou em trocar: a primeira tela volta, com o fone atual marcado
  esperaTimer: null,
  semResposta: false    // mesa pronta, fone pedido, e o bridge nao mandou os canais
};

/** Plano B: os controles calibrados no palco. Fica salvo ate a pessoa voltar. */
let planoB = lerSalvo(CHAVE_PLANO_B) === '1';

function usandoMapa() {
  return modo === 'mapa' && !(planoB && listaControles.length > 0);
}

function prontaParaUsar() {
  return mapa.pronta || mapa.fase === 'pronta';
}

function nomeDoAux(aux) {
  if (fone.estado && fone.estado.aux === aux && fone.estado.nome) return fone.estado.nome;
  const item = mapa.auxes.find((a) => a.aux === aux);
  return item ? item.nome : '';
}

/** "AUX 3 · Bateria", ou so "AUX 3" quando a mesa nao tem nome para ele. */
function rotuloDoAux(aux) {
  const nome = nomeDoAux(aux);
  return 'AUX ' + aux + (nome ? ' · ' + nome : '');
}

/** O nome que esta na mesa, ou "CH 5". */
function rotuloDoCanal(canal) {
  return canal.nome || 'CH ' + canal.canal;
}

/** "O que esta na cena": confirmado, ligado e com algum volume. */
function temSom(canal) {
  return canal.confirmado && canal.on !== false && canal.valor > 0;
}

function canaisSemResposta() {
  if (!fone.estado) return 0;
  let n = 0;
  for (const c of fone.estado.canais.values()) if (!c.confirmado) n++;
  return n;
}

/** "lendo a mesa: 230 de 1100" */
function textoDaLeitura() {
  return 'lendo a mesa' + (mapa.total ? ': ' + Math.min(mapa.lidos, mapa.total) + ' de ' + mapa.total : '');
}

function porcentoDaLeitura() {
  return mapa.total ? Math.round((Math.min(mapa.lidos, mapa.total) / mapa.total) * 100) : 0;
}

/** Tudo que depende da leitura da mesa e da escolha do fone. */
function desenharMapa() {
  desenharPalco();
  desenharSituacoes();
  desenharLeitura();
  if (elAjustes.open) desenharAvancado();
}

/* ---- o que chega do bridge -------------------------------------------- */

function receberResumo(msg) {
  const eraPronta = prontaParaUsar();
  mapa.conhecido = true;
  clearTimeout(timerModo);
  modo = 'mapa';
  mapa.pronta = msg.pronta === true;
  // A mesa saiu do cabo (ou o bridge perdeu a leitura) sem leitura em curso:
  // vem resumo com pronta false e nenhuma mesa:sincronia. O 'pronta' da ultima
  // leitura nao vale mais: o aviso de mesa fora aparece e os faders travam.
  if (!mapa.pronta && mapa.fase === 'pronta') mapa.fase = null;

  const nomes = new Map();
  if (Array.isArray(msg.auxes)) {
    for (const item of msg.auxes) {
      const aux = numeroDeAux(item && item.aux);
      if (aux) nomes.set(aux, nomeDoAuxDaMesa(item.nome, aux));
    }
  }
  mapa.auxes = [];
  for (let aux = 1; aux <= TOTAL_AUX; aux++) mapa.auxes.push({ aux, nome: nomes.get(aux) || '' });

  mapa.resolucao = msg.resolucao === 'baixa' || msg.resolucao === 'alta' ? msg.resolucao : null;
  mapa.sincronizadaEm = typeof msg.sincronizadaEm === 'string' && msg.sincronizadaEm ? msg.sincronizadaEm : null;

  // A mesa ficou pronta com o fone ja pedido: daqui em diante vale esperar os canais.
  if (!eraPronta && prontaParaUsar() && fone.aux && !fone.estado) vigiarEstado();
  desenharMapa();
  desenharAtualizacao();
}

function receberSincronia(msg) {
  const fase = msg.fase;
  if (fase !== 'lendo' && fase !== 'pronta' && fase !== 'falhou') return;
  const antes = mapa.fase;
  const eraPronta = prontaParaUsar();

  mapa.fase = fase;
  mapa.lidos = inteiroOuZero(msg.lidos);
  mapa.total = inteiroOuZero(msg.total);
  mapa.motivo = fase === 'falhou' ? textoLimpo(msg.motivo) : '';

  // Qualquer noticia da leitura responde ao pedido feito daqui.
  if (sincronizar.pedido) {
    clearTimeout(sincronizar.vigia);
    sincronizar.pedido = false;
    sincronizar.acompanhando = true;
  }
  sincronizar.erro = '';

  // A falha tem o aviso ambar no topo; a leitura pedida daqui conta que acabou.
  if (antes !== null && antes !== fase && fase === 'pronta' && sincronizar.acompanhando) {
    avisarNoRodape('a mesa foi lida de novo', AVISO_LEITURA_MS);
  }
  if (fase !== 'lendo') sincronizar.acompanhando = false;

  if (!eraPronta && prontaParaUsar() && fone.aux && !fone.estado) vigiarEstado();
  desenharMapa();
}

/**
 * Sem nome lido na mesa, o bridge manda "Aux 3" / "Canal 5". Aqui isso conta
 * como sem nome: a tecla mostra "sem nome na mesa" e a faixa "CH 05", em vez
 * de repetir o numero duas vezes.
 */
function nomeDaMesa(texto, padrao, numero) {
  const nome = textoLimpo(texto);
  return new RegExp('^(?:' + padrao + ')\\s*0*' + numero + '$', 'i').test(nome) ? '' : nome;
}

function nomeDoAuxDaMesa(texto, aux) {
  return nomeDaMesa(texto, 'aux', aux);
}

function nomeDoCanalDaMesa(texto, canal) {
  return nomeDaMesa(texto, 'canal|ch', canal);
}

function lerCanalDoBridge(bruto) {
  const canal = bruto && Number.isInteger(bruto.canal) && bruto.canal >= 1 && bruto.canal <= TOTAL_CANAIS
    ? bruto.canal : null;
  if (!canal) return null;
  return {
    canal,
    nome: nomeDoCanalDaMesa(bruto.nome, canal),
    valor: valor01(bruto.valor),
    on: bruto.on === false ? false : bruto.on === true ? true : null,
    confirmado: bruto.confirmado !== false
  };
}

/**
 * O fone inteiro: chega depois de escolher e depois de cada leitura da mesa
 * (troca de cena, por exemplo). O filtro "Só com som" refaz a lista aqui.
 */
function receberEstadoDoFone(msg) {
  const aux = numeroDeAux(msg.aux);
  if (!aux || aux !== fone.aux) return; // resposta atrasada de um fone anterior

  const canais = [];
  if (Array.isArray(msg.canais)) {
    for (const bruto of msg.canais) {
      const c = lerCanalDoBridge(bruto);
      if (c) canais.push(c);
    }
  }
  canais.sort((a, b) => a.canal - b.canal);

  const m = msg.master && typeof msg.master === 'object' ? msg.master : null;
  fone.estado = {
    aux,
    nome: nomeDoAuxDaMesa(msg.nome, aux),
    // Valor nulo = a mesa nao respondeu esse endereco: fica "?", nunca 0.
    master: m && m.valor !== null && m.valor !== undefined ? { valor: valor01(m.valor), on: m.on !== false } : null,
    canais: new Map(canais.map((c) => [c.canal, c]))
  };
  const item = mapa.auxes.find((a) => a.aux === aux);
  if (item && fone.estado.nome) item.nome = fone.estado.nome;

  clearTimeout(fone.esperaTimer);
  fone.semResposta = false;
  recalcularVisiveis();
  desenharFaixas();
  desenharMapa();
}

/** Uma mudanca so: de outro celular no mesmo Aux, da mesa, ou o nome. */
function receberMudancaNoFone(msg) {
  const aux = numeroDeAux(msg.aux);
  if (!aux) return;
  const campo = msg.campo;
  const semCanal = msg.canal === null || msg.canal === undefined;

  // Nome do proprio Aux (a equipe renomeou na mesa).
  if (campo === 'nome' && semCanal) {
    const nome = nomeDoAuxDaMesa(msg.valor, aux);
    const item = mapa.auxes.find((a) => a.aux === aux);
    if (item) item.nome = nome;
    if (fone.estado && fone.estado.aux === aux) fone.estado.nome = nome;
    desenharMapa();
    return;
  }

  const est = fone.estado;
  if (!est || est.aux !== aux) return;

  if (campo === 'master' || campo === 'masterOn') {
    if (!est.master) est.master = { valor: 0, on: true };
    if (campo === 'master') {
      if (ecoRecente(fone.mestre)) return;
      est.master.valor = valor01(msg.valor);
    } else {
      est.master.on = msg.valor !== false;
    }
    desenharMestreDoFone();
    return;
  }

  const numero = Number(msg.canal);
  const c = est.canais.get(numero);
  if (!c) return;
  if (campo === 'valor') {
    if (ecoRecente(fone.faixas.get(numero))) return;
    c.valor = valor01(msg.valor);
  } else if (campo === 'on') {
    c.on = msg.valor !== false;
  } else if (campo === 'nome') {
    c.nome = nomeDoCanalDaMesa(msg.valor, numero);
  } else {
    return;
  }
  atualizarFaixa(c);

  // Canal que ganhou som entra no filtro. O que perdeu fica ate a proxima
  // cena: nao some debaixo do dedo de ninguem.
  if (temSom(c) && !fone.visiveis.has(numero)) {
    fone.visiveis.add(numero);
    aplicarFiltro();
  }
  atualizarRodape();
}

/* ---- escolher o fone ----------------------------------------------------- */

/** Pediu o fone com a mesa pronta: se os canais nao vierem, a tela diz. */
function vigiarEstado() {
  clearTimeout(fone.esperaTimer);
  fone.semResposta = false;
  if (!conectado || !fone.aux || fone.estado || !prontaParaUsar()) return;
  fone.esperaTimer = setTimeout(() => {
    if (fone.estado || !prontaParaUsar()) return;
    fone.semResposta = true;
    desenharMapa();
  }, ESPERA_ESTADO);
}

function pedirFone() {
  if (!fone.aux || !conectado) return;
  enviar({ type: 'fone:escolher', aux: fone.aux });
  vigiarEstado();
  desenharSituacoes();
}

function escolherFone(aux) {
  fone.escolhendo = false;
  if (aux !== fone.aux || !fone.estado) {
    descarregarFila(); // o que estava na fila ainda e do fone anterior
    fone.aux = aux;
    salvar(CHAVE_FONE, aux);
    fone.estado = null;
    fone.filtro = 'com-som';
    fone.visiveis = new Set();
    pedirFone();
  }
  desenharMapa();
}

/** Um numero dado, na fonte de mostrador. */
function spanNumero(texto) {
  const n = document.createElement('span');
  n.className = 'n';
  n.textContent = String(texto);
  return n;
}

function desenharEscolha() {
  if (elEscolhaGrade.childElementCount !== TOTAL_AUX) {
    elEscolhaGrade.textContent = '';
    for (let aux = 1; aux <= TOTAL_AUX; aux++) {
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'aux';
      botao.dataset.aux = String(aux);
      elEscolhaGrade.appendChild(botao);
    }
  }

  // Tecla: legenda "AUX" + numero em cima, nome da mesa embaixo. Sem nome na
  // mesa, a legenda diz isso e o "AUX 8" vira o nome, num tom abaixo.
  for (const botao of elEscolhaGrade.children) {
    const aux = Number(botao.dataset.aux);
    const nome = nomeDoAux(aux);
    const atual = aux === fone.aux;

    const legenda = document.createElement('span');
    legenda.className = 'aux__num';
    const elNome = document.createElement('span');
    elNome.className = 'aux__nome';
    if (nome) {
      legenda.append('AUX ', spanNumero(aux));
      elNome.textContent = nome;
    } else {
      legenda.textContent = 'sem nome na mesa';
      elNome.append('AUX ', spanNumero(aux));
    }

    botao.textContent = '';
    botao.classList.toggle('aux--sem', !nome);
    botao.append(legenda);
    if (atual) {
      const marca = document.createElement('span');
      marca.className = 'aux__atual';
      marca.textContent = 'atual';
      botao.append(marca);
      botao.setAttribute('aria-current', 'true');
    } else {
      botao.removeAttribute('aria-current');
    }
    botao.append(elNome);
    botao.setAttribute('aria-label', rotuloDoAux(aux) + (atual ? ', o seu fone agora' : ''));
  }
  encaixarNomesDosFones();

  // "Continuar no AUX 3 · Bateria": so quando ja existe um fone.
  const continuar = !!(fone.aux && fone.escolhendo);
  elEscolhaVoltar.hidden = !continuar;
  if (continuar) {
    const nome = nomeDoAux(fone.aux);
    elEscolhaVoltar.textContent = '';
    elEscolhaVoltar.append('Continuar no AUX ', spanNumero(fone.aux));
    if (nome) {
      const resto = document.createElement('span');
      resto.className = 'continuar__nome';
      resto.textContent = ' · ' + nome;
      elEscolhaVoltar.append(resto);
    }
    elEscolhaVoltar.setAttribute('aria-label', 'Continuar no ' + rotuloDoAux(fone.aux));
  }
}

/* Tecla estreita na paisagem: o nome do fone diminui antes de quebrar a palavra. */
const NOME_DO_FONE_MENOR = 17;

function encaixarNomesDosFones() {
  for (const el of elEscolhaGrade.querySelectorAll('.aux__nome')) encaixarNome(el, NOME_DO_FONE_MENOR);
}

elEscolhaGrade.addEventListener('click', (ev) => {
  const botao = ev.target.closest('[data-aux]');
  if (botao) escolherFone(Number(botao.dataset.aux));
});

elEscolhaVoltar.addEventListener('click', () => {
  fone.escolhendo = false;
  desenharMapa();
});

elFoneTrocar.addEventListener('click', () => {
  fone.escolhendo = true;
  desenharMapa();
});

/* ---- a tela do fone ------------------------------------------------------ */

function desenharTelaDoFone() {
  const apelido = nomeDoAux(fone.aux);
  elFoneAux.textContent = String(fone.aux);
  elFoneApelido.textContent = apelido || 'AUX ' + fone.aux;
  elFoneTrocar.setAttribute('aria-label', 'Seu fone: ' + rotuloDoAux(fone.aux) + '. Trocar de fone');

  const temCanais = foneComCanais();
  elFoneEspera.hidden = temCanais;
  elFoneCanais.hidden = !temCanais;
  elFoneMestre.hidden = !temCanais;
  if (fone.mestre) fone.mestre.definirPe('AUX', fone.aux);

  // Faixas desenhadas com a tela escondida: o nome so mede agora.
  if (temCanais) {
    for (const comp of fone.faixas.values()) if (!comp.no.hidden) comp.encaixar();
    if (fone.mestre) fone.mestre.encaixar();
  }
}

function criarFaixa(numero) {
  const modelo = () => (fone.estado ? fone.estado.canais.get(numero) : null);
  return criarFader({
    tipo: 'canal',
    rotulo: 'CH ' + numero,
    numero,
    aoMudarValor: (valor) => {
      const c = modelo();
      if (c) c.valor = valor;
      if (!fone.aux) return;
      marcarPedido('fone');
      enfileirar('fone:send:' + fone.aux + ':' + numero,
        { type: 'fone:send', aux: fone.aux, canal: numero, valor: arredondar01(valor) });
    },
    aoMudarMudo: (mudo) => {
      const c = modelo();
      if (c) c.on = !mudo;
      if (!fone.aux) return;
      marcarPedido('fone');
      enviar({ type: 'fone:sendOn', aux: fone.aux, canal: numero, on: !mudo });
    },
    aoTocarInativo: () => {
      const c = modelo();
      // Curto para caber no rodape em 360px; o caminho (Ler a mesa de novo) esta em Ajustes.
      avisarNoRodape('canal ' + numero + (c && c.nome ? ' (' + c.nome + ')' : '') +
        ' sem resposta da mesa: veja Ajustes', AVISO_INATIVO_MS);
    }
  });
}

/**
 * Valor, nome, mudo e confirmacao de um canal. Valor que chega de fora (troca
 * de cena, outro celular) desliza como fader motorizado; o primeiro desenho
 * nao.
 */
function atualizarFaixa(c) {
  const comp = fone.faixas.get(c.canal);
  if (!comp) return;
  comp.renomear(rotuloDoCanal(c),
    'Canal ' + c.canal + (c.nome ? ', ' + c.nome : '') + (c.confirmado ? '' : ', a mesa não confirmou'),
    { semNome: !c.nome, numero: c.canal });
  comp.definirAtivo(c.confirmado, 'A mesa não confirmou este canal.');
  if (!comp.arrastando) comp.aplicar(c.valor, false, comp.iniciado);
  comp.iniciado = true;
  comp.definirMudo(c.on === false, false);
}

function criarMestreDoFone() {
  return criarFader({
    tipo: 'master',
    rotulo: 'Volume geral',
    rotuloAcessivel: 'Volume geral do fone',
    aoMudarValor: (valor) => {
      if (!fone.aux) return;
      if (fone.estado && fone.estado.master) fone.estado.master.valor = valor;
      marcarPedido('fone');
      enfileirar('fone:master:' + fone.aux, { type: 'fone:master', aux: fone.aux, valor: arredondar01(valor) });
    },
    aoMudarMudo: (mudo) => {
      if (!fone.aux) return;
      if (fone.estado && fone.estado.master) fone.estado.master.on = !mudo;
      marcarPedido('fone');
      enviar({ type: 'fone:masterOn', aux: fone.aux, on: !mudo });
    },
    aoTocarInativo: () => {
      avisarNoRodape('volume geral sem resposta da mesa: veja Ajustes', AVISO_INATIVO_MS);
    }
  });
}

function desenharMestreDoFone() {
  if (!fone.mestre) {
    fone.mestre = criarMestreDoFone();
    elFoneMestre.appendChild(fone.mestre.no);
  }
  const m = fone.estado ? fone.estado.master : null;
  fone.mestre.definirAtivo(!!m, 'A mesa não confirmou o volume geral deste fone.');
  if (m && !fone.mestre.arrastando) fone.mestre.aplicar(m.valor, false, fone.mestre.iniciado);
  fone.mestre.iniciado = !!m;
  fone.mestre.definirMudo(m ? !m.on : false, false);
  if (fone.aux) fone.mestre.definirPe('AUX', fone.aux);
  fone.mestre.encaixar();
}

/**
 * As faixas nascem uma vez (32) e so mudam de valor, nome e visibilidade:
 * a troca de cena atualiza no lugar e nao derruba o dedo de quem arrasta.
 */
function desenharFaixas() {
  const est = fone.estado;
  if (!est) return;
  const lista = [...est.canais.values()];
  const mesmas = lista.length === fone.faixas.size && lista.every((c) => fone.faixas.has(c.canal));
  if (!mesmas) {
    for (const comp of fone.faixas.values()) comp.no.remove();
    fone.faixas.clear();
    for (const c of lista) {
      const comp = criarFaixa(c.canal);
      fone.faixas.set(c.canal, comp);
      elFoneCanais.insertBefore(comp.no, elFoneNenhum);
    }
  }
  for (const c of lista) atualizarFaixa(c);
  desenharMestreDoFone();
  aplicarFiltro();
}

function recalcularVisiveis() {
  fone.visiveis = new Set();
  if (!fone.estado) return;
  for (const c of fone.estado.canais.values()) if (temSom(c)) fone.visiveis.add(c.canal);
}

function aplicarFiltro() {
  const todos = fone.filtro === 'todos';
  let aparecem = 0;
  for (const [canal, comp] of fone.faixas) {
    const ver = todos || fone.visiveis.has(canal) || comp.arrastando;
    comp.no.hidden = !ver;
    if (ver) {
      aparecem++;
      comp.encaixar();
    }
  }
  const total = fone.faixas.size || TOTAL_CANAIS;
  elFoneNenhum.hidden = aparecem > 0 || !fone.faixas.size;
  escreverComNumeros(elFoneVerTodos, 'Mostrar todos ' + total);
  elAbaComSomN.textContent = String(fone.visiveis.size);
  elAbaTodosN.textContent = String(total);
  for (const botao of elFoneFiltro.querySelectorAll('[data-filtro]')) {
    botao.setAttribute('aria-pressed', botao.dataset.filtro === fone.filtro ? 'true' : 'false');
  }
}

function trocarFiltro(filtro) {
  if (filtro !== 'com-som' && filtro !== 'todos') return;
  fone.filtro = filtro;
  if (filtro === 'com-som') recalcularVisiveis();
  aplicarFiltro();
  elFoneCanais.scrollLeft = 0;
}

elFoneFiltro.addEventListener('click', (ev) => {
  const botao = ev.target.closest('[data-filtro]');
  if (botao) trocarFiltro(botao.dataset.filtro);
});

elFoneVerTodos.addEventListener('click', () => trocarFiltro('todos'));

/* ---- mesa no topo: so aparece quando ha algo ---------------------------
   pronta = nada; lendo = "lendo a mesa 330/1100" na linha das abas, sem
   empurrar as faixas; falhou, mesa fora do cabo e sem conexao = aviso ambar.
   O aviso empurra as faixas em retrato: so entra (ou sai) sem dedo num
   fader. A escolha nao tem faders: la ele entra na hora.                */

const elAviso = document.getElementById('aviso');
const elLendo = document.getElementById('lendo');

const avisoComando = {
  caixa: elAviso,
  titulo: document.getElementById('avisoTitulo'),
  longo: document.getElementById('avisoLongo'),
  curto: document.getElementById('avisoCurto'),
  acao: document.getElementById('avisoAcao'),
  calibrados: null
};

const avisoEscolha = {
  caixa: document.getElementById('avisoEscolha'),
  titulo: document.getElementById('avisoEscolhaTitulo'),
  longo: document.getElementById('avisoEscolhaLongo'),
  curto: document.getElementById('avisoEscolhaCurto'),
  acao: document.getElementById('avisoEscolhaAcao'),
  calibrados: document.getElementById('avisoEscolhaCalibrados')
};

const lendoComando = {
  caixa: elLendo,
  texto: document.getElementById('lendoTexto'),
  fio: document.getElementById('lendoFio')
};

const lendoEscolha = {
  caixa: document.getElementById('lendoEscolha'),
  texto: document.getElementById('lendoEscolhaTexto'),
  fio: document.getElementById('lendoEscolhaFio')
};

let alertaNoComando = null; // o alerta que esta na tela agora (ou null)

/**
 * O teste do caminho ate a mesa falhou: aqui (mesa:teste "falhou") ou antes de
 * este celular conectar (a rota veio nula ou nao reconfirmada no status). Logo
 * ao conectar espera um instante: um "testando" pode estar vindo em seguida.
 */
function semRotaAteAMesa() {
  if (mesa.fase === 'falhou' || mesa.fase === 'parou') return true;
  if (testeEmAndamento()) return false;
  if (Date.now() - conectadoEm < CARENCIA_ROTA_MS) return false;
  return !mesa.rota || mesa.rota.reconfirmada === false;
}

/**
 * 'sem' | 'falhou' | 'desligada' | 'sem-rota' | 'testando' | 'lendo' |
 * 'esperando' | null (pronta).
 */
function estadoDaMesa() {
  if (document.body.dataset.conexao === 'offline') return 'sem';
  if (!conectado || modo !== 'mapa') return null;
  if (mapa.fase === 'falhou') return 'falhou';
  if (mapa.fase === 'lendo') return 'lendo';
  if (prontaParaUsar()) return null;
  if (statusMidi && statusMidi.simulado) return 'desligada';
  if (testeEmAndamento()) return 'testando';
  if (semRotaAteAMesa()) return 'sem-rota';
  return 'esperando';
}

function alertaDaMesa() {
  const tipo = estadoDaMesa();
  return tipo === 'sem' || tipo === 'falhou' || tipo === 'desligada' || tipo === 'sem-rota' ? tipo : null;
}

function desenharAvisos() {
  const tipo = estadoDaMesa();
  // Mesa fora (ou ainda nao lida) com o fone na tela: os faders ficam apagados
  // e travados, como sem conexao. Nada que se mexa aqui chegaria na mesa.
  if (['desligada', 'esperando', 'sem-rota', 'testando'].includes(tipo)) document.body.dataset.mesa = 'fora';
  else delete document.body.dataset.mesa;
  desenharLendo(lendoComando, tipo);
  desenharLendo(lendoEscolha, tipo);
  preencherAlerta(avisoEscolha, alertaDaMesa(), true);

  if (alertaDaMesa() === alertaNoComando) preencherAlerta(avisoComando, alertaNoComando, false);
  else semDedoNoFader(trocarAlertaDoComando);

  desenharCena(); // sem conexao a cena e desconhecida
}

function trocarAlertaDoComando() {
  alertaNoComando = alertaDaMesa();
  preencherAlerta(avisoComando, alertaNoComando, false);
}

function desenharLendo(r, tipo) {
  const mostra = tipo === 'lendo' || tipo === 'esperando' || tipo === 'testando';
  r.caixa.hidden = !mostra;
  if (!mostra) return;
  if (tipo === 'lendo') {
    escreverComNumeros(r.texto, mapa.total
      ? 'lendo a mesa ' + Math.min(mapa.lidos, mapa.total) + '/' + mapa.total
      : 'lendo a mesa');
    r.caixa.removeAttribute('data-sem-fio');
    r.fio.style.width = porcentoDaLeitura() + '%';
  } else {
    r.texto.textContent = tipo === 'testando' ? 'testando o caminho até a mesa' : 'esperando a mesa';
    r.caixa.setAttribute('data-sem-fio', '');
  }
}

function preencherAlerta(r, tipo, naEscolha) {
  r.caixa.hidden = !tipo;
  if (!tipo) return;

  const comCanais = !!fone.estado && !naEscolha;
  const temCalibrados = listaControles.some((c) => c.calibrated);
  let titulo;
  let longo;
  let curto;
  let acao = true;
  if (tipo === 'sem') {
    titulo = 'Sem conexão';
    longo = 'O celular não acha o programa da mesa. Confira se está no Wi-Fi da igreja. ' +
      (naEscolha ? 'Os fones aparecem quando a conexão voltar.' : 'Os faders voltam sozinhos quando a conexão voltar.');
    curto = naEscolha ? 'Confira o Wi-Fi da igreja.' : 'Confira o Wi-Fi da igreja. Os faders voltam sozinhos.';
    acao = false;
  } else if (tipo === 'falhou') {
    titulo = 'Mesa falhou';
    longo = (mapa.motivo || 'A mesa não respondeu à leitura.') +
      (comCanais ? ' Os canais que ela não confirmou ficam apagados até a próxima leitura.' : '');
    curto = comCanais ? 'Canais não confirmados ficam apagados.' : 'A mesa não respondeu à leitura.';
  } else if (tipo === 'sem-rota') {
    // O cenario real da igreja (Rx CH, porta): o texto ja diz o que olhar.
    titulo = 'Mesa sem resposta';
    longo = 'A mesa não respondeu ao teste: nada do celular chega nela. Na mesa, confira ' +
      // Espaco que nao quebra dentro do nome do menu: "MIDI | SETUP" desce inteiro.
      'PARAMETER CHANGE com Rx ON (MIDI | SETUP) e GENERAL Rx PORT em USB (DIO/SETUP | MIDI/HOST).';
    curto = 'Confira na mesa o Rx ON e o Rx PORT em USB.';
  } else {
    titulo = 'Mesa não encontrada';
    longo = 'O programa não acha a mesa no cabo USB. Quando ela ligar, ele lê os nomes sozinho.';
    curto = 'A mesa não está no cabo USB.';
  }
  r.titulo.textContent = titulo;
  r.longo.textContent = '';
  r.longo.append(destacarMenus(longo));
  r.curto.textContent = curto;
  r.acao.hidden = !acao;
  if (r.calibrados) r.calibrados.hidden = !(tipo === 'falhou' && temCalibrados);
}

avisoComando.acao.addEventListener('click', () => abrirAjustesNaMesa());
avisoEscolha.acao.addEventListener('click', () => abrirAjustesNaMesa());
avisoEscolha.calibrados.addEventListener('click', () => usarCalibrados(true));

/* ---- o fone ainda sem canais ------------------------------------------- */

function montarSituacao(casa) {
  const no = moldeSituacao.content.firstElementChild.cloneNode(true);
  casa.appendChild(no);
  const s = {
    casa,
    texto: no.querySelector('[data-texto]'),
    erro: no.querySelector('[data-erro]'),
    titulo: no.querySelector('[data-titulo]'),
    motivo: no.querySelector('[data-motivo]'),
    calibrados: no.querySelector('[data-acao="calibrados"]')
  };
  no.addEventListener('click', (ev) => {
    const botao = ev.target.closest('[data-acao]');
    if (!botao) return;
    if (botao.dataset.acao === 'ajustes') abrirAjustesNaMesa();
    else if (botao.dataset.acao === 'calibrados') usarCalibrados(true);
    else if (botao.dataset.acao === 'tentar') pedirFone();
  });
  return s;
}

const situacaoFone = montarSituacao(document.getElementById('foneSituacao'));

/**
 * Algum canal que a mesa confirmou? Com a mesa sem resposta o fone chega com
 * os 32 sem valor: ai nao ha faixa para mostrar, e muito menos "Nenhum canal
 * com som", que culparia a cena.
 */
function foneComCanais() {
  if (!fone.estado) return false;
  for (const c of fone.estado.canais.values()) if (c.confirmado) return true;
  return false;
}

/** O que dizer no lugar das faixas enquanto os canais nao chegam. */
function situacaoDoFone() {
  if (foneComCanais()) return null;
  if (document.body.dataset.conexao === 'offline') return 'sem-conexao';
  if (!conectado || modo !== 'mapa') return null;
  const tipo = estadoDaMesa();
  if (tipo === 'lendo') return 'lendo';
  if (tipo === 'falhou') return 'falhou';
  if (tipo === 'sem-rota') return 'sem-rota';
  if (tipo === 'testando') return 'testando';
  if (tipo) return 'esperando';
  return fone.estado || fone.semResposta ? 'sem-resposta' : 'abrindo';
}

function desenharSituacoes() {
  const s = situacaoFone;
  const tipo = situacaoDoFone();
  s.casa.hidden = !tipo;
  if (!tipo) return;

  const erro = tipo === 'sem-resposta';
  s.erro.hidden = !erro;
  s.texto.hidden = erro;
  s.calibrados.hidden = !(tipo === 'falhou' && listaControles.some((c) => c.calibrated));

  if (tipo === 'sem-conexao') s.texto.textContent = 'Os faders aparecem quando a conexão voltar.';
  else if (tipo === 'lendo') s.texto.textContent = 'Os canais do seu fone chegam quando a leitura terminar.';
  else if (tipo === 'esperando') s.texto.textContent = 'Os canais do seu fone aparecem quando a mesa responder.';
  else if (tipo === 'sem-rota') s.texto.textContent = 'A mesa não respondeu: os canais do seu fone aparecem quando ela responder. Veja o aviso acima.';
  else if (tipo === 'testando') s.texto.textContent = 'Testando o caminho até a mesa. Os canais aparecem quando ela responder.';
  else if (tipo === 'falhou') s.texto.textContent = 'Sem a leitura da mesa, os canais do seu fone não aparecem.';
  else if (tipo === 'abrindo') s.texto.textContent = 'abrindo o ' + rotuloDoAux(fone.aux);
  else {
    s.titulo.textContent = 'Sem os canais do fone';
    s.motivo.textContent = 'O programa não mandou os canais do ' + rotuloDoAux(fone.aux) +
      '. Toque em Tentar de novo; se continuar, copie o diagnóstico em Ajustes.';
  }
}

/* ---- plano B: os controles calibrados no palco ------------------------- */

const elAvancado = document.getElementById('avancado');
const elUsarCalibrados = document.getElementById('usarCalibrados');

function usarCalibrados(ligar) {
  planoB = !!ligar;
  salvar(CHAVE_PLANO_B, planoB ? '1' : '');
  desenharMapa();
  desenharAvancado();
}

elLegadoVoltar.addEventListener('click', () => usarCalibrados(false));
elUsarCalibrados.addEventListener('change', () => usarCalibrados(elUsarCalibrados.checked));

function desenharAvancado() {
  // Bridge que nao le a mesa: a calibracao e o unico caminho, fica aberta.
  const legado = modo === 'legado';
  elUsarCalibrados.closest('label').hidden = legado;
  elUsarCalibrados.checked = planoB;
  elUsarCalibrados.disabled = !planoB && !listaControles.length;
  if (legado) elAvancado.open = true;
}

/* ---- ler a mesa de novo -------------------------------------------------- */

const elBlocoLeitura = document.getElementById('blocoLeitura');
const elLeituraEstado = document.getElementById('leituraEstado');
const elLeituraProgresso = document.getElementById('leituraProgresso');
const elLeituraProgressoTexto = document.getElementById('leituraProgressoTexto');
const elLeituraBarra = document.getElementById('leituraBarra');
const elLeituraBarraTrilho = document.getElementById('leituraBarraTrilho');
const elLeituraErro = document.getElementById('leituraErro');
const elLeituraMotivo = document.getElementById('leituraMotivo');
const elLeituraDica = document.getElementById('leituraDica');
const elBtnLerMesa = document.getElementById('btnLerMesa');

const sincronizar = {
  pedido: false,       // pediu daqui e o bridge ainda nao deu noticia
  acompanhando: false, // a leitura em andamento foi pedida daqui
  vigia: null,
  erro: ''             // recusa ou silencio do bridge
};

elBtnLerMesa.addEventListener('click', () => {
  if (!conectado || mapa.fase === 'lendo' || sincronizar.pedido) return;
  sincronizar.pedido = true;
  sincronizar.erro = '';
  clearTimeout(sincronizar.vigia);
  sincronizar.vigia = setTimeout(() => {
    if (!sincronizar.pedido) return;
    sincronizar.pedido = false;
    sincronizar.erro = 'O programa não respondeu ao pedido de leitura. Ele pode estar desatualizado: ' +
      'copie o diagnóstico abaixo e peça ajuda.';
    desenharLeitura();
  }, ESPERA_SINCRONIA);
  marcarPedido('sincronizar');
  enviar({ type: 'mesa:sincronizar' });
  desenharLeitura();
});

function recusarSincronia(texto) {
  clearTimeout(sincronizar.vigia);
  sincronizar.pedido = false;
  sincronizar.acompanhando = false;
  sincronizar.erro = texto || 'O programa não pôde ler a mesa agora. Tente de novo daqui a pouco.';
  desenharLeitura();
}

function desenharLeitura() {
  elBlocoLeitura.hidden = modo === 'legado';
  const lendo = mapa.fase === 'lendo';
  const falhou = mapa.fase === 'falhou' && !sincronizar.pedido;

  elLeituraProgresso.hidden = !lendo;
  if (lendo) {
    if (elLeituraProgressoTexto.textContent !== textoDaLeitura()) escreverComNumeros(elLeituraProgressoTexto, textoDaLeitura());
    elLeituraBarra.style.width = porcentoDaLeitura() + '%';
    elLeituraBarraTrilho.setAttribute('aria-valuemax', String(Math.max(1, mapa.total)));
    elLeituraBarraTrilho.setAttribute('aria-valuenow', String(Math.min(mapa.lidos, Math.max(1, mapa.total))));
  }

  let estado;
  if (sincronizar.pedido) estado = 'pedindo a leitura';
  else if (falhou) estado = 'não consegui ler a mesa';
  else if (prontaParaUsar()) {
    const quando = quandoNoDiagnostico(mapa.sincronizadaEm);
    estado = 'Mesa lida' + (quando ? ' ' + quando : '');
  } else if (!mapa.conhecido) estado = 'esperando o programa contar';
  else estado = statusMidi && statusMidi.simulado ? 'esperando a mesa ligar no cabo USB' : 'ainda não lida';
  elLeituraEstado.textContent = estado;
  elLeituraEstado.hidden = lendo; // o medidor ja conta
  elLeituraEstado.classList.toggle('bloco__estado--alerta', falhou || (!prontaParaUsar() && !sincronizar.pedido));

  const erro = sincronizar.erro || (falhou ? (mapa.motivo || 'A mesa não respondeu à leitura.') : '');
  elLeituraErro.hidden = !erro;
  elLeituraMotivo.textContent = erro;
  // Recusa do programa (ja lendo, ocupado) nao e problema de caminho ate a mesa.
  elLeituraDica.hidden = !!sincronizar.erro;

  elBtnLerMesa.disabled = !conectado || lendo || sincronizar.pedido;
  elBtnLerMesa.textContent = sincronizar.pedido ? 'Pedindo a leitura' : lendo ? 'Lendo a mesa' : 'Ler a mesa de novo';
}

/* ---- atualizar o programa agora ------------------------------------------ */

const elBlocoAtualizar = document.getElementById('blocoAtualizar');
const elAtualizarEstado = document.getElementById('atualizarEstado');
const elAtualizarProgresso = document.getElementById('atualizarProgresso');
const elAtualizarProgressoTexto = document.getElementById('atualizarProgressoTexto');
const elAtualizarDetalhe = document.getElementById('atualizarDetalhe');
const elAtualizarErro = document.getElementById('atualizarErro');
const elBtnAtualizar = document.getElementById('btnAtualizar');

const FASES_ATUALIZANDO = new Set(['pedido', 'verificando', 'baixando', 'testando', 'trocando']);
const TEXTO_DA_FASE = {
  pedido: 'pedindo a atualização',
  verificando: 'procurando versão nova',
  baixando: 'baixando a versão nova',
  testando: 'testando a versão nova',
  trocando: 'trocando de versão'
};

const atualizacao = {
  fase: null,          // as do bridge, mais 'pedido' (daqui) e 'voltou' (reconectou depois de trocar)
  mensagem: '',
  erro: '',            // recusa ou silencio do bridge
  pedidaAqui: false,   // este celular pediu: recarrega a pagina quando o programa voltar
  reiniciando: false,  // 'trocando': a queda da conexao e esperada
  vigia: null
};

elBtnAtualizar.addEventListener('click', () => {
  if (!conectado || FASES_ATUALIZANDO.has(atualizacao.fase)) return;
  if (!confirm('O app vai reiniciar e pode levar até 1 minuto. O som da mesa não muda. ' +
    'Com a mesa ligada, um ajuste feito nos últimos segundos pode não ficar salvo.')) return;

  atualizacao.fase = 'pedido';
  atualizacao.mensagem = '';
  atualizacao.erro = '';
  atualizacao.pedidaAqui = true;
  clearTimeout(atualizacao.vigia);
  atualizacao.vigia = setTimeout(() => {
    if (atualizacao.fase !== 'pedido') return;
    atualizacao.fase = null;
    atualizacao.pedidaAqui = false;
    atualizacao.erro = 'O programa não respondeu ao pedido de atualização. Ele pode ser de uma versão ' +
      'sem este botão: copie o diagnóstico abaixo e peça ajuda.';
    desenharAtualizacao();
  }, ESPERA_ATUALIZAR);
  marcarPedido('atualizar');
  enviar({ type: 'atualizar:agora' });
  desenharAtualizacao();
});

function recusarAtualizacao(texto) {
  clearTimeout(atualizacao.vigia);
  atualizacao.fase = null;
  atualizacao.pedidaAqui = false;
  atualizacao.erro = texto || 'O programa não pôde se atualizar agora. Tente de novo daqui a pouco.';
  desenharAtualizacao();
}

/** Mensagem 'atualizar:estado' do bridge. */
function receberAtualizacao(msg) {
  const fase = msg.fase;
  if (!FASES_ATUALIZANDO.has(fase) && fase !== 'em-dia' && fase !== 'falhou') return;
  clearTimeout(atualizacao.vigia);
  atualizacao.fase = fase;
  atualizacao.mensagem = textoLimpo(msg.mensagem);
  atualizacao.erro = '';
  atualizacao.reiniciando = fase === 'trocando';

  if (fase === 'trocando') {
    avisarNoRodape('o programa está reiniciando: volta em até 1 minuto', AVISO_TROCANDO_MS);
  } else if (fase === 'em-dia' || fase === 'falhou') {
    // "falhou" tambem chega quando o atualizador nao da sinal de vida em 2 min,
    // depois de "trocando": o aviso de reinicio no rodape deixa de valer.
    if (elRodapeAviso.textContent.startsWith('o programa está reiniciando')) limparAviso();
    if (atualizacao.pedidaAqui && !elAjustes.open) {
      avisarNoRodape(fase === 'em-dia'
        ? 'o programa já está na versão mais nova'
        : 'a atualização não terminou: veja Ajustes', AVISO_LEITURA_MS);
    }
    atualizacao.pedidaAqui = false;
  }
  desenharAtualizacao();
}

function desenharAtualizacao() {
  elBlocoAtualizar.hidden = modo === 'legado';
  const fase = atualizacao.fase;
  const ativa = FASES_ATUALIZANDO.has(fase);

  elAtualizarProgresso.hidden = !ativa;
  if (ativa) {
    elAtualizarProgressoTexto.textContent = TEXTO_DA_FASE[fase];
    elAtualizarDetalhe.textContent = atualizacao.mensagem ||
      (fase === 'trocando' ? 'O app volta sozinho em até 1 minuto. O som da mesa não muda.' : '');
    elAtualizarDetalhe.hidden = !elAtualizarDetalhe.textContent;
  }

  let estado = '';
  if (fase === 'em-dia') estado = atualizacao.mensagem || 'Já está na versão mais nova.';
  else if (fase === 'voltou') estado = 'O programa reiniciou e já voltou.';
  elAtualizarEstado.textContent = estado;
  elAtualizarEstado.hidden = !estado;

  const erro = atualizacao.erro ||
    (fase === 'falhou' ? 'A atualização não terminou.' + (atualizacao.mensagem ? ' ' + atualizacao.mensagem : '') : '');
  elAtualizarErro.textContent = erro;
  elAtualizarErro.hidden = !erro;

  elBtnAtualizar.disabled = !conectado || ativa;
  elBtnAtualizar.textContent = ativa ? 'Atualizando' : 'Atualizar agora';
}

/* ------------------------- painel de conexao ----------------------------- */

function abrirPainelConexao() {
  elPainelEndereco.value = lerSalvo(CHAVE_BRIDGE);
  elPainelInfo.textContent = (conectado ? 'Conectado.' : 'Ainda não achei o programa.') +
    '\nEndereço em uso: ' + urlDoBridge();
  elPainel.showModal();
}

document.getElementById('btnEndereco').addEventListener('click', () => {
  elAjustes.close();
  abrirPainelConexao();
});

elPainel.addEventListener('close', () => {
  if (elPainel.returnValue !== 'salvar') return;

  const valor = elPainelEndereco.value.trim();
  salvar(CHAVE_BRIDGE, valor);

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

desenharPalco();
conectar();
