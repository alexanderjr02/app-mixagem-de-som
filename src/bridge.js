'use strict';
/**
 * bridge.js
 * O programa que fica rodando na maquina ligada na mesa por USB (Raspberry Pi
 * ou um PC). Ele faz quatro coisas ao mesmo tempo:
 *
 *   1. serve o app (pasta public/) por HTTP, para o celular abrir no navegador
 *   2. mantem um WebSocket com cada celular conectado, para resposta imediata
 *   3. traduz cada movimento de fader em uma mensagem SysEx para a 01V96
 *   4. conduz a calibracao pedida pelo celular, sem precisar de terminal,
 *      e cria os outros canais a partir de um calibrado, conferindo cada um
 *      com a mesa
 *
 * Seguranca de audio: o bridge so envia SysEx de controles marcados como
 * "calibrado": true no config.json. Enquanto voce nao calibrar, mexer nos
 * faders so muda a tela, nunca a mesa. Assim nao tem risco de mandar um
 * endereco chutado e bagunçar a mixagem da igreja. Ao criar canais, o que
 * vai para a mesa e so pedido de leitura (Parameter request), que nao muda
 * o som; o canal so vira controle se a mesa responder.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch {
  console.error('Falta instalar as dependencias. Rode: npm install');
  process.exit(1);
}

const configArquivo = require('./config');
const { abrirSaida, abrirEntrada, listarPortas, midiDisponivel, mensagemErroMidi } = require('./midi-io');
const mesa = require('./yamaha01v96');

const DIR_PUBLIC = path.join(configArquivo.RAIZ, 'public');

/**
 * Versao instalada, gravada pelo instalador e pela atualizacao automatica em
 * atualizacao.json (na pasta de dados). Sem o arquivo, tudo vem nulo.
 */
function lerVersao() {
  try {
    const j = configArquivo.lerJson(path.join(configArquivo.DADOS, 'atualizacao.json'));
    const sha = typeof j.atual === 'string' && /^[0-9a-f]{40}$/.test(j.atual) ? j.atual.slice(0, 7) : null;
    return {
      sha,
      instaladaEm: typeof j.instaladaEm === 'string' ? j.instaladaEm.slice(0, 40) : null,
      ultimoResultado: typeof j.ultimoResultado === 'string' ? j.ultimoResultado.slice(0, 120) : null
    };
  } catch {
    return { sha: null, instaladaEm: null, ultimoResultado: null };
  }
}

/**
 * Ultimos avisos, guardados para o botao "copiar diagnostico" do app.
 * Quando algo dá errado no meio do culto, ninguem vai abrir terminal: da para
 * copiar isso pelo celular e mandar para quem for ajudar.
 */
const avisos = [];
for (const nivel of ['warn', 'error']) {
  const original = console[nivel].bind(console);
  console[nivel] = (...args) => {
    const hora = new Date().toTimeString().slice(0, 8);
    avisos.push(hora + ' ' + args.join(' '));
    if (avisos.length > 30) avisos.shift();
    original(...args);
  };
}

// ---------------------------------------------------------------------------
// Configuracao e estado
// ---------------------------------------------------------------------------

let cfg;
try {
  cfg = configArquivo.carregar();
} catch (erro) {
  console.error('Erro no config.json: ' + erro.message);
  process.exit(1);
}

// A lista de controles muda em tempo de execucao (calibracao pelo celular),
// entao ela e sempre alterada no lugar, nunca trocada por outro array.
const controles = cfg.controles;
const porId = new Map();
const naoCalibrados = [];

const estado = { valores: {}, mutes: {} };
const salvo = configArquivo.carregarEstado();

/** Refaz os indices depois de qualquer mudanca na lista de controles. */
function aplicarListaDeControles(lista) {
  controles.length = 0;
  controles.push(...lista);

  porId.clear();
  naoCalibrados.length = 0;

  for (const c of controles) {
    porId.set(c.id, c);

    if (typeof estado.valores[c.id] !== 'number') {
      const restaurado = salvo.valores[c.id];
      estado.valores[c.id] = typeof restaurado === 'number'
        ? mesa.limitar01(restaurado)
        : mesa.limitar01(typeof c.valorInicial === 'number' ? c.valorInicial : 0.5);
    }
    if (typeof estado.mutes[c.id] !== 'boolean') {
      estado.mutes[c.id] = salvo.mutes[c.id] === true;
    }

    if (!mesa.estaCalibrado(c)) {
      naoCalibrados.push(c.id);
      continue;
    }
    const problemas = mesa.validarControle(c);
    if (problemas.length) {
      console.warn('[config] controle "' + c.id + '": ' + problemas.join('; '));
    }
  }
}

aplicarListaDeControles(cfg.controles.slice());

/** Grava a lista atual no config.json, relendo o arquivo para nao perder nada. */
function gravarControles(transformar) {
  const atual = configArquivo.carregar();
  const nova = transformar(atual.controles.slice());
  atual.controles = nova;
  configArquivo.salvar(atual);
  aplicarListaDeControles(nova);
}

