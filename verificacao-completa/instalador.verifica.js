'use strict';
/**
 * Roda o instalador de verdade (instalar/windows.ps1) numa pasta temporaria,
 * offline: -PastaOrigem/-ShaOrigem no lugar do download, e -SemDependencias
 * (so existe para teste) no lugar do `npm ci`. Nada de tarefa agendada, de
 * firewall ou de atalho de inicializacao (-SemTarefa -SemFirewall -SemIniciar).
 *
 * Nunca toca na instalacao real em %LOCALAPPDATA%\Monitor01V96.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const INSTALADOR = path.join(RAIZ, 'instalar', 'windows.ps1');
const SKIP = process.platform === 'win32' ? false : 'o instalador e do Windows (PowerShell)';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const CONFIG = Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]), // BOM de proposito
  Buffer.from('{\r\n  "servidor": { "porta": 18765, "host": "127.0.0.1" },\r\n  "nome": "Culto ção"  \r\n}\r\n')
]);
const ESTADO = Buffer.from('{"valores":{"voz":0.3},"mutes":{}}\n\n');
const NOTAS = Buffer.from('anotacoes do tecnico\r\nnao apagar\r\n');

/** Projeto minimo no formato do repositorio (com o lancador de verdade). */
function escreverOrigem(pasta) {
  fs.mkdirSync(path.join(pasta, 'src'), { recursive: true });
  fs.mkdirSync(path.join(pasta, 'instalar'), { recursive: true });
  fs.mkdirSync(path.join(pasta, 'test'), { recursive: true });
  fs.writeFileSync(path.join(pasta, 'src', 'bridge.js'), '// bridge novo\n');
  fs.writeFileSync(path.join(pasta, 'package.json'), JSON.stringify({ name: 'monitor-01v96', version: '1.0.0' }));
  fs.writeFileSync(path.join(pasta, 'README.md'), 'novo');
  fs.writeFileSync(path.join(pasta, 'config.example.json'), '{}');
  fs.copyFileSync(path.join(RAIZ, 'instalar', 'iniciar.js'), path.join(pasta, 'instalar', 'iniciar.js'));
  fs.writeFileSync(path.join(pasta, 'test', 'a.test.js'), '');
}

/** Instalacao no layout ANTIGO: codigo solto na raiz, junto dos dados. */
function escreverLegado(pasta, nomeDoPacote = 'monitor-01v96') {
  fs.mkdirSync(path.join(pasta, 'src'), { recursive: true });
  fs.mkdirSync(path.join(pasta, 'public'), { recursive: true });
  fs.mkdirSync(path.join(pasta, 'node_modules', 'ws'), { recursive: true });
  fs.writeFileSync(path.join(pasta, 'src', 'bridge.js'), '// bridge antigo\n');
  fs.writeFileSync(path.join(pasta, 'public', 'index.html'), 'antigo');
  fs.writeFileSync(path.join(pasta, 'node_modules', 'ws', 'index.js'), '');
  fs.writeFileSync(path.join(pasta, 'package.json'), JSON.stringify({ name: nomeDoPacote }));
  fs.writeFileSync(path.join(pasta, 'README.md'), 'antigo');
  fs.writeFileSync(path.join(pasta, 'config.json'), CONFIG);
  fs.writeFileSync(path.join(pasta, 'config.json.bak'), 'bak');
  fs.writeFileSync(path.join(pasta, 'estado.json'), ESTADO);
  fs.writeFileSync(path.join(pasta, 'atualizacao.log'), 'log antigo\n');
  fs.writeFileSync(path.join(pasta, 'minhas-notas.txt'), NOTAS);
}

function instalar(dest, origem, sha) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', INSTALADOR,
    '-PastaDestino', dest, '-Ramo', 'main', '-SemTarefa', '-SemFirewall', '-SemIniciar', '-SemDependencias',
    '-PastaOrigem', origem, '-ShaOrigem', sha], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  return { codigo: r.status, saida: (r.stdout || '') + (r.stderr || '') };
}

