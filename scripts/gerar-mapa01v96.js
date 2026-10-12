'use strict';
/**
 * gerar-mapa01v96.js
 * Gera src/mapa01v96-tipos.js (a tabela de enderecos da 01V96) a partir do
 * message-types.ts do kryops/remote-mixer (licenca MIT, Michael Manzinger):
 * https://github.com/kryops/remote-mixer
 *
 * Uso (o arquivo .ts fica num clone do remote-mixer, fora deste projeto):
 *
 *   node scripts/gerar-mapa01v96.js <caminho do message-types.ts> <commit>
 *
 * Cada linha do .ts e "['tipo', [model, tt, ee, pp]]," e vira uma linha
 * "['tipo', model, tt, ee, pp]," no arquivo gerado. Nada e inventado: linha
 * fora desse formato ou tipo repetido faz o gerador parar sem gravar. As
 * entradas com algum byte acima de 127 (12 do painel HUI/Nuendo no commit
 * f8bb91e) ficam de fora: nao cabem num byte de dados MIDI, entao nenhum
 * quadro valido as usa. Rodar de novo com o mesmo commit da o mesmo arquivo.
 */

const fs = require('fs');
const path = require('path');

const DESTINO = path.resolve(__dirname, '..', 'src', 'mapa01v96-tipos.js');
const LINHA = /^\s*\['([A-Za-z0-9/_]+)', \[(\d{1,3}), (\d{1,3}), (\d{1,3}), (\d{1,3})\]\],?\s*$/;

const LICENCA = [
  'MIT License',
  '',
  'Copyright (c) 2021-2025 Michael Manzinger',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.'
];

/**
 * Le o .ts e devolve { entradas: [[tipo, model, tt, ee, pp], ...], descartadas }
 * na ordem do arquivo.
 */
function lerTabela(texto) {
  const entradas = [];
  const descartadas = [];
  const vistos = new Set();
  const linhas = texto.split(/\r?\n/);
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!/^\s*\['/.test(linha)) continue; // cabecalho, "])" do fim, linhas vazias
    const m = LINHA.exec(linha);
    if (!m) throw new Error('linha ' + (i + 1) + ' fora do formato esperado: ' + linha.trim());
    if (vistos.has(m[1])) throw new Error('linha ' + (i + 1) + ': tipo repetido ' + m[1]);
    vistos.add(m[1]);
    const bytes = m.slice(2, 6).map(Number);
    if (bytes.some((b) => b > 0x7f)) {
      descartadas.push(m[1]);
      continue;
    }
    entradas.push([m[1], ...bytes]);
  }
  if (!entradas.length) throw new Error('nenhuma entrada encontrada');
  return { entradas, descartadas };
}

function gerar({ entradas, descartadas }, commit) {
  const cabecalho = [
    "'use strict';",
    '/**',
    ' * mapa01v96-tipos.js - GERADO, nao edite a mao.',
    ' *',
    ' * Tabela de enderecos de parametro da Yamaha 01V96: cada linha e',
    ' * [tipo, model, tt, ee, pp], os bytes 4 a 7 de F0 43 1n 3E <model> <tt> <ee>',
    ' * <pp> <cc> ... F7 (model 0x7F = universal, 0x0D = so da 01V96).',
    ' *',
    ' * Origem: kryops/remote-mixer, https://github.com/kryops/remote-mixer',
    ' * arquivo backend/src/devices/yamaha-01v96/message-types.ts, commit',
    ' * ' + commit + '.',
    ' * Gerado por: node scripts/gerar-mapa01v96.js <message-types.ts> <commit>',
    ' * Entradas: ' + entradas.length + ' (de fora, com byte acima de 127: ' + descartadas.length + ').',
    ' *',
    ' * Licenca do original:',
    ' *',
    ...LICENCA.map((l) => (l ? ' * ' + l : ' *')),
    ' */',
    '',
    'module.exports = ['
  ];
  const corpo = entradas.map(([tipo, ...b]) => "  ['" + tipo + "', " + b.join(', ') + '],');
  return [...cabecalho, ...corpo, '];', ''].join('\n');
}

function main() {
  const [origem, commit] = process.argv.slice(2);
  if (!origem || !commit || !/^[0-9a-f]{7,40}$/.test(commit)) {
    console.error('Uso: node scripts/gerar-mapa01v96.js <caminho do message-types.ts> <commit do remote-mixer>');
    process.exitCode = 1;
    return;
  }
  const tabela = lerTabela(fs.readFileSync(origem, 'utf8'));
  fs.writeFileSync(DESTINO, gerar(tabela, commit));
  console.log('gravado ' + DESTINO + ' (' + tabela.entradas.length + ' entradas, ' +
    tabela.descartadas.length + ' de fora: ' + tabela.descartadas.join(', ') + ')');
}

if (require.main === module) main();

module.exports = { lerTabela, gerar };
