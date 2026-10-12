'use strict';
/**
 * testes.js - roda as suites de teste.
 *
 * Duas suites:
 *
 *   rapida    test/ (descoberta padrao do "node --test"). E EXATAMENTE o que o
 *             PC da igreja roda no preparo de uma versao nova (o atualizador
 *             chama "node --test" sem argumentos, com teto de 10 min, e teste
 *             que falha recusa a versao de vez). So teste rapido e
 *             deterministico: mapa, mesa, bridge, config, MIDI e as decisoes
 *             do atualizador.
 *
 *   completa  verificacao-completa/*.verifica.js. Lenta e dependente de
 *             Windows/PowerShell (atualizador de verdade, "atualizar agora",
 *             instalador). O nome .verifica.js e a pasta ficam fora da
 *             descoberta padrao, entao o PC da igreja nunca roda isto. Roda
 *             aqui, antes de publicar.
 *
 * Uso:
 *   npm test               (node scripts/testes.js)            as duas, em paralelo
 *   npm run test:rapido    (node --test)                       so a rapida, como a igreja
 *   npm run test:completo  (node scripts/testes.js --completa) so a completa
 *
 * Os arquivos sao listados aqui (e nao por glob na linha de comando) para
 * funcionar em qualquer Node >= 18, e vao todos para um "node --test" so.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');

/** Arquivos .js/.cjs/.mjs dentro de dir (recursivo), em ordem, relativos a RAIZ. */
function listar(dir, filtro) {
  const saida = [];
  const andar = (rel) => {
    let itens;
    try { itens = fs.readdirSync(path.join(RAIZ, rel), { withFileTypes: true }); } catch { return; }
    for (const i of itens.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = path.join(rel, i.name);
      if (i.isDirectory()) andar(r);
      else if (filtro.test(i.name)) saida.push(r);
    }
  };
  andar(dir);
  return saida;
}

// A rapida: tudo que a descoberta padrao pega dentro de test/ (qualquer .js la dentro).
const rapida = listar('test', /\.(c|m)?js$/);
const completa = listar('verificacao-completa', /\.verifica\.(c|m)?js$/);

const soCompleta = process.argv.includes('--completa');
const arquivos = soCompleta ? completa : [...rapida, ...completa];
if (!arquivos.length) {
  console.error('nenhum arquivo de teste encontrado');
  process.exitCode = 1;
} else {
  console.log('suite ' + (soCompleta ? 'completa' : 'rapida + completa') + ': ' + arquivos.length + ' arquivo(s)');
  const r = spawnSync(process.execPath, ['--test', ...arquivos], { cwd: RAIZ, stdio: 'inherit' });
  process.exitCode = r.status === null ? 1 : r.status;
}