// ---------------------------------------------------------------------------
// MIDI
// ---------------------------------------------------------------------------

// As portas sao procuradas sozinhas quando o config.json nao diz qual usar.
let saidaMidi = abrirSaida(cfg.midi.saida);
let entradaMidi = abrirEntrada(cfg.midi.entrada, aoReceberDaMesa);

function contarMidi(inicial) {
  if (saidaMidi.simulado) {
    console.warn('[midi] sem mesa na saida: ' + saidaMidi.motivo);
    if (inicial) console.warn('[midi] o app funciona, mas nada chega na mesa ainda.');
  } else {
    console.log('[midi] saida: ' + saidaMidi.nome);
  }

  if (entradaMidi.simulado) {
    console.warn('[midi] sem mesa na entrada: ' + entradaMidi.motivo);
  } else {
    console.log('[midi] entrada: ' + entradaMidi.nome);
  }
}

contarMidi(true);

/**
 * A maquina costuma ligar antes da mesa, e o PC da mesa fica ligado direto
 * enquanto a mesa e desligada depois do culto. Em vez de exigir reiniciar o
 * programa, ele confere de dez em dez segundos: se a mesa sumiu, larga a porta
 * morta; se a mesa apareceu, conecta. E avisa os celulares nos dois casos.
 */
function procurarMesa() {
  if (saidaMidi.sumiu() || entradaMidi.sumiu()) {
    // Entrada e saida sao o mesmo cabo: se uma morreu, as duas sao reabertas.
    console.warn('[midi] a mesa sumiu (desligada ou cabo solto), procurando de novo');
    interromperGeracao('a mesa sumiu no meio');
    try { saidaMidi.fechar(); } catch { /* ignora */ }
    try { entradaMidi.fechar(); } catch { /* ignora */ }
    saidaMidi = abrirSaida(cfg.midi.saida);
    entradaMidi = abrirEntrada(cfg.midi.entrada, aoReceberDaMesa);
    contarMidi(false);
    transmitirStatus();
    if (!saidaMidi.simulado) reaplicarMix();
    return;
  }

  if (!saidaMidi.simulado && !entradaMidi.simulado) return;

  let mudou = false;

  if (saidaMidi.simulado) {
    const nova = abrirSaida(cfg.midi.saida);
    if (!nova.simulado) {
      try { saidaMidi.fechar(); } catch { /* ignora */ }
      saidaMidi = nova;
      mudou = true;
    }
  }

  if (entradaMidi.simulado) {
    const nova = abrirEntrada(cfg.midi.entrada, aoReceberDaMesa);
    if (!nova.simulado) {
      try { entradaMidi.fechar(); } catch { /* ignora */ }
      entradaMidi = nova;
      mudou = true;
    }
  }

  if (!mudou) return;

  console.log('[midi] mesa encontrada');
  contarMidi(false);
  transmitirStatus();
  reaplicarMix();
}

/** Com a mesa de volta, o mix que esta na tela vale mais que o da mesa. */
function reaplicarMix() {
  if (!cfg.aplicarEstadoAoIniciar) return;
  for (const c of controles) if (mesa.estaCalibrado(c)) agendarEnvio(c.id);
}

setInterval(procurarMesa, cfg.midi.intervaloProcuraMs || 10000).unref();

/**
 * Fila de envio. Arrastar um fader gera dezenas de eventos por segundo; em vez
 * de despejar tudo na mesa, guardamos so o ultimo valor de cada controle e
 * mandamos em lote a cada intervaloEnvioMs. A resposta continua imediata no
 * ouvido e a mesa nao leva enxurrada de SysEx.
 */
const pendentes = new Map();
const ultimoEnvio = new Map(); // id -> instante do ultimo envio, para ignorar eco

function valorEfetivo(id) {
  return estado.mutes[id] ? 0 : estado.valores[id];
}

function agendarEnvio(id) {
  pendentes.set(id, valorEfetivo(id));
}

function despacharFila() {
  if (!pendentes.size) return;
  for (const [id, valor] of pendentes) {
    const controle = porId.get(id);
    if (!controle) continue;
    if (!mesa.estaCalibrado(controle)) continue; // protecao: nunca chutar bytes
    try {
      saidaMidi.enviar(mesa.montarFrame(controle, valor));
      ultimoEnvio.set(id, Date.now());
    } catch (erro) {
      console.error('[midi] falha ao montar quadro de "' + id + '": ' + erro.message);
    }
  }
  pendentes.clear();
}

setInterval(despacharFila, Math.max(5, cfg.midi.intervaloEnvioMs || 25)).unref();

/**
 * Chegou SysEx da mesa.
 *
 * Se alguem estiver calibrando pelo celular, o quadro vai para essa conversa.
 * Fora isso, se ele bater com o molde de algum controle ja calibrado, o estado
 * e atualizado e os celulares avisados: mexeu no send direto na mesa, o app
 * acompanha em vez de mostrar valor errado.
 */
