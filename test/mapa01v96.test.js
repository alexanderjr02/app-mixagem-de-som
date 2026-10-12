'use strict';
/**
 * Testes do mapa da 01V96 (src/mapa01v96.js e a tabela gerada). Os enderecos
 * esperados aqui foram copiados a mao do message-types.ts do kryops/remote-mixer
 * (commit f8bb91e), para conferir a tabela gerada por outro caminho.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mapa = require('../src/mapa01v96');
const mesa = require('../src/yamaha01v96');

test('a tabela gerada tem os enderecos do remote-mixer que o bridge usa', () => {
  assert.equal(mapa.TOTAL_ENTRADAS, 3030);
  const esperado = {
    'kInputAUX/kAUX1On': [127, 1, 35, 0],
    'kInputAUX/kAUX1Pre': [127, 1, 35, 1],
    'kInputAUX/kAUX1Level': [127, 1, 35, 2],
    'kInputAUX/kAUX8On': [127, 1, 35, 21],
    'kInputAUX/kAUX8Level': [127, 1, 35, 23],
    'kAUXChannelOn/kChannelOn': [127, 1, 54, 0],
    'kAUXFader/kFader': [127, 1, 57, 0],
    'kInputFader/kFader': [127, 1, 28, 0],
    'kInputChannelName/kChannelNameLong1': [13, 2, 4, 4],
    'kInputChannelName/kChannelNameLong16': [13, 2, 4, 19],
    'kAUXModuleName/kAUXModuleNameLong1': [13, 2, 16, 4],
    'kAUXModuleName/kAUXModuleNameLong16': [13, 2, 16, 19],
    'kSetupMIDISetup/kFaderResolution': [13, 3, 94, 0],
    'kSceneTitle/kTitle1': [127, 1, 1, 0]
  };
  for (const [tipo, bytes] of Object.entries(esperado)) assert.deepEqual(mapa.endereco(tipo), bytes, tipo);
  // Nivel do Aux a: pp = 3a - 1; On: pp = 3a - 3 (padrao da tabela).
  for (let a = 1; a <= 8; a++) {
    assert.deepEqual(mapa.endereco(mapa.TIPO.send(a)), [127, 1, 35, 3 * a - 1]);
    assert.deepEqual(mapa.endereco(mapa.TIPO.sendOn(a)), [127, 1, 35, 3 * a - 3]);
  }
  assert.equal(mapa.endereco('kHuiPanel/kNuendoEncAsgn4'), null, 'byte acima de 127 ficou de fora');
  assert.equal(mapa.endereco('naoExiste'), null);
});

test('Parameter request: F0 43 3n 3E, endereco, canal - 1 e F7, com o n da rota', () => {
  assert.equal(mesa.paraHex(mapa.montarPedido('kInputAUX/kAUX3Level', 5, 2)), 'F0 43 32 3E 7F 01 23 08 04 F7');
  assert.equal(mesa.paraHex(mapa.montarPedido('kSetupMIDISetup/kFaderResolution', 1, 15)), 'F0 43 3F 3E 0D 03 5E 00 00 F7');
  for (const ruim of [[-1], [16], [1.5], [null]]) {
    assert.throws(() => mapa.montarPedido('kAUXFader/kFader', 1, ruim[0]), /Device number/);
  }
  assert.throws(() => mapa.montarPedido('kAUXFader/kFader', 0, 0), /Canal/);
  assert.throws(() => mapa.montarPedido('kAUXFader/kFader', 129, 0), /Canal/);
  assert.throws(() => mapa.montarPedido('inventado', 1, 0), /fora do mapa/);
  for (const item of mapa.ESPELHO) {
    const q = mapa.montarPedido(item.tipo, item.canal, 7);
    assert.equal(q.length, 10);
    assert.equal(q[2], 0x37, 'pedido sempre 3n');
  }
});

test('Parameter change: fader em 4 bytes, On e caractere no ultimo byte', () => {
  assert.equal(mesa.paraHex(mapa.montarMudanca('kInputAUX/kAUX3Level', 5, mapa.dadosDoFader(255), 2)),
    'F0 43 12 3E 7F 01 23 08 04 00 00 01 7F F7');
  assert.equal(mesa.paraHex(mapa.montarMudanca('kAUXFader/kFader', 8, mapa.dadosDoFader(1023), 0)),
    'F0 43 10 3E 7F 01 39 00 07 00 00 07 7F F7');
  assert.deepEqual(mapa.dadosDoOn(true), [0, 0, 0, 1]);
  assert.deepEqual(mapa.dadosDoOn(false), [0, 0, 0, 0]);
  assert.deepEqual(mapa.dadosDoCaractere('A'), [0, 0, 0, 0x41]);
  assert.deepEqual(mapa.dadosDoCaractere('\u00e7'), [0, 0, 0, 0x20], 'fora do ASCII vira espaco');
  assert.throws(() => mapa.dadosDoFader(1024), /0 a 1023/);
  assert.throws(() => mapa.dadosDoFader(-1), /0 a 1023/);
  assert.throws(() => mapa.montarMudanca('kAUXFader/kFader', 1, [0, 0, 1, 128], 0), /Dados invalidos/);
  for (let v = 0; v <= 1023; v++) assert.equal(mapa.faderDosDados(mapa.dadosDoFader(v)), v);
});

test('identificar: tipo, canal e dados, ignorando o n do device', () => {
  const q = [0xf0, 0x43, 0x1b, 0x3e, 0x7f, 0x01, 0x23, 0x08, 0x04, 0x00, 0x00, 0x01, 0x00, 0xf7];
  assert.deepEqual(mapa.identificar(q),
    { tipo: 'kInputAUX/kAUX3Level', canal: 5, dados: [0, 0, 1, 0], pedido: false, dispositivo: 11 });
  assert.deepEqual(mapa.identificar([0xf0, 0x43, 0x30, 0x3e, 0x0d, 0x02, 0x10, 0x04, 0x02, 0xf7]),
    { tipo: 'kAUXModuleName/kAUXModuleNameLong1', canal: 3, dados: [], pedido: true, dispositivo: 0 });
  // O que nao e da tabela ou nao e da Yamaha nao vira nada.
  for (const ruim of [
    [0xf0, 0x41, 0x10, 0x3e, 0x7f, 0x01, 0x23, 0x08, 0x04, 0, 0, 1, 0, 0xf7],
    [0xf0, 0x43, 0x10, 0x3e, 0x7f, 0x01, 0x7e, 0x7e, 0x04, 0, 0, 1, 0, 0xf7],
    [0xf0, 0x43, 0x20, 0x3e, 0x7f, 0x01, 0x23, 0x08, 0x04, 0, 0, 1, 0, 0xf7],
    [0xf0, 0x43, 0x10, 0x3e, 0x7f, 0x01, 0x23, 0x08, 0x04, 0, 0, 1, 0x80, 0xf7],
    [0xf0, 0x43, 0x10, 0x3e, 0x7f, 0x01, 0x23, 0x08, 0x04, 0xf7],
    [0xf0, 0x43, 0x30, 0x3e, 0x7f, 0x01, 0x23, 0x08, 0x04, 0x00, 0xf7],
    [0xc0, 0x02], null, 'x'
  ]) {
    assert.equal(mapa.identificar(ruim), null, JSON.stringify(ruim));
  }
  assert.equal(mapa.faderDosDados([0, 1, 0, 0]), null, 'byte alto diferente de zero');
  assert.equal(mapa.faderDosDados([0, 0, 1]), null);
  assert.equal(mapa.onDosDados([0, 0, 0, 1]), true);
  assert.equal(mapa.onDosDados([0, 0, 0, 0]), false);
  assert.equal(mapa.caractereDosDados([0, 0, 0, 0x5a]), 'Z');
  assert.equal(mapa.caractereDosDados([0, 0, 0, 0x05]), ' ');
});

test('valorPlausivel: On, master On e resolucao so 0 ou 1; fader ate 1023; letra ASCII', () => {
  for (const campo of ['on', 'masterOn', 'resolucao']) {
    assert.deepEqual([0, 1, 2, 127, -1, 1.5].map((n) => mapa.valorPlausivel(campo, n)), [true, true, false, false, false, false], campo);
  }
  for (const campo of ['valor', 'master']) {
    assert.deepEqual([0, 255, 1023, 1024, -1].map((n) => mapa.valorPlausivel(campo, n)), [true, true, true, false, false], campo);
  }
  for (const campo of ['nomeCanal', 'nomeAux']) {
    assert.deepEqual([0x20, 0x7f, 0x80].map((n) => mapa.valorPlausivel(campo, n)), [true, true, false], campo);
  }
  assert.equal(mapa.valorPlausivel('inventado', 0), false);
  assert.equal(mapa.valorPlausivel('on', null), false);
});

test('rawDoFader: 0..1 na escala, nunca acima do maximo', () => {
  assert.equal(mapa.rawDoFader(1, 255), 255);
  assert.equal(mapa.rawDoFader(0.5, 255), 128);
  assert.equal(mapa.rawDoFader(1, 1023), 1023);
  assert.equal(mapa.rawDoFader(7, 255), 255);
  assert.equal(mapa.rawDoFader(-3, 1023), 0);
  assert.equal(mapa.rawDoFader('x', 255), 0);
  assert.throws(() => mapa.rawDoFader(1, 1000), /Escala/);
});

test('o espelho tem tudo que o fone precisa, uma vez cada, e so os fones sao gravaveis', () => {
  const itens = mapa.ESPELHO;
  assert.equal(itens.length, 1 + 8 * 18 + 32 * 32);
  assert.equal(new Set(itens.map((i) => i.chave)).size, itens.length);
  assert.equal(itens[0].campo, 'resolucao');
  const contar = (campo) => itens.filter((i) => i.campo === campo).length;
  assert.deepEqual(['valor', 'on', 'master', 'masterOn', 'nomeCanal', 'nomeAux'].map(contar), [256, 256, 8, 8, 512, 128]);
  const send = mapa.ESPELHO_POR_CHAVE.get('kInputAUX/kAUX3Level#5');
  assert.deepEqual({ campo: send.campo, aux: send.aux, canalDoFone: send.canalDoFone }, { campo: 'valor', aux: 3, canalDoFone: 5 });
  assert.deepEqual(['valor', 'on', 'master', 'masterOn', 'nomeCanal', 'nomeAux', 'resolucao'].map(mapa.ehGravavel),
    [true, true, true, true, false, false, false]);
});

test('molde do teste da mesa funciona com as funcoes de controle calibrado', () => {
  const molde = mapa.moldeDoTipo(mapa.TESTE_DE_ROTA.tipo, mapa.TESTE_DE_ROTA.canal);
  assert.equal(mesa.estaCalibrado(molde), true);
  assert.equal(mesa.paraHex(mesa.montarPedidoDoControle(molde, 3)), 'F0 43 33 3E 7F 01 23 02 00 F7');
  const resposta = [0xf0, 0x43, 0x15, 0x3e, 0x7f, 0x01, 0x23, 0x02, 0x00, 0x00, 0x00, 0x01, 0x40, 0xf7];
  assert.equal(mesa.lerValorDoFrame(molde, resposta), 192, 'o n da resposta nao conta');
  assert.equal(mesa.lerValorDoFrame(molde, resposta.slice(0, 12).concat([0xf7])), null);
  assert.equal(mesa.canalDoControle(molde), 1);
});
