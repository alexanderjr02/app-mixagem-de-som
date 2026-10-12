'use strict';
/**
 * mapa01v96.js
 * O "mapa" da 01V96: o endereco de cada parametro (tipo -> F0 43 1n 3E
 * <model> <tt> <ee> <pp> <cc> ...) e as funcoes puras em volta dele. Com o
 * mapa, o bridge le e escreve os sends dos fones sem calibrar nada.
 *
 * Creditos e licenca: a tabela (src/mapa01v96-tipos.js, gerada por
 * scripts/gerar-mapa01v96.js) e o jeito de codificar os valores (fader em 4
 * bytes, On e caractere no ultimo byte) vem do kryops/remote-mixer,
 * https://github.com/kryops/remote-mixer, de Michael Manzinger, licenca MIT
 * (o texto inteiro da licenca esta no cabecalho de src/mapa01v96-tipos.js).
 *
 * Formato (01V96 V2, Appendix C, p.313-314):
 *
 *   Parameter change:  F0 43 1n 3E <model> tt ee pp cc d1 d2 d3 d4 F7  (14 bytes)
 *   Parameter request: F0 43 3n 3E <model> tt ee pp cc F7              (10 bytes)
 *
 * n = device number (o da rota que o teste da mesa achou), cc = canal - 1.
 * A mesa responde ao pedido com o Parameter change do mesmo endereco; ao
 * LER, o n e ignorado (a resposta pode vir com o Rx CH ou com o Tx CH).
 *
 * O que nao esta em manual oficial nenhum (so na tabela do remote-mixer) e
 * hipotese ate a mesa responder: e por isso que o bridge so escreve num
 * endereco que respondeu a um pedido de leitura.
 */

const TABELA = require('./mapa01v96-tipos');

const INICIO = 0xf0;
const FIM = 0xf7;
const YAMAHA = 0x43;
const GRUPO = 0x3e;
const MUDANCA = 0x10;
const PEDIDO = 0x30;

const TOTAL_CANAIS = 32;
const TOTAL_AUX = 8;
const LETRAS_DO_NOME = 16;
const FADER_MAX = 1023; // 10 bits: o maximo que cabe nos 4 bytes do fader

const porTipo = new Map();
const porEndereco = new Map();
for (const [tipo, ...bytes] of TABELA) {
  porTipo.set(tipo, bytes);
  // Dois tipos de setup dividem o mesmo endereco na tabela: vale o primeiro.
  const k = bytes.join(',');
  if (!porEndereco.has(k)) porEndereco.set(k, tipo);
}

/** [model, tt, ee, pp] do tipo, ou null se ele nao esta na tabela. */
function endereco(tipo) {
  const e = porTipo.get(tipo);
  return e ? e.slice() : null;
}

function ehByte7(b) {
  return Number.isInteger(b) && b >= 0 && b <= 0x7f;
}

function exigir(tipo, canal, dispositivo) {
  const e = porTipo.get(tipo);
  if (!e) throw new Error('Tipo fora do mapa da 01V96: ' + tipo);
  if (!Number.isInteger(canal) || canal < 1 || canal > 128) throw new Error('Canal fora de 1 a 128: ' + canal);
  if (!Number.isInteger(dispositivo) || dispositivo < 0 || dispositivo > 15) {
    throw new Error('Device number fora de 0 a 15: ' + dispositivo);
  }
  return e;
}

/**
 * Parameter request (pedido de leitura): a mesa responde com o valor atual e
 * nada muda no som. "dispositivo" e o n da rota (0 a 15).
 */
function montarPedido(tipo, canal, dispositivo) {
  const e = exigir(tipo, canal, dispositivo);
  return [INICIO, YAMAHA, PEDIDO | dispositivo, GRUPO, ...e, canal - 1, FIM];
}

/** Parameter change: escreve "dados" (bytes de 7 bits) no endereco. */
function montarMudanca(tipo, canal, dados, dispositivo) {
  const e = exigir(tipo, canal, dispositivo);
  if (!Array.isArray(dados) || !dados.length || !dados.every(ehByte7)) {
    throw new Error('Dados invalidos para ' + tipo);
  }
  return [INICIO, YAMAHA, MUDANCA | dispositivo, GRUPO, ...e, canal - 1, ...dados, FIM];
}

/**
 * Quadro da Yamaha no formato do manual com endereco da tabela:
 * { tipo, canal (1..128), dados, pedido, dispositivo }. Senao, null.
 * O n do device so e devolvido, nunca conferido.
 */
