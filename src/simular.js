'use strict';
/**
 * simular.js
 * "npm run simular": finge ser a 01V96, para voce testar tudo antes de estar
 * perto da mesa de verdade.
 *
 * Ele manda para o bridge mensagens SysEx no mesmo formato que a mesa manda
 * quando alguem mexe num send. Com isso da para percorrer a calibracao inteira
 * pelo celular, ver os faders mexendo e conferir a interface.
 *
 * So funciona quando o bridge esta com a entrada MIDI simulada, ou seja,
 * quando nao ha mesa nenhuma conectada. Com mesa de verdade ele se recusa.
 */

const readline = require('readline');
const configArquivo = require('./config');

const cfg = (() => {
  try {
    return configArquivo.carregar();
  } catch {
    return { servidor: { porta: 8080 } };
  }
})();

const BASE = process.env.BRIDGE || 'http://localhost:' + (cfg.servidor.porta || 8080);

// Um "canal" simulado e so um endereco diferente dentro do quadro.
const canais = [
  { nome: 'canal 1 (ex: Bumbo)', endereco: 0x1c },
  { nome: 'canal 2 (ex: Caixa)', endereco: 0x1d },
  { nome: 'canal 3 (ex: Baixo)', endereco: 0x1e },
  { nome: 'retorno de reverb', endereco: 0x2a },
  { nome: 'master do Aux', endereco: 0x30 }
];

let canalAtual = 0;
let valorAtual = 0;

/** Monta um quadro parecido com o Parameter Change da 01V96. */
function montarQuadro(endereco, valor) {
  const hi = (valor >> 7) & 0x7f;
  const lo = valor & 0x7f;
  return [0xf0, 0x43, 0x10, 0x3e, 0x0d, 0x01, endereco, 0x00, 0x00, hi, lo, 0xf7];
}

function paraHex(bytes) {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

async function enviar(bytes) {
  const resposta = await fetch(BASE + '/api/simular', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hex: paraHex(bytes) })
  });
  if (!resposta.ok) {
    const corpo = await resposta.json().catch(() => ({}));
    throw new Error(corpo.erro || 'o bridge respondeu ' + resposta.status);
  }
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Mexe o "fader" do valor atual ate o destino, mandando passos pelo caminho,
 * igual a mesa faz quando a pessoa arrasta o fader com a mao.
 */
async function mover(destino) {
  const endereco = canais[canalAtual].endereco;
  const passos = 24;
  const inicio = valorAtual;

  for (let i = 1; i <= passos; i++) {
    const valor = Math.round(inicio + ((destino - inicio) * i) / passos);
    await enviar(montarQuadro(endereco, valor));
    await espera(12);
  }

  valorAtual = destino;
  console.log('  ' + canais[canalAtual].nome + ' agora em ' + destino +
    '  (' + paraHex(montarQuadro(endereco, destino)) + ')');
}

function pergunta(rl, texto) {
  return new Promise((resolve) => rl.question(texto, (r) => resolve(r.trim())));
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('');
  console.log('Simulador da 01V96, falando com ' + BASE);
  console.log('Use junto com o app aberto no navegador para testar a calibracao.');

  try {
    await enviar(montarQuadro(canais[0].endereco, 0));
  } catch (erro) {
    console.log('');
    console.log('Nao consegui falar com o bridge: ' + erro.message);
    console.log('O bridge esta rodando (npm start) e sem mesa MIDI conectada?');
    rl.close();
    process.exit(1);
  }

  let sair = false;
  while (!sair) {
    console.log('');
    console.log('Simulando: ' + canais[canalAtual].nome + '  (valor ' + valorAtual + ')');
    console.log('  1  levar ao MINIMO');
    console.log('  2  levar ao MAXIMO');
    console.log('  3  levar ao meio');
    console.log('  4  trocar o controle simulado');
    console.log('  5  sair');

    const opcao = await pergunta(rl, 'Opcao: ');

    try {
      if (opcao === '1') await mover(0);
      else if (opcao === '2') await mover(255);
      else if (opcao === '3') await mover(128);
      else if (opcao === '4') {
        canais.forEach((c, i) => console.log('  [' + i + '] ' + c.nome));
        const n = Number(await pergunta(rl, 'Qual? '));
        if (canais[n]) {
          canalAtual = n;
          valorAtual = 0;
        }
      } else if (opcao === '5') sair = true;
    } catch (erro) {
      console.log('  erro: ' + erro.message);
    }
  }

  rl.close();
  process.exit(0);
}

main().catch((erro) => {
  console.error('Erro: ' + erro.message);
  process.exit(1);
});
