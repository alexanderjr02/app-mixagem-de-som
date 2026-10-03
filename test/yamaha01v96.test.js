'use strict';
/**
 * Testes do formato SysEx: e aqui que um byte errado mexeria no parametro
 * errado da mesa, entao a regra central e "so a janela do valor muda".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mesa = require('../src/yamaha01v96');

// Quadros no formato do exemplo do README: endereco fixo e o valor em 2 bytes
// a partir do offset 9. Nao sao bytes conferidos numa 01V96 de verdade; os
// testes verificam as regras, nao o endereco de um parametro especifico.
const MINIMO = [0xf0, 0x43, 0x10, 0x3e, 0x0d, 0x01, 0x1c, 0x00, 0x00, 0x00, 0x00, 0xf7];
const MAXIMO = [0xf0, 0x43, 0x10, 0x3e, 0x0d, 0x01, 0x1c, 0x00, 0x00, 0x01, 0x7f, 0xf7];

function bumbo() {
  return mesa.criarControle({
    id: 'bumbo',
    rotulo: 'Bumbo',
    tipo: 'canal',
    frameMin: MINIMO,
    frameMax: MAXIMO
  }).controle;
}

test('codificar e decodificar voltam ao mesmo numero, em 7 bits', () => {
  for (const tamanho of [1, 2, 3, 4]) {
    const maximo = Math.pow(128, tamanho) - 1;
    for (const n of [0, 1, 127, 128, 255, 1023, 16383, maximo]) {
      if (n > maximo) continue;
      const bytes = mesa.codificarValor(n, tamanho);
      assert.equal(bytes.length, tamanho);
      assert.ok(bytes.every((b) => b >= 0 && b <= 0x7f), 'byte de dados acima de 0x7F: ' + bytes);
      assert.equal(mesa.decodificarValor(bytes), n);
    }
  }
  assert.deepEqual(mesa.codificarValor(255, 2), [0x01, 0x7f]);
});

test('codificar prende o valor dentro do que cabe nos bytes', () => {
  assert.deepEqual(mesa.codificarValor(300, 1), [0x7f]);
  assert.deepEqual(mesa.codificarValor(-5, 2), [0, 0]);
});

test('limitar01 nunca deixa passar lixo vindo do celular', () => {
  assert.equal(mesa.limitar01(NaN), 0);
  assert.equal(mesa.limitar01(undefined), 0);
  assert.equal(mesa.limitar01('abc'), 0);
  assert.equal(mesa.limitar01(Infinity), 0);
  assert.equal(mesa.limitar01(-1), 0);
  assert.equal(mesa.limitar01(2), 1);
  assert.equal(mesa.limitar01('0.5'), 0.5);
});

test('escala de 0..1 para o valor da mesa e de volta', () => {
  assert.equal(mesa.escalarParaRaw(0, 0, 255), 0);
  assert.equal(mesa.escalarParaRaw(1, 0, 255), 255);
  for (const v of [0, 0.1, 0.33, 0.5, 0.9, 1]) {
    const raw = mesa.escalarParaRaw(v, 0, 255);
    assert.ok(Math.abs(mesa.escalarParaNormalizado(raw, 0, 255) - v) <= 1 / 255);
  }
});

test('faixa invertida (maximo capturado com numero menor) tambem funciona', () => {
  assert.equal(mesa.escalarParaRaw(0, 255, 0), 255);
  assert.equal(mesa.escalarParaRaw(1, 255, 0), 0);
  assert.equal(mesa.escalarParaNormalizado(0, 255, 0), 1);
});

test('faixa de largura zero nao divide por zero', () => {
  assert.equal(mesa.escalarParaNormalizado(10, 10, 10), 0);
});

test('calibracao acha o valor no offset 9, com 2 bytes, de 0 a 255', () => {
  const { controle, avisos } = mesa.criarControle({
    id: 'bumbo',
    rotulo: 'Bumbo',
    frameMin: MINIMO,
    frameMax: MAXIMO
  });
  assert.equal(controle.valueOffset, 9);
  assert.equal(controle.valueLength, 2);
  assert.equal(controle.rawMin, 0);
  assert.equal(controle.rawMax, 255);
  assert.equal(controle.tipo, 'canal');
  assert.equal(controle.calibrado, true);
  assert.deepEqual(avisos, []);
  assert.deepEqual(controle.template, MINIMO);
  assert.notEqual(controle.template, MINIMO, 'o template precisa ser copia, nao o mesmo array');
  assert.deepEqual(mesa.validarControle(controle), []);
});

test('nenhum quadro enviado muda bytes fora da janela do valor', () => {
  const c = bumbo();
  const valores = [-1, NaN, 2, 'lixo'];
  for (let i = 0; i <= 100; i++) valores.push(i / 100);

  for (const v of valores) {
    const frame = mesa.montarFrame(c, v);
    assert.equal(frame.length, MINIMO.length);
    assert.equal(frame[0], 0xf0);
    assert.equal(frame[frame.length - 1], 0xf7);
    for (let i = 0; i < frame.length; i++) {
      const naJanela = i >= c.valueOffset && i < c.valueOffset + c.valueLength;
      if (!naJanela) assert.equal(frame[i], MINIMO[i], 'byte ' + i + ' mudou com valor ' + v);
      if (i > 0 && i < frame.length - 1) assert.ok(frame[i] <= 0x7f);
    }
  }
});

test('montar nao altera o template guardado', () => {
  const c = bumbo();
  mesa.montarFrame(c, 1);
  assert.deepEqual(c.template, MINIMO);
});

test('os extremos do fader reproduzem exatamente o que a mesa mandou', () => {
  const c = bumbo();
  assert.deepEqual(mesa.montarFrame(c, 0), MINIMO);
  assert.deepEqual(mesa.montarFrame(c, 1), MAXIMO);
});

test('controle sem calibracao nao monta quadro nenhum', () => {
  assert.throws(
    () => mesa.montarFrame({ id: 'guitarra', calibrado: false }, 0.5),
    /guitarra.*nao foi calibrado/
  );
});

test('estaCalibrado recusa controles incompletos', () => {
  const c = bumbo();
  assert.equal(mesa.estaCalibrado(c), true);
  assert.equal(mesa.estaCalibrado(null), false);
  assert.equal(mesa.estaCalibrado({ ...c, calibrado: 'true' }), false);
  assert.equal(mesa.estaCalibrado({ ...c, template: undefined }), false);
  assert.equal(mesa.estaCalibrado({ ...c, valueLength: 0 }), false);
  assert.equal(mesa.estaCalibrado({ ...c, valueOffset: 9.5 }), false);
  assert.equal(mesa.estaCalibrado({ ...c, rawMax: NaN }), false);
});

test('ler da mesa reconhece o proprio controle e devolve o valor', () => {
  const c = bumbo();
  assert.equal(mesa.lerValorDoFrame(c, MAXIMO), 255);
  assert.equal(mesa.lerValorDoFrame(c, MINIMO), 0);
  for (const v of [0.2, 0.5, 0.75]) {
    const raw = mesa.lerValorDoFrame(c, mesa.montarFrame(c, v));
    assert.ok(Math.abs(mesa.escalarParaNormalizado(raw, c.rawMin, c.rawMax) - v) <= 1 / 255);
  }
});

test('ler da mesa ignora quadros de outro parametro', () => {
  const c = bumbo();
  const outroCanal = MAXIMO.slice();
  outroCanal[6] = 0x1d;
  assert.equal(mesa.lerValorDoFrame(c, outroCanal), null);
  assert.equal(mesa.lerValorDoFrame(c, MAXIMO.slice(0, -1)), null);
  assert.equal(mesa.lerValorDoFrame({ id: 'x', calibrado: false }, MAXIMO), null);
});

test('comparar quadros iguais explica que o controle nao mexeu', () => {
  assert.throws(() => mesa.compararFrames(MINIMO, MINIMO.slice()), /identicos/);
});

test('comparar quadros de tamanhos diferentes aponta controles trocados', () => {
  assert.throws(() => mesa.compararFrames(MINIMO, MAXIMO.slice(1)), /tamanhos diferentes/);
  assert.throws(() => mesa.compararFrames(null, MAXIMO), /invalidos/);
});

test('comparar avisa quando os bytes que mudaram nao sao vizinhos', () => {
  const max = MINIMO.slice();
  max[7] = 0x01;
  max[10] = 0x7f;
  const r = mesa.compararFrames(MINIMO, max);
  assert.equal(r.valueOffset, 7);
  assert.equal(r.valueLength, 4);
  assert.ok(r.avisos.some((a) => a.includes('nao sao vizinhos')));
});

test('comparar avisa quando o controle nao foi ate os extremos', () => {
  const max = MINIMO.slice();
  max[10] = 0x02;
  const r = mesa.compararFrames(MINIMO, max);
  assert.ok(r.avisos.some((a) => a.includes('bem pequena')));
});

test('validarControle aponta config.json quebrado', () => {
  const c = bumbo();
  assert.ok(mesa.validarControle({ ...c, valueOffset: 10 }).some((p) => p.includes('fora do corpo')));
  assert.ok(mesa.validarControle({ ...c, valueOffset: 0 }).some((p) => p.includes('fora do corpo')));

  const byteRuim = c.template.slice();
  byteRuim[3] = 0x80;
  assert.ok(mesa.validarControle({ ...c, template: byteRuim }).some((p) => p.includes('maior que 0x7F')));

  const semF7 = c.template.slice(0, -1).concat(0x00);
  assert.ok(mesa.validarControle({ ...c, template: semF7 }).some((p) => p.includes('F7')));

  assert.ok(mesa.validarControle({ ...c, rawMax: 0 }).some((p) => p.includes('iguais')));
  assert.deepEqual(mesa.validarControle({ id: 'x' }), ['controle sem calibracao completa']);
});

test('paraHex mostra os bytes do jeito do terminal', () => {
  assert.equal(mesa.paraHex([0xf0, 0x43, 0x0a, 0xf7]), 'F0 43 0A F7');
});

// ---------------------------------------------------------------------------
// Criar os outros canais (formato do manual: F0 43 1n 3E 0D|7F tt ee pp cc dd.. F7)
// ---------------------------------------------------------------------------

/** O bumbo com outros bytes no template (o resto da calibracao igual). */
function comTemplate(mudancas, extra = {}) {
  const template = MINIMO.slice();
  for (const [i, b] of Object.entries(mudancas)) template[i] = b;
  return { ...bumbo(), template, ...extra };
}