function identificar(bytes) {
  if (!Array.isArray(bytes) || bytes.length < 10) return null;
  if (bytes[0] !== INICIO || bytes[1] !== YAMAHA || bytes[3] !== GRUPO || bytes[bytes.length - 1] !== FIM) return null;
  const status = bytes[2] & 0xf0;
  if (!Number.isInteger(bytes[2]) || (status !== MUDANCA && status !== PEDIDO)) return null;
  for (let i = 3; i < bytes.length - 1; i++) if (!ehByte7(bytes[i])) return null;
  const tipo = porEndereco.get(bytes.slice(4, 8).join(','));
  if (!tipo) return null;
  const pedido = status === PEDIDO;
  if (pedido && bytes.length !== 10) return null;
  if (!pedido && bytes.length < 11) return null;
  return {
    tipo,
    canal: bytes[8] + 1,
    dados: bytes.slice(9, -1),
    pedido,
    dispositivo: bytes[2] & 0x0f
  };
}

// ---------------------------------------------------------------------------
// Conversores (como no remote-mixer, converters.ts)
// ---------------------------------------------------------------------------

/** Fader de 10 bits em 4 bytes: 00 00 0000nnn 0nnnnnnn. Fora de 0..1023 e erro. */
function dadosDoFader(valor) {
  if (!Number.isInteger(valor) || valor < 0 || valor > FADER_MAX) throw new Error('Fader fora de 0 a 1023: ' + valor);
  return [0, 0, valor >> 7, valor & 0x7f];
}

/**
 * Inteiro dos 4 bytes de dados (fader, On, caractere, ajuste). Os dois
 * primeiros tem que ser zero; qualquer outra coisa nao e um valor que o
 * bridge entende (null).
 */
function inteiroDosDados(dados) {
  if (!Array.isArray(dados) || dados.length !== 4 || !dados.every(ehByte7)) return null;
  if (dados[0] !== 0 || dados[1] !== 0) return null;
  return (dados[2] << 7) + dados[3];
}

function faderDosDados(dados) {
  const n = inteiroDosDados(dados);
  return n === null || n > FADER_MAX ? null : n;
}

/** On no ultimo byte: 1 ligado, 0 desligado. */
function dadosDoOn(ligado) {
  return [0, 0, 0, ligado ? 1 : 0];
}

function onDosDados(dados) {
  const n = inteiroDosDados(dados);
  return n === null ? null : n !== 0;
}

/** Caractere ASCII no ultimo byte; fora do imprimivel vira espaco. */
function dadosDoCaractere(letra) {
  const c = typeof letra === 'string' && letra.length ? letra.charCodeAt(0) : 0x20;
  return [0, 0, 0, c >= 0x20 && c <= 0x7e ? c : 0x20];
}

function caractereDoCodigo(n) {
  return Number.isInteger(n) && n >= 0x20 && n <= 0x7e ? String.fromCharCode(n) : ' ';
}

function caractereDosDados(dados) {
  const n = inteiroDosDados(dados);
  return n === null ? null : caractereDoCodigo(n);
}

/** 0..1 -> valor cru do fader na escala (255 ou 1023), sem nunca passar do maximo. */
function rawDoFader(valor01, maximo) {
  if (maximo !== 255 && maximo !== FADER_MAX) throw new Error('Escala invalida: ' + maximo);
  const n = Number(valor01);
  const v = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  return Math.min(maximo, Math.max(0, Math.round(v * maximo)));
}

// ---------------------------------------------------------------------------
// Os tipos que o bridge usa e o espelho da mesa
// ---------------------------------------------------------------------------

const TIPO = {
  send: (aux) => 'kInputAUX/kAUX' + aux + 'Level',
  sendOn: (aux) => 'kInputAUX/kAUX' + aux + 'On',
  master: 'kAUXFader/kFader',
  masterOn: 'kAUXChannelOn/kChannelOn',
  nomeCanal: (letra) => 'kInputChannelName/kChannelNameLong' + letra,
  nomeAux: (letra) => 'kAUXModuleName/kAUXModuleNameLong' + letra,
  resolucao: 'kSetupMIDISetup/kFaderResolution'
};

function chave(tipo, canal) {
  return tipo + '#' + canal;
}

/**
 * Tudo que o bridge espelha da mesa, na ordem da leitura: a resolucao do
 * fader; de cada Aux o master, o On e o nome; de cada canal o nivel e o On do
 * send para os 8 Aux e o nome. Cada item:
 * { chave, tipo, canal, campo, aux, canalDoFone, letra }
 *   campo: 'resolucao' | 'master' | 'masterOn' | 'nomeAux' | 'valor' | 'on' | 'nomeCanal'
 */