function aoReceberDaMesa(bytes) {
  // Resposta ao pedido de leitura da criacao de canais: e so dela.
  const pendente = geracao && geracao.pendente;
  if (pendente) {
    const raw = mesa.lerValorDoFrame(pendente.candidato, bytes);
    if (raw !== null) {
      pendente.responder(raw);
      return;
    }
  }

  if (sessoes.size) {
    for (const [cliente, sessao] of sessoes) alimentarSessao(cliente, sessao, bytes);
    return;
  }

  const janela = cfg.midi.janelaEcoMs || 400;
  for (const controle of controles) {
    const raw = mesa.lerValorDoFrame(controle, bytes);
    if (raw === null) continue;

    // Se acabamos de mandar esse controle, o que voltou e eco do nosso proprio
    // envio. Aceitar isso faria o fader tremer na mao do usuario.
    const quando = ultimoEnvio.get(controle.id) || 0;
    if (Date.now() - quando < janela) return;

    const valor = mesa.escalarParaNormalizado(raw, controle.rawMin, controle.rawMax);
    estado.valores[controle.id] = valor;
    if (valor > 0) estado.mutes[controle.id] = false;

    transmitir({
      type: 'state',
      values: { [controle.id]: valor },
      mutes: { [controle.id]: estado.mutes[controle.id] }
    });
    agendarSalvamento();
    return;
  }
}

// ---------------------------------------------------------------------------
// Calibracao conduzida pelo celular
// ---------------------------------------------------------------------------

/**
 * Uma sessao por celular que estiver calibrando. Guarda o ultimo quadro que a
 * mesa mandou, que e justamente o valor em que o controle parou quando a
 * pessoa tirou a mao.
 */
const sessoes = new Map();

function alimentarSessao(cliente, sessao, bytes) {
  sessao.ultimoFrame = bytes;
  sessao.contagem++;

  // Feedback ao vivo ("a mesa esta falando"), no maximo cinco vezes por segundo.
  const agora = Date.now();
  if (agora - sessao.ultimoAviso < 200) return;
  sessao.ultimoAviso = agora;

  enviarPara(cliente, {
    type: 'learn:midi',
    count: sessao.contagem,
    hex: mesa.paraHex(bytes)
  });
}

function iniciarSessao(cliente, msg) {
  // Nao calibra enquanto cria canais (veja iniciarGeracao). "etapa" faz o app
  // voltar o assistente para o nome em vez de ficar esperando captura.
  if (geracao) {
    enviarPara(cliente, {
      type: 'learn:erro',
      message: 'Estou criando canais agora. Espere terminar para calibrar.',
      etapa: 'nome'
    });
    return;
  }
  sessoes.set(cliente, {
    idAtual: typeof msg.control === 'string' ? msg.control : null,
    rotulo: String(msg.label || '').trim().slice(0, 40),
    tipo: ['canal', 'reverb', 'master'].includes(msg.kind) ? msg.kind : 'canal',
    frameMin: null,
    frameMax: null,
    ultimoFrame: null,
    contagem: 0,
    ultimoAviso: 0
  });
  enviarPara(cliente, { type: 'learn:pronto-para', step: 'min' });
}

function capturarNaSessao(cliente, msg) {
  const sessao = sessoes.get(cliente);
  if (!sessao) return;

  if (!sessao.ultimoFrame) {
    enviarPara(cliente, {
      type: 'learn:erro',
      message:
        'Nenhuma mensagem chegou da mesa. Confira no menu MIDI da 01V96 se o ' +
        'Parameter Change TX esta ligado e se a porta e USB, e mexa no controle antes de tocar aqui.'
    });
    return;
  }

  const passo = msg.step === 'max' ? 'max' : 'min';
  if (passo === 'min') sessao.frameMin = sessao.ultimoFrame;
  else sessao.frameMax = sessao.ultimoFrame;

  const hex = mesa.paraHex(sessao.ultimoFrame);
  sessao.ultimoFrame = null;
  sessao.contagem = 0;

  enviarPara(cliente, {
    type: 'learn:capturado',
    step: passo,
    hex,
    proximo: passo === 'min' ? 'max' : 'fim'
  });
}

