'use strict';
/**
 * Testes da escolha automatica da porta. A regra que importa: achar a mesa
 * sozinho quando e obvio, e NAO chutar quando houver duvida.
 * Os nomes de porta sao exemplos; cada sistema escreve de um jeito.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { escolherAutomatica, aindaNaLista } = require('../src/midi-io');

/** Porta de mentira: so o suficiente para listar nomes. */
function portaCom(nomes) {
  return { getPortCount: () => nomes.length, getPortName: (i) => nomes[i] };
}

test('sem porta nenhuma, nao escolhe nada', () => {
  assert.equal(escolherAutomatica([]), -1);
});

test('ignora as portas que nunca sao a mesa', () => {
  assert.equal(escolherAutomatica(['Microsoft GS Wavetable Synth']), -1);
  assert.equal(escolherAutomatica(['Midi Through:Midi Through Port-0 14:0']), -1);
});

test('acha a 01V96 pelo nome, mesmo no meio de outras portas', () => {
  assert.equal(escolherAutomatica(['Microsoft GS Wavetable Synth', 'YAMAHA 01V96']), 1);
  assert.equal(escolherAutomatica(['Midi Through Port-0', 'Teclado USB', '01V96:01V96 MIDI 1 20:0']), 2);
  assert.equal(escolherAutomatica(['Launchpad', 'Yamaha USB-MIDI']), 1);
});

test('prefere o nome 01V96 a uma interface USB-MIDI generica', () => {
  assert.equal(escolherAutomatica(['USB MIDI Interface', 'YAMAHA 01V96']), 1);
});

test('aceita uma interface USB-MIDI generica (cabo nas tomadas MIDI da mesa)', () => {
  assert.equal(escolherAutomatica(['Launchpad', 'USB MIDI Interface']), 1);
});

test('se sobrar uma unica porta, usa ela', () => {
  assert.equal(escolherAutomatica(['Microsoft GS Wavetable Synth', 'Porta Qualquer']), 1);
});

test('na duvida entre aparelhos desconhecidos, nao chuta', () => {
  assert.equal(escolherAutomatica(['Launchpad', 'Minilab']), -1);
});

test('percebe quando a mesa some da lista (desligada ou cabo solto)', () => {
  assert.equal(aindaNaLista(portaCom(['Microsoft GS Wavetable Synth', 'YAMAHA 01V96']), 'YAMAHA 01V96'), true);
  assert.equal(aindaNaLista(portaCom(['Microsoft GS Wavetable Synth']), 'YAMAHA 01V96'), false);
  assert.equal(aindaNaLista(portaCom([]), 'YAMAHA 01V96'), false);
});

test('se nem listar as portas funciona, trata a mesa como perdida', () => {
  const quebrada = { getPortCount: () => { throw new Error('Internal RtMidi error'); } };
  assert.equal(aindaNaLista(quebrada, 'YAMAHA 01V96'), false);
});
