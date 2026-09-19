'use strict';
/* ---------------------------------------------------------------------------
   Monitor 01V96 - app do celular
   Desenha os faders a partir da lista que o bridge manda, fala WebSocket e
   reconecta sozinho quando o Wi-Fi oscila ou o celular volta do bloqueio.
   --------------------------------------------------------------------------- */

const CHAVE_BRIDGE = 'monitor01v96.bridge';
const PASSO_TECLADO = 0.02;
const PASSO_TECLADO_GRANDE = 0.1;
const INTERVALO_ENVIO = 40;   // ms entre lotes de mensagens para o bridge
const BACKOFF_MAX = 5000;     // teto do tempo de espera entre reconexoes
const ESPERA_DEMO = 30000;    // em demonstracao, so espia de vez em quando

// Lista usada quando nao existe bridge nenhum (ex: app aberto numa hospedagem
// so para conhecer a interface). Nesse modo nada sai para a mesa.
const CONTROLES_DEMO = [
  { id: 'bumbo', label: 'Bumbo', type: 'canal', calibrated: false },
  { id: 'caixa', label: 'Caixa', type: 'canal', calibrated: false },
  { id: 'chimbal', label: 'Chimbal', type: 'canal', calibrated: false },
  { id: 'tons', label: 'Tons', type: 'canal', calibrated: false },
  { id: 'baixo', label: 'Baixo', type: 'canal', calibrated: false },
  { id: 'guitarra', label: 'Guitarra', type: 'canal', calibrated: false },
  { id: 'violao', label: 'Violão', type: 'canal', calibrated: false },
  { id: 'teclado', label: 'Teclado', type: 'canal', calibrated: false },
  { id: 'voz1', label: 'Voz 1', type: 'canal', calibrated: false },
  { id: 'voz2', label: 'Voz 2', type: 'canal', calibrated: false },
  { id: 'coral', label: 'Coral', type: 'canal', calibrated: false },
  { id: 'clique', label: 'Clique', type: 'canal', calibrated: false },
  { id: 'reverb', label: 'Reverb', type: 'reverb', calibrated: false },
  { id: 'geral', label: 'Volume geral', type: 'master', calibrated: false }
];

const elCanais = document.getElementById('canais');
const elMestre = document.getElementById('mestre');
const elConexao = document.getElementById('conexao');
const elConexaoTexto = document.getElementById('conexaoTexto');
const elRodape = document.getElementById('rodape');
const elPainel = document.getElementById('painel');
const elPainelInfo = document.getElementById('painelInfo');
const elPainelEndereco = document.getElementById('painelEndereco');
const molde = document.getElementById('moldeFader');

const faders = new Map(); // id -> objeto do componente
let socket = null;
let tentativas = 0;
let timerReconexao = null;
let modoDemo = false;
let checagemFeita = false;
let statusMidi = null;

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

function atualizarRodape() {
  if (modoDemo) {
    elRodape.textContent = 'modo demonstração: os faders mexem só na tela, nada chega na mesa';
    return;
  }
  if (!statusMidi) {
    elRodape.textContent = 'conectado ao bridge';
    return;
  }
  const semCalibrar = [...faders.values()].filter((f) => !f.controle.calibrated).length;
  const partes = [];
  partes.push(statusMidi.simulado ? 'midi simulado (nada chega na mesa)' : 'midi: ' + statusMidi.saida);
  if (semCalibrar) partes.push(semCalibrar + ' sem calibrar (*)');
  elRodape.textContent = partes.join('   |   ');
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
  faders.clear();
  elCanais.textContent = '';
  elMestre.textContent = '';

  for (const controle of lista) {
    const comp = criarFader(controle);
    faders.set(controle.id, comp);
    if (controle.type === 'master') elMestre.appendChild(comp.no);
    else elCanais.appendChild(comp.no);
  }

  // Sem nenhum master definido, o painel lateral so ocuparia espaco a toa.
  elMestre.style.display = elMestre.childElementCount ? '' : 'none';
  atualizarRodape();
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
  if (modoDemo) return;
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

  if (!modoDemo) {
    definirConexao(tentativas === 0 ? 'ligando' : 'offline', tentativas === 0 ? 'ligando' : 'reconectando');
  }

  let alvo;
  try {
    alvo = urlDoBridge();
    socket = new WebSocket(alvo);
  } catch {
    agendarReconexao();
    return;
  }

  socket.addEventListener('open', () => {
    tentativas = 0;
    modoDemo = false;
    checagemFeita = false;
    definirConexao('online', 'conectado');
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

    if (msg.type === 'controls') {
      desenharControles(msg.controls || []);
    } else if (msg.type === 'state') {
      aplicarEstado(msg.values, msg.mutes);
    } else if (msg.type === 'status') {
      statusMidi = msg.midi || null;
      atualizarRodape();
    }
  });

  socket.addEventListener('close', () => {
    if (!modoDemo) definirConexao('offline', 'reconectando');
    agendarReconexao();
  });

  socket.addEventListener('error', () => {
    try { socket.close(); } catch { /* o close cuida da reconexao */ }
  });
}

function agendarReconexao() {
  tentativas++;
  verificarSeExisteBridge();

  if (timerReconexao) return;

  // Em demonstracao nao existe bridge para voltar: basta espiar de vez em
  // quando, em vez de ficar tentando a cada poucos segundos e gastar bateria.
  const espera = modoDemo
    ? ESPERA_DEMO
    : Math.min(BACKOFF_MAX, 500 * Math.pow(2, Math.min(tentativas, 4)));
  timerReconexao = setTimeout(() => {
    timerReconexao = null;
    conectar();
  }, espera);
}

/**
 * O WebSocket falhou. Antes de desistir, pergunta pelo HTTP se existe um bridge
 * ali. Se existir, o problema e passageiro e continuamos tentando. Se nao
 * existir (pagina servida por uma hospedagem qualquer, sem o Raspberry Pi),
 * entra em demonstracao para a interface continuar navegavel.
 */
async function verificarSeExisteBridge() {
  if (checagemFeita || modoDemo || faders.size > 0) return;
  checagemFeita = true;

  try {
    const base = urlDoBridge().replace(/^ws/, 'http').replace(/\/+$/, '');
    const resposta = await fetch(base + '/api/controls', { cache: 'no-store' });
    const dados = await resposta.json();
    if (resposta.ok && Array.isArray(dados.controls)) {
      checagemFeita = false; // existe bridge: vale a pena continuar tentando
      return;
    }
  } catch {
    // sem resposta, ou resposta que nao e do bridge: cai na demonstracao
  }

  entrarEmDemo();
}

function entrarEmDemo() {
  modoDemo = true;
  statusMidi = null;
  definirConexao('demo', 'demonstração');
  desenharControles(CONTROLES_DEMO);
  aplicarEstado(
    {
      bumbo: 0.6, caixa: 0.55, chimbal: 0.45, tons: 0.45, baixo: 0.65,
      guitarra: 0.45, violao: 0.45, teclado: 0.5, voz1: 0.7, voz2: 0.6,
      coral: 0.5, clique: 0.75, reverb: 0.3, geral: 0.6
    },
    null
  );
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
  modoDemo = false;
  checagemFeita = false;
  faders.clear();
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

conectar();