function salvarSessao(cliente) {
  const sessao = sessoes.get(cliente);
  if (!sessao) return;

  if (!sessao.frameMin || !sessao.frameMax) {
    enviarPara(cliente, { type: 'learn:erro', message: 'Faltou capturar o minimo ou o maximo.' });
    return;
  }

  const rotulo = sessao.rotulo || 'Controle';
  const id = configArquivo.idUnico(rotulo, controles, sessao.idAtual);

  let resultado;
  try {
    resultado = mesa.criarControle({
      id,
      rotulo,
      tipo: sessao.tipo,
      valorInicial: porId.get(sessao.idAtual)?.valorInicial ?? 0.5,
      frameMin: sessao.frameMin,
      frameMax: sessao.frameMax
    });
  } catch (erro) {
    enviarPara(cliente, { type: 'learn:erro', message: erro.message });
    return;
  }

  const controle = resultado.controle;

  try {
    gravarControles((lista) => {
      const i = lista.findIndex((c) => c.id === (sessao.idAtual || controle.id));
      if (i >= 0) lista[i] = controle;
      else lista.push(controle);
      return lista;
    });
  } catch (erro) {
    enviarPara(cliente, { type: 'learn:erro', message: 'Nao consegui salvar: ' + erro.message });
    return;
  }

  sessoes.delete(cliente);
  console.log('[learn] controle "' + controle.rotulo + '" calibrado (offset ' +
    controle.valueOffset + ', ' + controle.valueLength + ' byte(s), ' +
    controle.rawMin + ' a ' + controle.rawMax + ')');

  enviarPara(cliente, {
    type: 'learn:salvo',
    control: { id: controle.id, label: controle.rotulo, type: controle.tipo },
    faixa: { rawMin: controle.rawMin, rawMax: controle.rawMax },
    bytes: { offset: controle.valueOffset, length: controle.valueLength },
    avisos: resultado.avisos
  });

  anunciarControles();
}

function anunciarControles() {
  transmitir({ type: 'controls', controls: listaParaApp() });
  transmitir({ type: 'state', values: estado.valores, mutes: estado.mutes });
}

function statusAtual() {
  return {
    type: 'status',
    devolverMix: cfg.aplicarEstadoAoIniciar === true,
    midi: {
      simulado: saidaMidi.simulado,
      entradaSimulada: entradaMidi.simulado,
      saida: saidaMidi.nome,
      entrada: entradaMidi.nome,
      motivo: saidaMidi.motivo || null
    }
  };
}

function transmitirStatus() {
  transmitir(statusAtual());
}

// ---------------------------------------------------------------------------
// Criar os outros canais a partir de um canal calibrado
// ---------------------------------------------------------------------------

/**
 * Pelo formato do manual, o send do canal 5 tem o mesmo molde do canal 1, so
 * com outro byte de canal. Mas o programa nao confia nisso as cegas: para cada
 * canal ele manda um Parameter request (pedido de leitura, que nao mexe no
 * som) e so cria o controle se a mesa responder naquele endereco. O valor que
 * ela responde vira o valor inicial do fader. Uma geracao por vez, um pedido
 * por vez.
 */
let geracao = null;

function esperaResposta() {
  const ms = Number(cfg.midi.esperaRespostaMs);
  return Number.isFinite(ms) && ms > 0 ? Math.min(5000, Math.max(20, ms)) : 300;
}

/** A mesa em que a geracao comecou saiu do ar (porta trocada, simulada ou morta)? */
function mesaSaiuDoAr(g) {
  return (
    saidaMidi !== g.saida ||
    entradaMidi !== g.entrada ||
    saidaMidi.simulado ||
    entradaMidi.simulado ||
    saidaMidi.sumiu() ||
    entradaMidi.sumiu()
  );
}

function interromperGeracao(motivo) {
  if (!geracao || geracao.interrompido) return;
  geracao.interrompido = true;
  console.warn('[gerar] interrompido: ' + motivo);
  if (geracao.pendente) geracao.pendente.responder(null);
}

/** Algum controle da lista ja aponta para o endereco desse candidato? */
function enderecoJaExiste(lista, candidato) {
  const canal = mesa.canalDoControle(candidato);
  return lista.some(
    (c) =>
      mesa.mesmoEndereco(c, candidato) ||
      // Calibrado a mao com a janela do valor um pouco diferente: pelo manual,
      // mesmo cabecalho (F0 43 1n 3E 0D tt ee pp) e mesmo canal e o mesmo parametro.
      (canal !== null &&
        mesa.canalDoControle(c) === canal &&
        c.template.slice(0, 8).every((b, i) => b === candidato.template[i]))
  );
}

/** Espera a mesa responder o pedido. Registrada antes do envio: a resposta pode ser rapida. */
function esperarResposta(g, candidato) {
  return new Promise((ok) => {
    const timer = setTimeout(() => terminar(null), esperaResposta());
    function terminar(raw) {
      clearTimeout(timer);
      if (g.pendente === pendente) g.pendente = null;
      ok(raw);
    }
    const pendente = { candidato, responder: terminar };
    g.pendente = pendente;
  });
}

function recusarGeracao(cliente, message) {
  enviarPara(cliente, { type: 'gerar:erro', message });
}