function montarEspelho() {
  const itens = [];
  const add = (tipo, canal, extra) => {
    if (!porTipo.has(tipo)) throw new Error('Tipo do espelho fora da tabela: ' + tipo);
    itens.push({ chave: chave(tipo, canal), tipo, canal, aux: null, canalDoFone: null, letra: null, ...extra });
  };
  add(TIPO.resolucao, 1, { campo: 'resolucao' });
  for (let aux = 1; aux <= TOTAL_AUX; aux++) {
    add(TIPO.master, aux, { campo: 'master', aux });
    add(TIPO.masterOn, aux, { campo: 'masterOn', aux });
    for (let l = 1; l <= LETRAS_DO_NOME; l++) add(TIPO.nomeAux(l), aux, { campo: 'nomeAux', aux, letra: l });
  }
  for (let canal = 1; canal <= TOTAL_CANAIS; canal++) {
    for (let aux = 1; aux <= TOTAL_AUX; aux++) {
      add(TIPO.send(aux), canal, { campo: 'valor', aux, canalDoFone: canal });
      add(TIPO.sendOn(aux), canal, { campo: 'on', aux, canalDoFone: canal });
    }
    for (let l = 1; l <= LETRAS_DO_NOME; l++) add(TIPO.nomeCanal(l), canal, { campo: 'nomeCanal', canalDoFone: canal, letra: l });
  }
  return itens;
}

const ESPELHO = Object.freeze(montarEspelho().map((i) => Object.freeze(i)));
const ESPELHO_POR_CHAVE = new Map(ESPELHO.map((i) => [i.chave, i]));

/**
 * O valor lido faz sentido para o campo? On, master On e resolucao: so 0 ou 1;
 * fader: 0 a 1023; letra de nome: ASCII. Resposta fora disso nao confirma o
 * endereco (pode ser um endereco errado do mapa, que entao nunca e escrito).
 */
function valorPlausivel(campo, n) {
  if (!Number.isInteger(n) || n < 0) return false;
  if (campo === 'on' || campo === 'masterOn' || campo === 'resolucao') return n === 0 || n === 1;
  if (campo === 'valor' || campo === 'master') return n <= FADER_MAX;
  if (campo === 'nomeCanal' || campo === 'nomeAux') return n <= 0x7f;
  return false;
}

/** Campos que guardam um fader (valor de 0 a 255 ou 1023). */
function ehFader(campo) {
  return campo === 'valor' || campo === 'master';
}

/** Campos em que o bridge escreve (o resto e so leitura). */
function ehGravavel(campo) {
  return campo === 'valor' || campo === 'on' || campo === 'master' || campo === 'masterOn';
}

/**
 * Molde no formato de controle calibrado (src/yamaha01v96.js) para o teste
 * da mesa: com ele, montarPedidoDoControle e lerValorDoFrame funcionam sem
 * nenhum controle calibrado. So serve para pedir e reconhecer a resposta.
 */
function moldeDoTipo(tipo, canal) {
  const e = exigir(tipo, canal, 0);
  return {
    id: 'mapa:' + chave(tipo, canal),
    rotulo: tipo + ' canal ' + canal,
    tipo: 'mapa',
    calibrado: true,
    template: [INICIO, YAMAHA, MUDANCA, GRUPO, ...e, canal - 1, 0, 0, 0, 0, FIM],
    valueOffset: 9,
    valueLength: 4,
    rawMin: 0,
    rawMax: FADER_MAX
  };
}

/** O endereco do teste da mesa sem calibracao: send do canal 1 para o Aux 1. */
const TESTE_DE_ROTA = Object.freeze({ tipo: TIPO.send(1), canal: 1 });

module.exports = {
  TOTAL_ENTRADAS: TABELA.length,
  TOTAL_CANAIS,
  TOTAL_AUX,
  LETRAS_DO_NOME,
  FADER_MAX,
  TIPO,
  TESTE_DE_ROTA,
  ESPELHO,
  ESPELHO_POR_CHAVE,
  endereco,
  chave,
  montarPedido,
  montarMudanca,
  identificar,
  dadosDoFader,
  faderDosDados,
  inteiroDosDados,
  dadosDoOn,
  onDosDados,
  dadosDoCaractere,
  caractereDosDados,
  caractereDoCodigo,
  rawDoFader,
  valorPlausivel,
  ehFader,
  ehGravavel,
  moldeDoTipo
};