test('canalDoControle le o byte cc do formato do manual (canal 1 = 0x00)', () => {
  assert.equal(mesa.canalDoControle(bumbo()), 1);
  assert.equal(mesa.canalDoControle(comTemplate({ 8: 0x04 })), 5);
  assert.equal(mesa.canalDoControle(comTemplate({ 8: 0x1f })), 32);
  // O manual aceita 0D e 7F no byte 4, e qualquer device number em 1n.
  assert.equal(mesa.canalDoControle(comTemplate({ 4: 0x7f })), 1);
  assert.equal(mesa.canalDoControle(comTemplate({ 2: 0x1f, 8: 0x02 })), 3);
});

test('canalDoControle recusa o que nao da para trocar so o canal com seguranca', () => {
  assert.equal(mesa.canalDoControle({ ...bumbo(), calibrado: false }), null);
  assert.equal(mesa.canalDoControle(null), null);
  assert.equal(mesa.canalDoControle(comTemplate({ 8: 0x20 })), null, 'cc acima de 31');
  assert.equal(mesa.canalDoControle(comTemplate({ 4: 0x0e })), null, 'byte 4 fora de 0D/7F');
  assert.equal(mesa.canalDoControle(comTemplate({ 3: 0x3f })), null, 'outro modelo de mesa');
  assert.equal(mesa.canalDoControle(comTemplate({ 1: 0x41 })), null, 'outro fabricante');
  assert.equal(mesa.canalDoControle(comTemplate({ 2: 0x30 })), null, 'quadro de pedido, nao de mudanca');
  assert.equal(mesa.canalDoControle(comTemplate({ 0: 0xf1 })), null, 'nao comeca com F0');
  // O valor precisa morar depois do byte do canal.
  assert.equal(mesa.canalDoControle({ ...bumbo(), valueOffset: 8 }), null);
  assert.equal(mesa.canalDoControle({ ...bumbo(), valueOffset: 7, valueLength: 4 }), null);
  // Curto demais para ter tt ee pp cc e um byte de valor.
  const curto = [0xf0, 0x43, 0x10, 0x3e, 0x0d, 0x01, 0x1c, 0x00, 0x00, 0xf7];
  assert.equal(mesa.canalDoControle({ ...bumbo(), template: curto, valueOffset: 8, valueLength: 1 }), null);
});

