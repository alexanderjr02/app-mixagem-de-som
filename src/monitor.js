'use strict';
/**
 * monitor.js
 * "npm run monitor": imprime em hexadecimal todo SysEx que chegar da mesa.
 *
 * Para que serve na pratica: voce mexe num controle da 01V96 e ve na hora se a
 * mesa esta mesmo transmitindo Parameter Change. Se nao aparecer nada, o
 * problema esta na configuracao MIDI da mesa, nao no programa.
 *
 * Alem do hex, ele marca entre colchetes quais bytes mudaram em relacao a
 * mensagem anterior, que e exatamente o byte do valor do fader.
 */

const readline = require('readline');
const { listarPortas, abrirEntrada, midiDisponivel, mensagemErroMidi } = require('./midi-io');
const { paraHex } = require('./yamaha01v96');
const configArquivo = require('./config');

function pergunta(rl, texto) {
  return new Promise((resolve) => rl.question(texto, (resposta) => resolve(resposta.trim())));
}

function horaAgora() {
  const d = new Date();
  const p = (n, c = 2) => String(n).padStart(c, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
}

/** Monta o hex marcando com colchetes os bytes que mudaram. */
function hexComDiferencas(atual, anterior) {
  if (!anterior || anterior.length !== atual.length) return paraHex(atual);
  return atual
    .map((b, i) => {
      const hex = b.toString(16).toUpperCase().padStart(2, '0');
      return b !== anterior[i] ? '[' + hex + ']' : hex;
    })
    .join(' ');
}

async function main() {
  if (!midiDisponivel()) {
    console.log('O pacote nativo "midi" nao esta disponivel: ' + mensagemErroMidi());
    console.log('No Pi: sudo apt install -y build-essential libasound2-dev && npm install');
    process.exit(1);
  }

  const cfg = configArquivo.carregar();
  const { entradas } = listarPortas();

  if (!entradas.length) {
    console.log('Nenhuma entrada MIDI encontrada. A mesa esta ligada e conectada?');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('');
  console.log('Entradas MIDI disponiveis:');
  entradas.forEach((nome, i) => console.log('  [' + i + '] ' + nome));

  const sugerida = cfg.midi.entrada;
  const dica = sugerida !== null && sugerida !== undefined ? ' (Enter usa "' + sugerida + '")' : '';
  const resposta = await pergunta(rl, '\nQual entrada?' + dica + ' ');

  let escolha;
  if (!resposta && sugerida !== null && sugerida !== undefined) escolha = sugerida;
  else escolha = /^\d+$/.test(resposta) ? Number(resposta) : resposta;

  const porta = abrirEntrada(escolha, aoReceber);
  if (porta.simulado) {
    console.log('Nao consegui abrir a entrada: ' + porta.motivo);
    rl.close();
    process.exit(1);
  }

  console.log('');
  console.log('Escutando "' + porta.nome + '". Mexa nos controles da mesa.');
  console.log('Se nada aparecer, confira no menu MIDI da 01V96: Parameter Change TX ligado');
  console.log('e a porta MIDI definida como USB (ou MIDI, conforme sua ligacao).');
  console.log('Ctrl+C para sair.');
  console.log('');

  let anterior = null;
  let contador = 0;

  function aoReceber(bytes) {
    contador++;
    const linha =
      horaAgora() +
      '  ' +
      String(bytes.length).padStart(3) +
      ' bytes  ' +
      hexComDiferencas(bytes, anterior);
    console.log(linha);
    anterior = bytes;
  }

  const encerrar = () => {
    console.log('\n' + contador + ' mensagens SysEx recebidas. Ate mais.');
    porta.fechar();
    rl.close();
    process.exit(0);
  };

  process.on('SIGINT', encerrar);
  rl.on('close', () => {});
}

main().catch((erro) => {
  console.error('Erro: ' + erro.message);
  process.exit(1);
});