function iniciarGeracao(cliente, msg) {
  if (geracao) {
    return recusarGeracao(cliente, 'Ja estou criando canais agora. Espere terminar e tente de novo.');
  }
  // Calibrar e criar canais nunca rodam juntos: uma resposta atrasada da mesa
  // cairia na calibracao e o controle ficaria com o endereco de outro canal.
  if (sessoes.size) {
    return recusarGeracao(cliente, 'Alguem esta calibrando um controle agora. Espere terminar e tente de novo.');
  }

  const original = porId.get(msg.base);
  if (!original) {
    return recusarGeracao(cliente, 'Nao achei esse controle. Atualize a tela e escolha de novo.');
  }
  if (!mesa.estaCalibrado(original)) {
    return recusarGeracao(cliente, 'Calibre este canal antes: ele e o modelo para os outros.');
  }
  if ((original.tipo || 'canal') !== 'canal') {
    return recusarGeracao(cliente, 'So da para criar canais a partir de um canal, nao de reverb nem do volume geral.');
  }
  const canalBase = mesa.canalDoControle(original);
  if (canalBase === null) {
    return recusarGeracao(cliente, 'Este controle nao esta no formato do manual da 01V96, calibre os canais um a um.');
  }
  if (saidaMidi.simulado || entradaMidi.simulado) {
    return recusarGeracao(cliente, 'Ligue a mesa no cabo USB: preciso que ela responda para conferir cada canal.');
  }

  const pedidos = msg.canais;
  if (
    !Array.isArray(pedidos) ||
    pedidos.length > mesa.TOTAL_CANAIS ||
    pedidos.some((n) => !Number.isInteger(n) || n < 1 || n > mesa.TOTAL_CANAIS)
  ) {
    return recusarGeracao(cliente, 'Escolha canais de 1 a ' + mesa.TOTAL_CANAIS + '.');
  }
  const canais = [...new Set(pedidos)].sort((a, b) => a - b);
  if (!canais.length) return recusarGeracao(cliente, 'Marque pelo menos um canal.');

  const base = { ...original, template: original.template.slice() };
  const jaExistiam = [];
  const fila = [];
  for (const canal of canais) {
    if (canal === canalBase || enderecoJaExiste(controles, mesa.controleParaCanal(base, canal))) {
      jaExistiam.push(canal);
    } else {
      fila.push(canal);
    }
  }

  const g = {
    cliente,
    base,
    fila,
    jaExistiam,
    confirmados: [],
    semResposta: [],
    feitos: 0,
    interrompido: false,
    concluida: false,
    pendente: null,
    saida: saidaMidi,
    entrada: entradaMidi
  };
  geracao = g;
  console.log('[gerar] a partir de "' + (base.rotulo || base.id) + '" (canal ' + canalBase + '): ' +
    fila.length + ' canal(is) para conferir com a mesa, ' + jaExistiam.length + ' ja existiam');

  rodarGeracao(g).catch((erro) => {
    // Erro no meio: salva o que a mesa ja confirmou, como numa interrupcao.
    console.error('[gerar] erro inesperado: ' + erro.message);
    g.interrompido = true;
    if (g.pendente) g.pendente.responder(null);
    try {
      if (g.concluida) throw erro; // o erro foi no proprio fim: nao grava duas vezes
      concluirGeracao(g);
    } catch (erroNoFim) {
      console.error('[gerar] nao consegui terminar: ' + erroNoFim.message);
      enviarPara(g.cliente, { type: 'gerar:erro', message: 'Algo deu errado ao criar os canais: ' + erroNoFim.message });
    }
  }).finally(() => {
    if (geracao === g) geracao = null;
  });
}

async function rodarGeracao(g) {
  for (const canal of g.fila) {
    if (g.interrompido) break;
    if (mesaSaiuDoAr(g)) {
      interromperGeracao('a mesa saiu do ar');
      break;
    }

    const candidato = mesa.controleParaCanal(g.base, canal);
    const resposta = esperarResposta(g, candidato);
    // Protecao: daqui so sai pedido de leitura (byte 2 = 3n), nunca Parameter change.
    g.saida.enviar(mesa.montarPedido(g.base, canal));
    const raw = await resposta;

    if (g.interrompido) break;
    if (raw === null && mesaSaiuDoAr(g)) {
      interromperGeracao('a mesa saiu do ar');
      break;
    }

    if (raw === null) g.semResposta.push(canal);
    else g.confirmados.push({ canal, candidato, raw });
    g.feitos++;

    enviarPara(g.cliente, {
      type: 'gerar:progresso',
      canal,
      feitos: g.feitos,
      total: g.fila.length,
      confirmado: raw !== null
    });
  }

  concluirGeracao(g);
}