test('controleParaCanal troca so o byte do canal e nao mexe no original', () => {
  const base = bumbo();
  const c5 = mesa.controleParaCanal(base, 5);
  assert.deepEqual(c5, {
    calibrado: true,
    template: [0xf0, 0x43, 0x10, 0x3e, 0x0d, 0x01, 0x1c, 0x00, 0x04, 0x00, 0x00, 0xf7],
    valueOffset: 9,
    valueLength: 2,
    rawMin: 0,
    rawMax: 255
  });
  assert.deepEqual(base.template, MINIMO);
  assert.equal(mesa.canalDoControle(c5), 5);
  assert.deepEqual(mesa.validarControle(c5), []);
  // O fader do canal novo manda o mesmo quadro do canal base, so com o cc trocado.
  assert.deepEqual(mesa.montarFrame(c5, 1), [0xf0, 0x43, 0x10, 0x3e, 0x0d, 0x01, 0x1c, 0x00, 0x04, 0x01, 0x7f, 0xf7]);
});

test('controleParaCanal e montarPedido recusam canal fora de 1..32 e formato estranho', () => {
  for (const canal of [0, 33, 1.5, '2', null]) {
    assert.throws(() => mesa.controleParaCanal(bumbo(), canal), /Canal fora/);
    assert.throws(() => mesa.montarPedido(bumbo(), canal), /Canal fora/);
  }
  const estranho = comTemplate({ 4: 0x0e });
  assert.throws(() => mesa.controleParaCanal(estranho, 2), /formato do manual/);
  assert.throws(() => mesa.montarPedido(estranho, 2), /formato do manual/);
});