function cenario(nome, fn) {
  test('instalador: ' + nome, { skip: SKIP, timeout: 400000 }, async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-instalador-João-')));
    const origem = path.join(base, 'origem');
    const dest = path.join(base, 'dest');
    escreverOrigem(origem);
    fs.mkdirSync(dest);
    try { await fn({ base, origem, dest }); } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
}

const lerJson = (arq) => JSON.parse(fs.readFileSync(arq, 'utf8').replace(/^﻿/, ''));
const nomes = (dir) => fs.readdirSync(dir).sort();

function dadosIntactos(dest) {
  assert.equal(Buffer.compare(fs.readFileSync(path.join(dest, 'config.json')), CONFIG), 0, 'config.json mudou');
  assert.equal(Buffer.compare(fs.readFileSync(path.join(dest, 'estado.json')), ESTADO), 0, 'estado.json mudou');
  assert.equal(fs.readFileSync(path.join(dest, 'config.json.bak'), 'utf8'), 'bak');
  assert.equal(Buffer.compare(fs.readFileSync(path.join(dest, 'minhas-notas.txt')), NOTAS), 0, 'arquivo do usuario mudou');
}

cenario('migra o layout antigo, preserva dados e arquivo do usuario, e reinstalar a mesma versao mantem a anterior', ({ origem, dest }) => {
  escreverLegado(dest);

  const r1 = instalar(dest, origem, SHA_A);
  assert.equal(r1.codigo, 0, r1.saida);
  dadosIntactos(dest);
  assert.equal(fs.readFileSync(path.join(dest, 'atualizacao.log'), 'utf8'), 'log antigo\n');
  assert.deepEqual(nomes(dest), ['Monitor01V96-atualizar.vbs', 'Monitor01V96-iniciar.vbs', 'atualizacao.json', 'atualizacao.log',
    'config.json', 'config.json.bak', 'estado.json', 'iniciar.js', 'minhas-notas.txt', 'versoes'].sort(), 'codigo antigo saiu da raiz');
  assert.deepEqual(nomes(path.join(dest, 'versoes')), [SHA_A]);
  assert.equal(fs.readFileSync(path.join(dest, 'versoes', SHA_A, 'src', 'bridge.js'), 'utf8'), '// bridge novo\n');
  const e1 = lerJson(path.join(dest, 'atualizacao.json'));
  assert.equal(e1.atual, SHA_A);
  assert.equal(e1.anterior, null);
  assert.equal(e1.emTroca, null);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(dest, 'iniciar.js')), fs.readFileSync(path.join(RAIZ, 'instalar', 'iniciar.js'))), 0);
  // VBS em UTF-16 (BOM FF FE), por causa do "João" no caminho
  assert.deepEqual([...fs.readFileSync(path.join(dest, 'Monitor01V96-iniciar.vbs')).subarray(0, 2)], [0xff, 0xfe]);

  // Planta uma versao anterior e reinstala a MESMA versao: a anterior tem que ficar.
  fs.mkdirSync(path.join(dest, 'versoes', SHA_B, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'versoes', SHA_B, 'src', 'bridge.js'), '// b\n');
  fs.writeFileSync(path.join(dest, 'atualizacao.json'), JSON.stringify({ ...e1, anterior: SHA_B, recusadas: [SHA_C] }));
  const r2 = instalar(dest, origem, SHA_A);
  assert.equal(r2.codigo, 0, r2.saida);
  dadosIntactos(dest);
  const e2 = lerJson(path.join(dest, 'atualizacao.json'));
  assert.equal(e2.atual, SHA_A);
  assert.equal(e2.anterior, SHA_B, 'reinstalar a mesma versao preserva a anterior');
  assert.deepEqual(e2.recusadas, [SHA_C], 'e as recusadas');
  assert.deepEqual(nomes(path.join(dest, 'versoes')), [SHA_A, SHA_B].sort());

  // Versao nova de verdade: a atual vira anterior.
  const r3 = instalar(dest, origem, SHA_C);
  assert.equal(r3.codigo, 0, r3.saida);
  const e3 = lerJson(path.join(dest, 'atualizacao.json'));
  assert.equal(e3.atual, SHA_C);
  assert.equal(e3.anterior, SHA_A);
  assert.deepEqual(nomes(path.join(dest, 'versoes')), [SHA_A, SHA_C].sort(), 'B foi limpa');
  dadosIntactos(dest);
});

cenario('instalacao nova (so dados na pasta): cria versoes, lancador e ponteiro', ({ origem, dest }) => {
  fs.writeFileSync(path.join(dest, 'config.json'), CONFIG);
  fs.writeFileSync(path.join(dest, 'estado.json'), ESTADO);
  const r = instalar(dest, origem, SHA_A);
  assert.equal(r.codigo, 0, r.saida);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(dest, 'config.json')), CONFIG), 0);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(dest, 'estado.json')), ESTADO), 0);
  assert.equal(lerJson(path.join(dest, 'atualizacao.json')).atual, SHA_A);
  assert.ok(fs.existsSync(path.join(dest, 'iniciar.js')));
});

cenario('recusa instalar numa pasta que e um repositorio git e nao mexe em nada', ({ origem, dest }) => {
  escreverLegado(dest);
  fs.mkdirSync(path.join(dest, '.git'));
  fs.writeFileSync(path.join(dest, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const antes = nomes(dest);
  const r = instalar(dest, origem, SHA_A);
  assert.notEqual(r.codigo, 0, 'tem que falhar');
  assert.match(r.saida, /repositorio git/);
  assert.deepEqual(nomes(dest), antes);
  assert.equal(fs.existsSync(path.join(dest, 'versoes')), false);
  dadosIntactos(dest);
});

cenario('src/bridge.js de outro projeto na pasta: instala em versoes\\ mas nao apaga o que nao e nosso', ({ origem, dest }) => {
  escreverLegado(dest, 'outro-projeto');
  const r = instalar(dest, origem, SHA_A);
  assert.equal(r.codigo, 0, r.saida);
  assert.match(r.saida, /nao parece ser do Monitor/);
  assert.equal(fs.readFileSync(path.join(dest, 'src', 'bridge.js'), 'utf8'), '// bridge antigo\n');
  assert.equal(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), 'antigo');
  assert.ok(fs.existsSync(path.join(dest, 'node_modules', 'ws', 'index.js')));
  dadosIntactos(dest);
  assert.deepEqual(nomes(path.join(dest, 'versoes')), [SHA_A]);
});