/** Grava o que a mesa confirmou, mesmo se parou no meio. */
function concluirGeracao(g) {
  g.concluida = true;
  geracao = null;

  const novos = [];
  const jaNaLista = [];
  if (g.confirmados.length) {
    try {
      gravarControles((lista) => {
        for (const { canal, candidato, raw } of g.confirmados) {
          // Alguem pode ter calibrado esse canal enquanto a mesa respondia.
          if (enderecoJaExiste(lista, candidato)) {
            jaNaLista.push(canal);
            continue;
          }
          const rotulo = 'Canal ' + canal;
          const controle = {
            id: configArquivo.idUnico(rotulo, lista),
            rotulo,
            tipo: 'canal',
            valorInicial: typeof g.base.valorInicial === 'number' ? g.base.valorInicial : 0.5,
            ...candidato,
            geradoDe: g.base.id
          };
          lista.push(controle);
          novos.push({ controle, canal, raw });
        }
        return lista;
      });
    } catch (erro) {
      console.error('[gerar] nao consegui salvar: ' + erro.message);
      enviarPara(g.cliente, { type: 'gerar:erro', message: 'Nao consegui salvar os canais: ' + erro.message });
      return;
    }
  }

  // O app so espelha a mesa: o valor que ela respondeu vira o do fader, e
  // nada e mandado de volta para ela.
  const criados = [];
  for (const { controle, canal, raw } of novos) {
    estado.valores[controle.id] = mesa.escalarParaNormalizado(raw, controle.rawMin, controle.rawMax);
    estado.mutes[controle.id] = false;
    criados.push({ id: controle.id, label: controle.rotulo, canal });
  }
  if (criados.length) agendarSalvamento();

  const jaExistiam = g.jaExistiam.concat(jaNaLista).sort((a, b) => a - b);
  console.log('[gerar] ' + criados.length + ' criado(s), ' + g.semResposta.length + ' sem resposta, ' +
    jaExistiam.length + ' ja existiam' + (g.interrompido ? ', interrompido' : ''));
  if (!g.confirmados.length && g.semResposta.length) {
    console.warn('[gerar] a mesa nao respondeu nenhum pedido: confira Parameter Change RX ligado e Rx CH igual ao Device ID');
  }

  enviarPara(g.cliente, {
    type: 'gerar:fim',
    criados,
    semResposta: g.semResposta.slice(),
    jaExistiam,
    interrompido: g.interrompido
  });
  anunciarControles();
}

// ---------------------------------------------------------------------------
// Servidor HTTP (o app em si)
// ---------------------------------------------------------------------------

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function responderJson(res, dados, status = 200) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(corpo),
    'Cache-Control': 'no-store'
  });
  res.end(corpo);
}

function listaParaApp() {
  return controles.map((c) => {
    const item = {
      id: c.id,
      label: c.rotulo || c.id,
      type: c.tipo || 'canal',
      calibrated: mesa.estaCalibrado(c)
    };
    // "canal" so aparece quando da para criar os outros a partir deste.
    const canal = item.type === 'canal' ? mesa.canalDoControle(c) : null;
    if (canal !== null) item.canal = canal;
    return item;
  });
}