test('montarPedido e um Parameter request (3n) do mesmo endereco, sem valor', () => {
  assert.deepEqual(
    mesa.montarPedido(bumbo(), 1),
    [0xf0, 0x43, 0x30, 0x3e, 0x0d, 0x01, 0x1c, 0x00, 0x00, 0xf7]
  );
  assert.deepEqual(
    mesa.montarPedido(bumbo(), 32),
    [0xf0, 0x43, 0x30, 0x3e, 0x0d, 0x01, 0x1c, 0x00, 0x1f, 0xf7]
  );
  // Device number e o 7F do byte 4 vem do molde calibrado.
  assert.deepEqual(
    mesa.montarPedido(comTemplate({ 2: 0x1a, 4: 0x7f }), 3),
    [0xf0, 0x43, 0x3a, 0x3e, 0x7f, 0x01, 0x1c, 0x00, 0x02, 0xf7]
  );
});

test('mesmoEndereco compara tudo menos a janela do valor', () => {
  const base = bumbo();
  assert.equal(mesa.mesmoEndereco(base, mesa.controleParaCanal(base, 1)), true);
  assert.equal(mesa.mesmoEndereco(base, { ...base, template: MAXIMO }), true, 'so o valor muda');
  assert.equal(mesa.mesmoEndereco(base, mesa.controleParaCanal(base, 2)), false, 'outro canal');
  assert.equal(mesa.mesmoEndereco(base, comTemplate({ 6: 0x1d })), false, 'outro parametro');
  assert.equal(mesa.mesmoEndereco(base, { ...base, valueOffset: 10, valueLength: 1 }), false, 'outra janela');
  assert.equal(mesa.mesmoEndereco(base, { ...base, template: MINIMO.slice(1) }), false, 'outro tamanho');
  assert.equal(mesa.mesmoEndereco(base, { ...base, calibrado: false }), false);
  assert.equal(mesa.mesmoEndereco(null, base), false);
});
