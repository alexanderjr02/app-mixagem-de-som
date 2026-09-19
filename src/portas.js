'use strict';
/**
 * portas.js
 * Utilitario rapido: "npm run portas" mostra as portas MIDI que o sistema ve.
 * Serve para voce descobrir o nome exato da 01V96 e colocar no config.json.
 */

const { listarPortas, midiDisponivel, mensagemErroMidi } = require('./midi-io');

if (!midiDisponivel()) {
  console.log('O pacote nativo "midi" nao esta disponivel nesta maquina.');
  console.log('Motivo: ' + mensagemErroMidi());
  console.log('');
  console.log('No Raspberry Pi instale antes:');
  console.log('  sudo apt install -y build-essential libasound2-dev');
  console.log('  npm install');
  process.exit(1);
}

const { entradas, saidas } = listarPortas();

console.log('');
console.log('Entradas MIDI (mesa -> computador):');
if (!entradas.length) console.log('  nenhuma');
entradas.forEach((nome, i) => console.log('  [' + i + '] ' + nome));

console.log('');
console.log('Saidas MIDI (computador -> mesa):');
if (!saidas.length) console.log('  nenhuma');
saidas.forEach((nome, i) => console.log('  [' + i + '] ' + nome));

console.log('');
console.log('No config.json use o indice (ex: 1) ou parte do nome (ex: "01V96").');
console.log('');