const servidor = http.createServer((req, res) => {
  let caminhoUrl;
  try {
    caminhoUrl = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  } catch {
    res.writeHead(400);
    res.end('URL invalida');
    return;
  }

  // Entrada de mesa simulada: so existe quando nao ha porta MIDI de verdade.
  // E o que permite testar a calibracao inteira sem estar perto da 01V96.
  if (caminhoUrl === '/api/simular' && req.method === 'POST') {
    if (!entradaMidi.simulado) {
      responderJson(res, { erro: 'a entrada MIDI e real, nada a simular' }, 409);
      return;
    }
    let corpo = '';
    req.on('data', (p) => {
      corpo += p;
      if (corpo.length > 8192) req.destroy();
    });
    req.on('end', () => {
      try {
        const { hex } = JSON.parse(corpo);
        const bytes = String(hex).trim().split(/[\s,]+/).map((b) => parseInt(b, 16));
        if (!bytes.length || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
          responderJson(res, { erro: 'hex invalido' }, 400);
          return;
        }
        aoReceberDaMesa(bytes);
        responderJson(res, { ok: true, bytes: bytes.length });
      } catch (erro) {
        responderJson(res, { erro: erro.message }, 400);
      }
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Metodo nao suportado');
    return;
  }

  if (caminhoUrl === '/api/controls') {
    responderJson(res, { controls: listaParaApp() });
    return;
  }
  if (caminhoUrl === '/api/status') {
    const portas = listarPortas();
    responderJson(res, {
      versao: lerVersao(),
      midi: {
        saida: saidaMidi.nome,
        entrada: entradaMidi.nome,
        simulado: saidaMidi.simulado,
        entradaSimulada: entradaMidi.simulado,
        motivo: saidaMidi.motivo || null,
        portasVistas: portas.saidas
      },
      maquina: {
        sistema: process.platform,
        node: process.version,
        ligadoHa: Math.round(process.uptime()) + 's'
      },
      controles: controles.length,
      naoCalibrados,
      clientes: wss ? wss.clients.size : 0,
      avisos
    });
    return;
  }

  if (caminhoUrl === '/') caminhoUrl = '/index.html';

  const destino = path.normalize(path.join(DIR_PUBLIC, caminhoUrl));
  if (destino !== DIR_PUBLIC && !destino.startsWith(DIR_PUBLIC + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acesso negado');
    return;
  }

  fs.stat(destino, (erro, info) => {
    if (erro || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Nao encontrado');
      return;
    }

    const tipo = TIPOS[path.extname(destino).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': tipo,
      'Content-Length': info.size,
      'Cache-Control': 'no-cache'
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const fluxo = fs.createReadStream(destino);
    fluxo.on('error', () => res.end());
    fluxo.pipe(res);
  });
});

// ---------------------------------------------------------------------------
// WebSocket (tempo real)
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: servidor });

function enviarPara(cliente, objeto) {
  if (cliente.readyState === cliente.OPEN) {
    cliente.send(JSON.stringify(objeto));
  }
}

/** Manda para todos, com a opcao de pular quem originou a mudanca. */
function transmitir(objeto, exceto = null) {
  const texto = JSON.stringify(objeto);
  for (const cliente of wss.clients) {
    if (cliente === exceto) continue;
    if (cliente.readyState === cliente.OPEN) cliente.send(texto);
  }
}

wss.on('connection', (cliente, req) => {
  const origem = (req.socket.remoteAddress || '?').replace('::ffff:', '');
  console.log('[ws] celular conectado: ' + origem + ' (total: ' + wss.clients.size + ')');

  cliente.vivo = true;
  cliente.on('pong', () => { cliente.vivo = true; });

  // Sequencia de boas vindas: lista de faders, situacao do MIDI e estado atual.
  enviarPara(cliente, { type: 'controls', controls: listaParaApp() });
  enviarPara(cliente, statusAtual());
  enviarPara(cliente, { type: 'state', values: estado.valores, mutes: estado.mutes });

  cliente.on('message', (dados) => {
    let msg;
    try {
      msg = JSON.parse(dados.toString());
    } catch {
      return; // mensagem invalida: ignora em silencio
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'set': {
        const controle = porId.get(msg.control);
        if (!controle) return;

        const valor = mesa.limitar01(msg.value);
        estado.valores[controle.id] = valor;

        // Mexer no fader tira o mudo: e o gesto natural de quem quer ouvir.
        if (estado.mutes[controle.id] && valor > 0) estado.mutes[controle.id] = false;

        agendarEnvio(controle.id);
        agendarSalvamento();

        transmitir(
          {
            type: 'state',
            values: { [controle.id]: valor },
            mutes: { [controle.id]: estado.mutes[controle.id] }
          },
          cliente
        );
        return;
      }

      case 'mute': {
        const controle = porId.get(msg.control);
        if (!controle) return;

        estado.mutes[controle.id] = msg.muted === true;
        agendarEnvio(controle.id);
        agendarSalvamento();

        transmitir(
          { type: 'state', values: {}, mutes: { [controle.id]: estado.mutes[controle.id] } },
          cliente
        );
        return;
      }

      case 'learn:iniciar':
        iniciarSessao(cliente, msg);
        return;

      case 'learn:capturar':
        capturarNaSessao(cliente, msg);
        return;

      case 'learn:salvar':
        salvarSessao(cliente);
        return;

      case 'learn:cancelar':
        sessoes.delete(cliente);
        return;

      case 'controle:remover': {
        if (!porId.has(msg.control)) return;
        try {
          gravarControles((lista) => lista.filter((c) => c.id !== msg.control));
          delete estado.valores[msg.control];
          delete estado.mutes[msg.control];
          anunciarControles();
        } catch (erro) {
          // controle:erro aparece na tela; learn:erro so dentro do assistente.
          enviarPara(cliente, { type: 'controle:erro', message: 'Nao consegui salvar: ' + erro.message });
        }
        return;
      }

      // So o nome muda: id, calibracao e o valor no fone continuam iguais.
      case 'controle:renomear': {
        const rotulo = typeof msg.label === 'string' ? msg.label.trim().slice(0, 40).trim() : '';
        if (!porId.has(msg.control)) {
          enviarPara(cliente, { type: 'controle:erro', message: 'Nao achei esse controle. Atualize a tela.' });
          return;
        }
        if (!rotulo) {
          enviarPara(cliente, { type: 'controle:erro', message: 'Escreva um nome para o controle.' });
          return;
        }
        try {
          gravarControles((lista) => lista.map((c) => (c.id === msg.control ? { ...c, rotulo } : c)));
        } catch (erro) {
          enviarPara(cliente, { type: 'controle:erro', message: 'Nao consegui salvar: ' + erro.message });
          return;
        }
        anunciarControles();
        return;
      }

      case 'gerar:canais':
        iniciarGeracao(cliente, msg);
        return;

      // Escolher a porta da mesa pelo celular, para nunca precisar editar
      // arquivo na maquina do rack.
      case 'midi:portas': {
        const portas = listarPortas();
        enviarPara(cliente, {
          type: 'midi:portas',
          entradas: portas.entradas,
          saidas: portas.saidas,
          escolhida: cfg.midi.saida || null
        });
        return;
      }

      case 'midi:usar': {
        const escolha = typeof msg.porta === 'string' && msg.porta.trim() ? msg.porta.trim() : null;
        try {
          const atual = configArquivo.carregar();
          atual.midi.saida = escolha;
          atual.midi.entrada = escolha;
          configArquivo.salvar(atual);
        } catch (erro) {
          enviarPara(cliente, { type: 'learn:erro', message: 'Nao consegui salvar: ' + erro.message });
          return;
        }

        cfg.midi.saida = escolha;
        cfg.midi.entrada = escolha;

        interromperGeracao('a porta da mesa foi trocada');
        try { saidaMidi.fechar(); } catch { /* ignora */ }
        try { entradaMidi.fechar(); } catch { /* ignora */ }
        saidaMidi = abrirSaida(cfg.midi.saida);
        entradaMidi = abrirEntrada(cfg.midi.entrada, aoReceberDaMesa);

        console.log('[midi] porta escolhida pelo celular: ' + (escolha || 'automatica'));
        contarMidi(false);
        transmitirStatus();
        return;
      }

      // Devolver o mix quando a mesa liga, escolhido pelo celular, para
      // ninguem precisar editar o config.json no PC da mesa.
      case 'config:devolverMix': {
        const ligado = msg.ligado === true;
        try {
          const atual = configArquivo.carregar();
          atual.aplicarEstadoAoIniciar = ligado;
          configArquivo.salvar(atual);
        } catch (erro) {
          enviarPara(cliente, { type: 'learn:erro', message: 'Nao consegui salvar: ' + erro.message });
          return;
        }
        cfg.aplicarEstadoAoIniciar = ligado;
        transmitirStatus();
        return;
      }

      case 'ping':
        enviarPara(cliente, { type: 'pong' });
        return;
    }
  });

  cliente.on('close', () => {
    sessoes.delete(cliente);
    if (geracao && geracao.cliente === cliente) {
      console.log('[gerar] o celular que pediu saiu; termino e salvo o que a mesa confirmar');
    }
    console.log('[ws] celular saiu: ' + origem + ' (total: ' + wss.clients.size + ')');
  });

  cliente.on('error', (erro) => {
    sessoes.delete(cliente);
    console.warn('[ws] erro no cliente ' + origem + ': ' + erro.message);
  });
});

// Celular que dormiu ou saiu do Wi-Fi nem sempre fecha a conexao direito.
// O ping periodico limpa esses fantasmas.
setInterval(() => {
  for (const cliente of wss.clients) {
    if (cliente.vivo === false) {
      cliente.terminate();
      continue;
    }
    cliente.vivo = false;
    try { cliente.ping(); } catch { /* ignora */ }
  }
}, 20000).unref();

// ---------------------------------------------------------------------------
// Persistencia do mix
// ---------------------------------------------------------------------------

let timerSalvar = null;
function agendarSalvamento() {
  if (timerSalvar) return;
  timerSalvar = setTimeout(() => {
    timerSalvar = null;
    configArquivo.salvarEstado(estado);
  }, 2000);
  timerSalvar.unref();
}

// ---------------------------------------------------------------------------
// Inicializacao
// ---------------------------------------------------------------------------

const porta = cfg.servidor.porta || 8080;
const host = cfg.servidor.host || '0.0.0.0';

servidor.on('error', (erro) => {
  if (erro.code === 'EADDRINUSE') {
    console.error('A porta ' + porta + ' ja esta em uso. Mude "servidor.porta" no config.json.');
  } else {
    console.error('Erro no servidor: ' + erro.message);
  }
  process.exit(1);
});

servidor.listen(porta, host, () => {
  console.log('');
  console.log('Monitor 01V96 no ar');
  console.log('  neste computador ... http://localhost:' + porta);
  for (const ip of enderecosLocais()) {
    console.log('  pelo celular ....... http://' + ip + ':' + porta);
  }
  console.log('  controles .......... ' + controles.length);
  if (naoCalibrados.length) {
    console.log('  falta calibrar ..... ' + naoCalibrados.length +
      ' (da para fazer pelo proprio celular, no botao de ajustes)');
  }
  if (!midiDisponivel()) {
    console.log('  midi ............... indisponivel (' + mensagemErroMidi() + ')');
  }
  console.log('');

  // Opcional: reenviar o mix salvo para a mesa ao ligar a maquina.
  if (cfg.aplicarEstadoAoIniciar) {
    for (const c of controles) if (mesa.estaCalibrado(c)) agendarEnvio(c.id);
    console.log('[midi] reaplicando o ultimo mix salvo na mesa');
  }
});

/** IPs da maquina, para voce saber o que digitar no celular. */
function enderecosLocais() {
  const os = require('os');
  const lista = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const rede of interfaces || []) {
      if (rede.family === 'IPv4' && !rede.internal) lista.push(rede.address);
    }
  }
  return lista;
}

function encerrar() {
  console.log('\nEncerrando...');
  despacharFila();
  configArquivo.salvarEstado(estado);
  try { saidaMidi.fechar(); } catch { /* ignora */ }
  try { entradaMidi.fechar(); } catch { /* ignora */ }
  for (const cliente of wss.clients) {
    try { cliente.close(1001, 'servidor encerrando'); } catch { /* ignora */ }
  }
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
