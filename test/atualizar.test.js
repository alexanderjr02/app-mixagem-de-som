'use strict';
/**
 * Testes da atualizacao automatica (src/atualizar.js + instalar/iniciar.js).
 *
 * Parte 1: funcoes puras (decisoes). Parte 2 (so Windows): roda o lancador e o
 * atualizar.js DE VERDADE contra um "GitHub" local (servidor http em 127.0.0.1
 * que serve o sha do ramo `igreja` e zips feitos aqui com Compress-Archive) e
 * uma instalacao temporaria no layout novo (iniciar.js + versoes\<sha>\) com um
 * projeto de mentirinha (bridge falso, uma dependencia local por tarball).
 *
 * Seguranca: nunca toca na pasta real de dados, em porta MIDI ou na instalacao
 * real em %LOCALAPPDATA%\Monitor01V96. Tudo mora em pastas temporarias (com
 * acento no nome, de proposito) e todo bridge falso, que o atualizador liga
 * "solto", e morto no fim de cada teste.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const at = require('../src/atualizar');

const RAIZ = path.resolve(__dirname, '..');
const WINDOWS = process.platform === 'win32';
const SO_WINDOWS = WINDOWS ? false : 'a atualizacao automatica so existe no Windows';

const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const SHA3 = '3'.repeat(40);

const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));

/* ======================= parte 1: funcoes puras ======================== */

test('shaValido: so 40 hexadecimais minusculos', () => {
  assert.equal(at.shaValido(SHA1), true);
  for (const ruim of ['', 'main', SHA1.slice(1), SHA1 + '0', 'G'.repeat(40), 'A'.repeat(40),
    SHA1.slice(0, 39) + '\n', '../' + SHA1, null, undefined, 123, {}]) {
    assert.equal(at.shaValido(ruim), false, String(ruim));
  }
});

test('deveConsultar: no maximo a cada 6 horas; falha de rede espera cada vez mais, ate 6 h', () => {
  const agora = Date.parse('2026-01-01T12:00:00Z');
  const h = 3600 * 1000;
  assert.equal(at.deveConsultar(null, agora), true);
  assert.equal(at.deveConsultar('lixo', agora), true);
  assert.equal(at.deveConsultar(new Date(agora - 5.99 * h).toISOString(), agora), false);
  assert.equal(at.deveConsultar(new Date(agora - 6 * h).toISOString(), agora), true);
  assert.equal(at.deveConsultar(new Date(agora + 5 * h).toISOString(), agora), true, 'relogio que voltou');

  const min = 60 * 1000;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9, 99].map(at.intervaloConsulta),
    [360 * min, 30 * min, 60 * min, 120 * min, 240 * min, 360 * min, 360 * min, 360 * min]);
});

test('seguroAplicar: so com bridge fora, ou mesa desligada e ninguem conectado', () => {
  assert.equal(at.seguroAplicar(null), true, 'bridge fora do ar');
  assert.equal(at.seguroAplicar({ midi: { simulado: true }, clientes: 0 }), true);
  assert.equal(at.seguroAplicar({ midi: { simulado: false }, clientes: 0 }), false, 'mesa ligada');
  assert.equal(at.seguroAplicar({ midi: { simulado: true }, clientes: 1 }), false, 'celular conectado');
  assert.equal(at.seguroAplicar({ midi: { simulado: false }, clientes: 2 }), false);
  for (const duvida of [{}, { midi: {} }, { clientes: 0 }, { midi: { simulado: true } },
    { midi: { simulado: 'true' }, clientes: 0 }, { midi: { simulado: true }, clientes: '0' }, undefined, 'x']) {
    assert.equal(at.seguroAplicar(duvida), false, JSON.stringify(duvida));
  }
});

test('so conexao RECUSADA conta como bridge fora do ar; timeout e erro estranho sao incerto', () => {
  const recusada = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
  const agregada = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('x'), { errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] })
  });
  const mista = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('x'), { errors: [{ code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }] })
  });
  assert.equal(at.conexaoRecusada(recusada), true);
  assert.equal(at.conexaoRecusada(agregada), true);
  assert.equal(at.conexaoRecusada(mista), false);
  assert.equal(at.conexaoRecusada(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), false);
  assert.equal(at.conexaoRecusada(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), false);
  assert.equal(at.conexaoRecusada(new Error('JSON invalido')), false);
  assert.equal(at.conexaoRecusada(null), false);
});

test('falha definitiva recusa na hora; transitoria so na 3a tentativa', () => {
  const novo = () => ({ recusadas: [], tentativas: {}, alvo: SHA2, preparada: null });
  const a = novo();
  assert.equal(at.registrarFalha(a, SHA2, true), 'recusada');
  assert.deepEqual(a.recusadas, [SHA2]);
  assert.equal(a.alvo, null);

  const b = novo();
  assert.equal(at.registrarFalha(b, SHA2, false), 'tentar-de-novo');
  assert.equal(at.registrarFalha(b, SHA2, false), 'tentar-de-novo');
  assert.deepEqual(b.tentativas, { [SHA2]: 2 });
  assert.deepEqual(b.recusadas, []);
  assert.equal(at.registrarFalha(b, SHA2, false), 'recusada');
  assert.deepEqual(b.recusadas, [SHA2]);
  assert.deepEqual(b.tentativas, {});
  assert.equal(b.alvo, null);
});

test('versoes\\: so nomes do atualizador e nunca a atual, a anterior ou a preparada', () => {
  assert.equal(at.nomeDeVersao(SHA1), true);
  assert.equal(at.nomeDeVersao(SHA1 + '.preparando'), true);
  assert.equal(at.nomeDeVersao(SHA1 + '.zip'), true);
  for (const ruim of ['config.json', '..', '.', SHA1 + '.bak', SHA1.slice(1), 'node_modules', SHA1 + '/x', '']) {
    assert.equal(at.nomeDeVersao(ruim), false, ruim);
  }
  const nomes = [SHA1, SHA2, SHA3, SHA3 + '.preparando', 'leia-me.txt', 'config.json'];
  assert.deepEqual(at.versoesParaApagar(nomes, [SHA1, SHA2, null]), [SHA3, SHA3 + '.preparando']);
  assert.deepEqual(at.versoesParaApagar(nomes, [null, null]).sort(), [SHA1, SHA2, SHA3, SHA3 + '.preparando'].sort());
  for (const dado of ['config.json', 'config.json.bak', 'estado.json', 'atualizacao.json', 'atualizacao.log', 'atualizacao.lock', 'bridge.pid']) {
    assert.equal(at.DADOS_PROTEGIDOS.has(dado), true, dado);
    assert.equal(at.nomeDeVersao(dado), false, dado + ' nunca e apagavel');
  }
});

test('casaBridge: so `node iniciar.js` DESTA instalacao, nunca o atualizador nem outra pasta', () => {
  const inst = 'C:\\Users\\Jo\u00e3o\\AppData\\Local\\Monitor01V96';
  assert.equal(at.casaBridge(`"C:\\Program Files\\nodejs\\node.exe" "${inst}\\iniciar.js"`, inst), true);
  assert.equal(at.casaBridge(`node ${inst.toUpperCase()}\\INICIAR.JS`, inst), true, 'maiusculas');
  assert.equal(at.casaBridge(`node "${inst}\\iniciar.js" atualizar`, inst), false, 'o atualizador nao e o bridge');
  assert.equal(at.casaBridge(`node ${inst}\\iniciar.js.bak`, inst), false);
  assert.equal(at.casaBridge('node C:\\outro\\Monitor01V96\\iniciar.js', inst), false, 'outra pasta');
  assert.equal(at.casaBridge(`node ${inst}2\\iniciar.js`, inst), false, 'pasta de nome parecido');
  assert.equal(at.casaBridge('node C:\\app\\servidor.js', inst), false);
  assert.equal(at.casaBridge(null, inst), false);
});

test('urlPermitida: em producao so HTTPS e so os hosts do GitHub; override so com MONITOR_TESTE=1', () => {
  assert.equal(at.urlPermitida('https://api.github.com/repos/x/y/commits/igreja'), true);
  assert.equal(at.urlPermitida('https://codeload.github.com/x/y/zip/' + SHA1), true);
  for (const ruim of ['http://api.github.com/x', 'https://github.com/x', 'https://evil.com/x',
    'https://api.github.com.evil.com/x', 'https://user:senha@api.github.com/x', 'ftp://api.github.com/x',
    'https://127.0.0.1/x', 'lixo', '']) {
    assert.equal(at.urlPermitida(ruim), false, ruim);
  }
  // sem MONITOR_TESTE=1 (como neste processo) a sobrescrita nao vale nada
  assert.equal(process.env.MONITOR_TESTE, undefined);
  assert.equal(at.urlPermitida('http://127.0.0.1:1234/x', true), false);
});

/** Monta so o diretorio central de um zip (o que listarEntradasZip le). */
function zipSoComNomes(nomes, { zip64 = false } = {}) {
  const partes = [];
  let tamCd = 0;
  for (const nome of nomes) {
    const n = Buffer.from(nome);
    const r = Buffer.alloc(46 + n.length);
    r.writeUInt32LE(0x02014b50, 0);
    r.writeUInt16LE(n.length, 28);
    n.copy(r, 46);
    partes.push(r);
    tamCd += r.length;
  }
  if (zip64) {
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    partes.push(loc);
  }
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(nomes.length, 8);
  fim.writeUInt16LE(nomes.length, 10);
  fim.writeUInt32LE(tamCd, 12);
  fim.writeUInt32LE(0, 16);
  return Buffer.concat([...partes, fim]);
}

test('zip: lista as entradas e recusa as suspeitas (zip-slip, ":", zip64, pasta de topo errada)', () => {
  const topo = 'app-mixagem-de-som-' + SHA1;
  const bom = at.listarEntradasZip(zipSoComNomes([topo + '/', topo + '/package.json', topo + '\\src\\bridge.js']));
  assert.deepEqual(bom, [topo + '/', topo + '/package.json', topo + '\\src\\bridge.js']);
  assert.equal(at.entradasSeguras(bom, SHA1), true, 'inclusive barras invertidas do Compress-Archive');
  assert.equal(at.entradasSeguras(bom), true);
  assert.equal(at.entradasSeguras(bom, SHA2), false, 'topo de outra versao');
  assert.equal(at.entradasSeguras(['app/x'], SHA1), false, 'topo com outro nome');

  for (const ruim of [['../fora.txt'], ['app/../../fora.txt'], ['app\\..\\..\\fora.txt'], ['/etc/passwd'],
    ['C:\\Windows\\x.dll'], ['c:/x'], ['app/arquivo.txt:fluxo'], ['app/a:b/c'], []]) {
    assert.equal(at.entradasSeguras(ruim), false, JSON.stringify(ruim));
  }
  assert.equal(at.listarEntradasZip(zipSoComNomes(['a/b'], { zip64: true })), null, 'localizador zip64');
  assert.equal(at.listarEntradasZip(Buffer.from('isto nao e um zip')), null);
  assert.equal(at.listarEntradasZip(Buffer.alloc(0)), null);
  assert.equal(at.entradasSeguras(null), false);
});

test('log: hora local com fuso; mensagem igual a anterior vira (xN) em vez de repetir', () => {
  const d = new Date(2026, 9, 3, 14, 5, 9);
  assert.match(at.horaLocal(d), /^2026-10-03 14:05:09[+-]\d\d:\d\d$/);

  let linhas = [];
  linhas = at.acrescentarLog(linhas, 'sem consulta: fetch failed', d);
  linhas = at.acrescentarLog(linhas, 'sem consulta: fetch failed', d);
  linhas = at.acrescentarLog(linhas, 'sem consulta: fetch failed', d);
  assert.equal(linhas.length, 1);
  assert.match(linhas[0], /sem consulta: fetch failed \(x3\)$/);
  linhas = at.acrescentarLog(linhas, 'outra coisa', d);
  linhas = at.acrescentarLog(linhas, 'sem consulta: fetch failed', d);
  assert.equal(linhas.length, 3, 'depois de outra mensagem volta a registrar');

  let muitas = [];
  for (let i = 0; i < 400; i++) muitas = at.acrescentarLog(muitas, 'linha ' + i, d);
  assert.equal(muitas.length, 300);
  assert.match(muitas[299], /linha 399$/);
});

test('temTestes: so conta com test/ e pelo menos um *.test.js', () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-temtestes-'));
  try {
    assert.equal(at.temTestes(p), false, 'sem pasta test');
    fs.mkdirSync(path.join(p, 'test'));
    assert.equal(at.temTestes(p), false, 'pasta vazia');
    fs.writeFileSync(path.join(p, 'test', 'leia-me.txt'), 'x');
    assert.equal(at.temTestes(p), false, 'sem *.test.js');
    fs.mkdirSync(path.join(p, 'test', 'sub'));
    fs.writeFileSync(path.join(p, 'test', 'sub', 'a.test.js'), '');
    assert.equal(at.temTestes(p), true);
  } finally {
    fs.rmSync(p, { recursive: true, force: true });
  }
});

test('executar numa pasta que nao e uma instalacao (sem iniciar.js): nao cria nem apaga nada', async () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-naoinst-'));
  try {
    fs.writeFileSync(path.join(p, 'config.json'), '{}');
    fs.mkdirSync(path.join(p, 'versoes', SHA1), { recursive: true });
    assert.equal(await at.executar(p), 'sem-instalacao');
    assert.deepEqual(fs.readdirSync(p).sort(), ['config.json', 'versoes']);
    assert.ok(fs.existsSync(path.join(p, 'versoes', SHA1)));
  } finally {
    fs.rmSync(p, { recursive: true, force: true });
  }
});

/* ============ parte 2: integracao (roda o atualizar.js de verdade) ===== */

function portaLivre() {
  return new Promise((ok, erro) => {
    const s = net.createServer();
    s.once('error', erro);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

function pegarJson(porta, caminho = '/api/status', ms = 1500, host = '127.0.0.1') {
  return new Promise((ok) => {
    const req = http.get({ host, port: porta, path: caminho, timeout: ms }, (res) => {
      let t = '';
      res.on('data', (p) => { t += p; });
      res.on('end', () => { try { ok(JSON.parse(t)); } catch { ok(null); } });
    });
    req.on('error', () => ok(null));
    req.on('timeout', () => { req.destroy(); ok(null); });
  });
}

async function esperarAte(fn, descricao, ms = 20000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    const r = await fn();
    if (r) return r;
    await pausa(100);
  }
  throw new Error('esperei ' + ms + ' ms e nao aconteceu: ' + descricao);
}

/** Bridge de mentirinha: responde /api/status como o de verdade. Le o config da pasta de DADOS. */
function codigoBridgeFalso({ versao, sobe, modo }) {
  return `'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const VERSAO = '${versao}';
const dados = process.env.MONITOR_DADOS;
const base = path.resolve(dados, '..');
if (${sobe ? 'false' : 'true'}) process.exit(1);
let porta = 8080;
let host = '127.0.0.1';
try {
  const t = fs.readFileSync(path.join(dados, 'config.json'), 'utf8');
  const srv = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t).servidor;
  porta = Number(srv.porta);
  if (srv.host && srv.host !== '0.0.0.0') host = srv.host;
} catch (e) {}
fs.appendFileSync(path.join(base, 'pids.txt'), process.pid + '\\n');
if ('${modo}' === 'mudo') { setInterval(() => {}, 1000); } else {
  let n = 0;
  http.createServer((req, res) => {
    let s = { midi: { simulado: true }, clientes: 0 };
    try { s = JSON.parse(fs.readFileSync(path.join(base, 'fake-status.json'), 'utf8')); } catch (e) {}
    if (s.travar) return; // aceita a conexao e nunca responde (timeout)
    if (Array.isArray(s.sequencia)) s = s.sequencia[Math.min(n++, s.sequencia.length - 1)];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...s, falso: VERSAO, dados }));
  }).listen(porta, host);
}
setTimeout(() => process.exit(0), 240000); // rede de seguranca: nunca fica para sempre
`;
}

const NPM_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

/**
 * Escreve um projeto minimo (o que o "GitHub" entrega e o que a instalacao
 * tem em versoes\<sha>). `instalado` pula o npm ci e cria o node_modules direto.
 */
function escreverProjeto(pasta, { versao, testePassa = true, sobe = true, modo = '', semTestes = false, lockQuebrado = false, instalado = false, iniciarExtra = '', semAtualizador = false, atualizadorQuebrado = false, codigoTeste = null, semLancador = false }) {
  fs.mkdirSync(path.join(pasta, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pasta, 'src', 'bridge.js'), codigoBridgeFalso({ versao, sobe, modo }));
  // o atualizador de verdade (uma versao nova traz o proprio atualizar.js)
  if (atualizadorQuebrado) {
    fs.writeFileSync(path.join(pasta, 'src', 'atualizar.js'), 'module.exports = {{{ isto nao e javascript');
  } else if (!semAtualizador) {
    fs.copyFileSync(path.join(RAIZ, 'src', 'atualizar.js'), path.join(pasta, 'src', 'atualizar.js'));
  }
  fs.writeFileSync(path.join(pasta, 'config.example.json'), '{"servidor":{"porta":8080}}');
  if (!semLancador) {
    fs.mkdirSync(path.join(pasta, 'instalar'), { recursive: true });
    fs.writeFileSync(path.join(pasta, 'instalar', 'iniciar.js'),
      fs.readFileSync(path.join(RAIZ, 'instalar', 'iniciar.js'), 'utf8') + iniciarExtra);
  }
  if (!semTestes) {
    fs.mkdirSync(path.join(pasta, 'test'), { recursive: true });
    fs.writeFileSync(path.join(pasta, 'test', 'mini.test.js'), codigoTeste ||
      "require('node:test')('mini',()=>{require('node:assert').equal(1," + (testePassa ? '1' : '2') + ');});\n');
  }

  if (instalado) {
    fs.writeFileSync(path.join(pasta, 'package.json'), JSON.stringify({ name: 'mini', version: '1.0.0', private: true }));
    fs.mkdirSync(path.join(pasta, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(pasta, 'node_modules', 'dep', 'marca.txt'), versao);
    return;
  }

  // dependencia local por tarball: o `npm ci --ignore-scripts` instala sem rede
  const dep = path.join(pasta, '.dep');
  fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }));
  fs.writeFileSync(path.join(dep, 'marca.txt'), versao);
  const r = spawnSync(process.execPath, [NPM_CLI, 'pack', '--silent'], { cwd: dep, encoding: 'utf8' });
  assert.equal(r.status, 0, 'npm pack falhou: ' + r.stdout + r.stderr);
  const tgz = fs.readdirSync(dep).find((n) => n.endsWith('.tgz'));
  fs.copyFileSync(path.join(dep, tgz), path.join(pasta, 'dep-1.0.0.tgz'));
  const integridade = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(path.join(dep, tgz))).digest('base64');
  fs.rmSync(dep, { recursive: true, force: true });
  fs.writeFileSync(path.join(pasta, 'package.json'), JSON.stringify({
    name: 'mini', version: '1.0.0', private: true, dependencies: { dep: 'file:dep-1.0.0.tgz' }
  }));
  fs.writeFileSync(path.join(pasta, 'package-lock.json'), JSON.stringify({
    name: 'mini', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'mini', version: '1.0.0', dependencies: { dep: 'file:dep-1.0.0.tgz' } },
      'node_modules/dep': { version: '1.0.0', resolved: 'file:dep-1.0.0.tgz', integrity: lockQuebrado ? 'sha512-' + 'A'.repeat(86) + '==' : integridade }
    }
  }));
}

const cacheZips = new Map();
let pastaZips = null;

/** Zip estilo GitHub: uma pasta `app-mixagem-de-som-<sha>` com tudo dentro. */
function zipDe(sha, opcoes) {
  const chave = sha + JSON.stringify(opcoes);
  if (cacheZips.has(chave)) return cacheZips.get(chave);
  if (!pastaZips) pastaZips = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-zips-'));
  const dir = path.join(pastaZips, 'src-' + cacheZips.size);
  const topo = path.join(dir, 'app-mixagem-de-som-' + sha);
  escreverProjeto(topo, opcoes);
  const zip = path.join(dir, 'pacote.zip');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ProgressPreference='SilentlyContinue'; Compress-Archive -LiteralPath $env:TOPO -DestinationPath $env:ZIP -Force"],
  { env: { ...process.env, TOPO: topo, ZIP: zip }, encoding: 'utf8' });
  assert.equal(r.status, 0, 'Compress-Archive falhou: ' + r.stdout + r.stderr);
  const buf = fs.readFileSync(zip);
  cacheZips.set(chave, buf);
  return buf;
}

test.after(() => {
  if (pastaZips) fs.rmSync(pastaZips, { recursive: true, force: true });
});

/** "GitHub" local. `estado` e mutavel: o teste troca sha/zips/modo no meio. So existe o ramo `igreja`. */
function subirGithub(estado) {
  const hits = { api: 0, zip: 0, urls: [] };
  const servidor = http.createServer((req, res) => {
    hits.urls.push(req.url);
    if (req.url === '/commits/igreja') {
      hits.api++;
      estado.cabecalhos = { accept: req.headers.accept, ua: req.headers['user-agent'] };
      if (estado.apiStatus) { res.writeHead(estado.apiStatus); res.end('x'); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(estado.sha);
      return;
    }
    const m = /^\/zip\/([0-9a-f]{40})$/.exec(req.url);
    if (m && estado.zips[m[1]]) {
      hits.zip++;
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(estado.zips[m[1]]);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((ok) => servidor.listen(0, '127.0.0.1', () => ok({
    url: 'http://127.0.0.1:' + servidor.address().port,
    hits,
    fechar: () => new Promise((fim) => { servidor.closeAllConnections?.(); servidor.close(fim); })
  })));
}

const CONFIG_BYTES = (porta, { host = '127.0.0.1', portaTexto = false } = {}) => Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]), // BOM de proposito: tem que sobreviver byte a byte
  Buffer.from('{\r\n  "servidor": { "porta": ' + (portaTexto ? '"' + porta + '"' : porta) + ', "host": "' + host + '" },\r\n  "nome": "Culto \u00e7\u00e3o"  \r\n}\r\n')
]);
const ESTADO_BYTES = Buffer.from('{"mix":{"voz":0.42},"obs":"nao mexer"}\n\n');

/** Hash de uma arvore inteira (nomes + conteudo): prova que uma versao nao mudou. */
function hashArvore(dir) {
  const h = crypto.createHash('sha1');
  const andar = (d, rel) => {
    for (const nome of fs.readdirSync(d).sort()) {
      const p = path.join(d, nome);
      const info = fs.statSync(p);
      h.update(rel + '/' + nome + (info.isDirectory() ? '/' : ':'));
      if (info.isDirectory()) andar(p, rel + '/' + nome); else h.update(fs.readFileSync(p));
    }
  };
  andar(dir, '');
  return h.digest('hex');
}

/**
 * Cria <tmp>/inst (a "instalacao", no layout novo) com a versao SHA1 (v1) e
 * dados de verdade-de-mentira. `base` (<tmp>) guarda o que o bridge falso
 * le/escreve fora da instalacao.
 */
async function criarCenario({ ligado = false, estadoInicial = {}, github = {}, v1 = {}, config = {}, antes = null } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-atualizar-Jo\u00e3o-')));
  const inst = path.join(base, 'inst');
  const porta = await portaLivre();
  fs.mkdirSync(inst, { recursive: true });
  fs.copyFileSync(path.join(RAIZ, 'instalar', 'iniciar.js'), path.join(inst, 'iniciar.js'));
  escreverProjeto(path.join(inst, 'versoes', SHA1), { versao: 'v1', instalado: true, ...v1 });
  const configBytes = CONFIG_BYTES(porta, config);
  fs.writeFileSync(path.join(inst, 'config.json'), configBytes);
  fs.writeFileSync(path.join(inst, 'config.json.bak'), 'bak antigo');
  fs.writeFileSync(path.join(inst, 'estado.json'), ESTADO_BYTES);
  fs.writeFileSync(path.join(inst, 'atualizacao.json'), JSON.stringify({
    atual: SHA1, anterior: null, emTroca: null, alvo: null, preparada: null, recusadas: [], tentativas: {},
    instaladaEm: '2026-01-01T00:00:00.000Z', ultimaConsulta: null, falhasRede: 0,
    ultimoResultado: 'instalado pelo instalador', ...estadoInicial
  }));

  const gh = { sha: SHA2, zips: {}, ...github };
  const servidor = await subirGithub(gh);
  const cen = {
    base, inst, porta, gh, servidor, configBytes,
    arquivo: (...p) => path.join(inst, ...p),
    json: () => JSON.parse(fs.readFileSync(path.join(inst, 'atualizacao.json'), 'utf8')),
    gravarJson: (o) => fs.writeFileSync(path.join(inst, 'atualizacao.json'), JSON.stringify(o)),
    log: () => { try { return fs.readFileSync(path.join(inst, 'atualizacao.log'), 'utf8'); } catch { return ''; } },
    statusMesa(s) { fs.writeFileSync(path.join(base, 'fake-status.json'), JSON.stringify(s)); },
    status: () => pegarJson(porta, '/api/status', 1500, config.host || '127.0.0.1'),
    pids() {
      try { return fs.readFileSync(path.join(base, 'pids.txt'), 'utf8').split(/\s+/).filter(Boolean).map(Number); } catch { return []; }
    },
    versoes: () => (fs.existsSync(path.join(inst, 'versoes')) ? fs.readdirSync(path.join(inst, 'versoes')).sort() : []),
    ligarSemEsperar() {
      const f = spawn(process.execPath, [path.join(inst, 'iniciar.js')], { cwd: inst, stdio: 'ignore', windowsHide: true });
      f.unref();
      return f;
    },
    ligarV1() {
      cen.ligarSemEsperar();
      return esperarAte(() => cen.status(), 'bridge v1 subir');
    },
    async matarBridges() {
      for (const pid of cen.pids()) { try { process.kill(pid); } catch { /* ja saiu */ } }
      await esperarAte(async () => !(await cen.status()), 'bridge cair');
    },
    /** Dispara o atualizador sem esperar; devolve { filho, fim }. */
    iniciarAtualizador(extraEnv = {}) {
      const env = {
        ...process.env, MONITOR_TESTE: '1', MONITOR_ATUALIZAR_API: servidor.url, MONITOR_ATUALIZAR_ZIP: servidor.url,
        MONITOR_ATUALIZAR_PAUSA_MS: '100', ...extraEnv
      };
      delete env.NODE_TEST_CONTEXT;
      const filho = spawn(process.execPath, [path.join(inst, 'iniciar.js'), 'atualizar'], { cwd: base, env, windowsHide: true, stdio: 'ignore' });
      return { filho, fim: new Promise((ok) => filho.on('close', ok)) };
    },
    rodar(extraEnv = {}, argumentos = ['atualizar']) {
      return new Promise((ok) => {
        const env = {
          ...process.env,
          MONITOR_TESTE: '1',
          MONITOR_ATUALIZAR_API: servidor.url,
          MONITOR_ATUALIZAR_ZIP: servidor.url,
          MONITOR_ATUALIZAR_PAUSA_MS: '100',
          // PC ligado ha um dia: o resultado nao pode depender de quando esta
          // maquina (ou o PC da igreja, no preparo) foi ligada.
          MONITOR_ATUALIZAR_UPTIME_S: '86400',
          ...extraEnv
        };
        delete env.NODE_TEST_CONTEXT;
        const f = spawn(process.execPath, [path.join(inst, 'iniciar.js'), ...argumentos], { cwd: base, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let saida = '';
        f.stdout.on('data', (p) => { saida += p; });
        f.stderr.on('data', (p) => { saida += p; });
        const relogio = setTimeout(() => f.kill(), 200000);
        f.on('close', (codigo) => { clearTimeout(relogio); ok({ codigo, saida }); });
      });
    },
    async limpar() {
      // mata todo bridge falso que este teste ligou (inclusive os soltos pelo WMI)
      const pids = new Set(cen.pids());
      try { pids.add(Number(fs.readFileSync(path.join(inst, 'bridge.pid'), 'utf8'))); } catch { /* sem pid */ }
      for (const pid of pids) { if (pid > 0) { try { process.kill(pid); } catch { /* ja saiu */ } } }
      await servidor.fechar();
      const limite = Date.now() + 10000;
      while (Date.now() < limite && (await pegarJson(porta, '/api/status', 300, config.host || '127.0.0.1'))) await pausa(200);
      for (let i = 0; i < 20; i++) {
        try { fs.rmSync(base, { recursive: true, force: true }); break; } catch { await pausa(250); }
      }
    }
  };
  if (antes) await antes(cen);
  if (ligado) await cen.ligarV1();
  return cen;
}

/** Roda `fn(cenario)` e garante a limpeza mesmo se o teste falhar. */
function cenario(nome, opcoes, fn) {
  test('atualizar (integracao): ' + nome, { skip: SO_WINDOWS, timeout: 300000 }, async () => {
    const cen = await criarCenario(opcoes);
    try { await fn(cen); } finally { await cen.limpar(); }
  });
}

function dadosIguais(cen) {
  assert.ok(Buffer.compare(fs.readFileSync(cen.arquivo('config.json')), cen.configBytes) === 0, 'config.json mudou');
  assert.ok(Buffer.compare(fs.readFileSync(cen.arquivo('estado.json')), ESTADO_BYTES) === 0, 'estado.json mudou');
  assert.equal(fs.readFileSync(cen.arquivo('config.json.bak'), 'utf8'), 'bak antigo');
}

const versaoNoDisco = (cen, sha) => /VERSAO = '(\w+)'/.exec(fs.readFileSync(cen.arquivo('versoes', sha, 'src', 'bridge.js'), 'utf8'))[1];
const SEGURA = { midi: { simulado: true }, clientes: 0 };

cenario('aplica quando e seguro: versao nova em versoes\\, ponteiro trocado, antiga intacta, dados byte a byte',
  { ligado: true },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2' });
    cen.statusMesa(SEGURA);
    const antes = hashArvore(cen.arquivo('versoes', SHA1));

    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);

    const e = cen.json();
    assert.equal(e.atual, SHA2);
    assert.equal(e.anterior, SHA1);
    assert.equal(e.emTroca, null);
    assert.equal(e.preparada, null);
    assert.equal(e.alvo, null);
    assert.deepEqual(e.recusadas, []);
    assert.equal(e.ultimoResultado, 'atualizado para 2222222');
    assert.equal(versaoNoDisco(cen, SHA2), 'v2');
    assert.equal((await cen.status()).falso, 'v2', 'o bridge que responde e o novo');
    assert.equal((await cen.status()).dados, cen.inst, 'o lancador aponta MONITOR_DADOS para a instalacao');
    dadosIguais(cen);

    assert.equal(hashArvore(cen.arquivo('versoes', SHA1)), antes, 'a versao antiga nao foi alterada');
    assert.deepEqual(cen.versoes(), [SHA1, SHA2]);
    assert.equal(fs.readFileSync(cen.arquivo('versoes', SHA2, 'node_modules', 'dep', 'marca.txt'), 'utf8'), 'v2', 'npm ci --ignore-scripts instalou do tarball');
    // nada de codigo solto na raiz da instalacao
    assert.deepEqual(fs.readdirSync(cen.inst).filter((n) => !['iniciar.js', 'versoes', 'config.json', 'config.json.bak', 'estado.json', 'atualizacao.json', 'atualizacao.log', 'bridge.pid'].includes(n)), []);

    assert.equal(cen.servidor.hits.api, 1);
    assert.equal(cen.servidor.hits.zip, 1);
    assert.deepEqual(cen.servidor.hits.urls, ['/commits/igreja', '/zip/' + SHA2], 'so o ramo igreja');
    assert.match(cen.gh.cabecalhos.accept, /vnd\.github\.sha/);
    assert.ok(cen.gh.cabecalhos.ua);
    assert.match(cen.log(), /atualizado para 2222222/);
    assert.match(cen.log().split('\n')[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d[+-]\d\d:\d\d /, 'hora local com fuso');
  });

for (const [titulo, ocupado] of [
  ['mesa ligada', { midi: { simulado: false }, clientes: 0 }],
  ['celular conectado', { midi: { simulado: true }, clientes: 1 }]
]) {
  cenario(titulo + ': nao baixa nem prepara nada; prepara e troca na execucao seguinte quando fica seguro',
    { ligado: true },
    async (cen) => {
      cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2' });
      cen.statusMesa(ocupado);

      for (let i = 0; i < 2; i++) {
        const r = await cen.rodar();
        assert.equal(r.codigo, 0, r.saida);
        assert.equal(cen.servidor.hits.zip, 0, 'nada de codigo novo durante o culto');
        assert.deepEqual(cen.versoes(), [SHA1], 'nem pasta de preparo');
        assert.equal((await cen.status()).falso, 'v1');
        assert.equal(cen.json().atual, SHA1);
        assert.equal(cen.json().alvo, SHA2, 'sabe qual e a versao nova');
        assert.equal(cen.json().ultimoResultado, at.RESULTADO.esperandoSeguro);
      }
      assert.equal(cen.servidor.hits.api, 1, 'consulta so uma vez');
      dadosIguais(cen);

      cen.statusMesa(SEGURA);
      const r3 = await cen.rodar();
      assert.equal(r3.codigo, 0, r3.saida);
      assert.equal(cen.json().atual, SHA2);
      assert.equal((await cen.status()).falso, 'v2');
      assert.equal(cen.servidor.hits.zip, 1);
      assert.equal(cen.servidor.hits.api, 1, 'nao consultou de novo (6 h)');
      dadosIguais(cen);
    });
}

cenario('um celular entra entre a decisao e a troca: nao troca (reconfirma antes de parar o bridge)',
  { ligado: true },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2' });
    // sondagens: vigia, preparar, antes do npm ci, antes dos testes, aplicar (executar), aplicar (reconfirmacao)
    cen.statusMesa({ sequencia: [SEGURA, SEGURA, SEGURA, SEGURA, SEGURA, { midi: { simulado: true }, clientes: 1 }] });

    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal(cen.json().atual, SHA1, 'nao trocou');
    assert.equal(cen.json().preparada, SHA2, 'fica pronta para a proxima');
    assert.equal(cen.json().emTroca, null);
    assert.equal((await cen.status()).falso, 'v1', 'o bridge velho nunca foi parado');
    assert.equal(cen.pids().length, 1);
    assert.ok(cen.versoes().includes(SHA2), 'a versao preparada foi guardada');

    cen.statusMesa(SEGURA);
    const r2 = await cen.rodar();
    assert.equal(r2.codigo, 0, r2.saida);
    assert.equal(cen.json().atual, SHA2);
    assert.equal(cen.servidor.hits.zip, 1, 'aplicou o que ja estava preparado');
  });

cenario('testes que terminam com erro: recusa DEFINITIVA, nada fica pela metade e nao tenta de novo',
  { ligado: true },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2', testePassa: false });
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    const e = cen.json();
    assert.deepEqual(e.recusadas, [SHA2]);
    assert.equal(e.atual, SHA1);
    assert.equal(e.alvo, null);
    assert.equal(e.preparada, null);
    assert.deepEqual(cen.versoes(), [SHA1], 'preparando apagado');
    assert.equal((await cen.status()).falso, 'v1');
    assert.match(cen.log(), /recusada: testes falharam/);
    assert.doesNotMatch(e.ultimoResultado, /[\\/]|falharam/, 'o status nao leva detalhe nem caminho');
    dadosIguais(cen);

    fs.writeFileSync(cen.arquivo('atualizacao.json'), JSON.stringify({ ...e, ultimaConsulta: '2020-01-01T00:00:00.000Z' }));
    const r2 = await cen.rodar();
    assert.equal(r2.codigo, 0, r2.saida);
    assert.equal(cen.servidor.hits.api, 2, 'consultou');
    assert.equal(cen.servidor.hits.zip, 1, 'mas nao baixou a recusada');
  });

cenario('pacote sem testes nao e instalado (nao da para confiar nele)',
  { ligado: true },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2', semTestes: true });
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.deepEqual(cen.json().recusadas, [SHA2]);
    assert.match(cen.log(), /sem testes/);
    assert.deepEqual(cen.versoes(), [SHA1]);
  });

cenario('falha transitoria (npm ci): tenta de novo e so na 3a vira recusada',
  { ligado: true },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2', lockQuebrado: true });
    for (let i = 1; i <= 2; i++) {
      const r = await cen.rodar();
      assert.equal(r.codigo, 0, r.saida);
      assert.deepEqual(cen.json().recusadas, [], 'tentativa ' + i + ' ainda nao recusa');
      assert.equal(cen.json().tentativas[SHA2], i);
      assert.equal(cen.json().alvo, SHA2);
      assert.deepEqual(cen.versoes(), [SHA1], 'preparo apagado');
    }
    const r3 = await cen.rodar();
    assert.equal(r3.codigo, 0, r3.saida);
    assert.deepEqual(cen.json().recusadas, [SHA2]);
    assert.deepEqual(cen.json().tentativas, {});
    assert.equal(cen.json().alvo, null);
    assert.equal(cen.servidor.hits.zip, 3);
    assert.equal((await cen.status()).falso, 'v1');
  });

cenario('rede cai so na hora de baixar o pacote: nao conta como tentativa da versao, espera a janela',
  { ligado: true },
  async (cen) => {
    const morta = await portaLivre();
    const r = await cen.rodar({ MONITOR_ATUALIZAR_ZIP: 'http://127.0.0.1:' + morta });
    assert.equal(r.codigo, 0, r.saida);
    const e = cen.json();
    assert.deepEqual(e.tentativas, {});
    assert.deepEqual(e.recusadas, []);
    assert.equal(e.alvo, SHA2, 'continua querendo a versao nova');
    assert.equal(e.falhasRede, 1);
    assert.equal(e.ultimoResultado, at.RESULTADO.semRede);
    assert.deepEqual(cen.versoes(), [SHA1]);
    // dentro da janela de espera nem tenta baixar de novo
    const r2 = await cen.rodar({ MONITOR_ATUALIZAR_ZIP: 'http://127.0.0.1:' + morta });
    assert.equal(r2.codigo, 0, r2.saida);
    assert.equal(cen.json().falhasRede, 1);
  });

cenario('bridge novo que SAI COM ERRO: o ponteiro volta, a versao e recusada na hora',
  { ligado: true },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2', sobe: false });
    cen.statusMesa(SEGURA);
    const antes = hashArvore(cen.arquivo('versoes', SHA1));

    const r = await cen.rodar({ MONITOR_ATUALIZAR_ESPERA_MS: '4000' });
    assert.equal(r.codigo, 0, r.saida);

    assert.equal((await esperarAte(() => cen.status(), 'bridge antigo voltar')).falso, 'v1');
    const e = cen.json();
    assert.equal(e.atual, SHA1);
    assert.equal(e.anterior, null);
    assert.equal(e.emTroca, null);
    assert.deepEqual(e.recusadas, [SHA2]);
    assert.equal(e.ultimoResultado, at.RESULTADO.voltou);
    assert.equal(hashArvore(cen.arquivo('versoes', SHA1)), antes);
    dadosIguais(cen);
    assert.match(cen.log(), /fechou com erro; voltando/);
    assert.match(cen.log(), /versao anterior de volta no ar/);
  });

cenario('bridge novo que NAO RESPONDE a tempo: volta, mas e transitorio (3 tentativas)',
  { ligado: true },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2', modo: 'mudo' });
    cen.statusMesa(SEGURA);
    for (let i = 1; i <= 3; i++) {
      const r = await cen.rodar({ MONITOR_ATUALIZAR_ESPERA_MS: '2500' });
      assert.equal(r.codigo, 0, r.saida);
      assert.equal(cen.json().atual, SHA1, 'volta sempre');
      assert.equal((await esperarAte(() => cen.status(), 'bridge antigo voltar')).falso, 'v1');
      if (i < 3) {
        assert.deepEqual(cen.json().recusadas, []);
        assert.equal(cen.json().tentativas[SHA2], i);
        assert.equal(cen.json().preparada, SHA2, 'a pasta preparada fica para tentar de novo');
      }
    }
    assert.deepEqual(cen.json().recusadas, [SHA2]);
    assert.equal(cen.servidor.hits.zip, 1, 'baixou uma vez so: o preparo ficou guardado');
    assert.match(cen.log(), /nao respondeu a tempo/);
    dadosIguais(cen);
  });

cenario('troca interrompida (kill no meio): a proxima execucao volta o ponteiro e liga a versao anterior',
  { ligado: false },
  async (cen) => {
    escreverProjeto(cen.arquivo('versoes', SHA2), { versao: 'v2', sobe: false, instalado: true });
    cen.gravarJson({
      atual: SHA2, anterior: SHA1, emTroca: { de: SHA1, para: SHA2, anteriorAntes: null }, alvo: null, preparada: null,
      recusadas: [], tentativas: {}, ultimaConsulta: new Date().toISOString(), falhasRede: 0, instaladaEm: null, ultimoResultado: null
    });
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal((await esperarAte(() => cen.status(), 'versao anterior subir')).falso, 'v1');
    const e = cen.json();
    assert.equal(e.atual, SHA1);
    assert.equal(e.anterior, null);
    assert.equal(e.emTroca, null);
    assert.equal(e.tentativas[SHA2], 1, 'conta como falha da versao nova');
    assert.match(cen.log(), /troca interrompida/);
  });

cenario('vigia: liga o bridge que estava fora (conexao recusada 2 vezes) e nao baixa nada se esta em dia',
  { ligado: false, github: { sha: SHA1 } },
  async (cen) => {
    assert.equal(await cen.status(), null, 'comeca fora do ar');
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal((await esperarAte(() => cen.status(), 'vigia ligar o bridge')).falso, 'v1');
    assert.equal(cen.servidor.hits.zip, 0);
    assert.equal(cen.json().ultimoResultado, 'em dia');
    assert.match(cen.log(), /fora do ar; liguei de novo/);
    dadosIguais(cen);
  });

cenario('timeout NAO e "fora do ar": a vigia nao liga outro bridge e nao troca nada',
  { ligado: true },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2' });
    cen.statusMesa({ travar: true }); // aceita a conexao e nao responde
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal(cen.pids().length, 1, 'nenhum segundo bridge foi ligado');
    assert.equal(cen.servidor.hits.zip, 0, 'sem seguranca nao prepara');
    assert.deepEqual(cen.versoes(), [SHA1]);
    assert.equal(cen.json().atual, SHA1);
    assert.match(cen.log(), /respondeu de forma estranha/);
    assert.doesNotMatch(cen.log(), /liguei de novo/);
  });

cenario('bridge fora do ar e versao nova: liga, prepara e troca',
  { ligado: false },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2' });
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal((await esperarAte(() => cen.status(), 'bridge no ar')).falso, 'v2');
    assert.equal(cen.json().atual, SHA2);
    dadosIguais(cen);
  });

cenario('sem rede: nada quebra, o programa fica no ar e a espera cresce (30 min, 1 h...)',
  { ligado: false },
  async (cen) => {
    const morta = await portaLivre();
    const env = { MONITOR_ATUALIZAR_API: 'http://127.0.0.1:' + morta, MONITOR_ATUALIZAR_ZIP: 'http://127.0.0.1:' + morta };
    const r = await cen.rodar(env);
    assert.equal(r.codigo, 0, r.saida);
    assert.equal((await esperarAte(() => cen.status(), 'vigia ligar o bridge')).falso, 'v1');
    let e = cen.json();
    assert.equal(e.atual, SHA1);
    assert.equal(e.falhasRede, 1);
    assert.ok(e.ultimaConsulta, 'registra a tentativa para dar o intervalo');
    assert.equal(e.ultimoResultado, at.RESULTADO.semRede, 'texto fixo, sem a mensagem do erro');
    assert.match(cen.log(), /sem consulta/);
    assert.equal(fs.existsSync(cen.arquivo('atualizacao.lock')), false);
    dadosIguais(cen);

    // logo em seguida: ainda dentro dos 30 min, nem tenta
    const r2 = await cen.rodar({ MONITOR_ATUALIZAR_API: cen.servidor.url });
    assert.equal(r2.codigo, 0, r2.saida);
    assert.equal(cen.servidor.hits.api, 0);
    assert.equal(cen.json().falhasRede, 1);

    // passaram 31 min: tenta de novo, a rede voltou, zera
    cen.gravarJson({ ...cen.json(), ultimaConsulta: new Date(Date.now() - 31 * 60 * 1000).toISOString() });
    cen.gh.sha = SHA1;
    const r3 = await cen.rodar({ MONITOR_ATUALIZAR_API: cen.servidor.url });
    assert.equal(r3.codigo, 0, r3.saida);
    assert.equal(cen.servidor.hits.api, 1);
    assert.equal(cen.json().falhasRede, 0);
    assert.equal(cen.json().ultimoResultado, 'em dia');
  });

cenario('limite da API do GitHub (403): so registra e espera mais',
  { ligado: true, github: { apiStatus: 403 } },
  async (cen) => {
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal((await cen.status()).falso, 'v1');
    assert.equal(cen.json().ultimoResultado, at.RESULTADO.limiteApi);
    assert.equal(cen.json().falhasRede, 1);
    assert.equal(cen.servidor.hits.zip, 0);
  });

cenario('consulta no maximo a cada 6 horas',
  { ligado: true, estadoInicial: { ultimaConsulta: new Date().toISOString() } },
  async (cen) => {
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal(cen.servidor.hits.api, 0);
  });

cenario('sha invalido na resposta do GitHub e ignorado',
  { ligado: true, github: { sha: '../../etc/passwd' } },
  async (cen) => {
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal(cen.servidor.hits.zip, 0);
    assert.equal(cen.json().atual, SHA1);
    assert.equal(cen.json().ultimoResultado, at.RESULTADO.semRede);
  });

for (const [titulo, nomes, opcoes] of [
  ['caminho fugindo da pasta', ['app-mixagem-de-som-' + SHA2 + '/../../fora.txt', 'app-mixagem-de-som-' + SHA2 + '/package.json'], {}],
  ['nome com ":"', ['app-mixagem-de-som-' + SHA2 + '/a.txt:fluxo'], {}],
  ['localizador zip64', ['app-mixagem-de-som-' + SHA2 + '/package.json'], { zip64: true }],
  ['pasta de topo de outra versao', ['app-mixagem-de-som-' + SHA3 + '/package.json'], {}]
]) {
  cenario('pacote suspeito (' + titulo + ') e descartado e a versao recusada',
    { ligado: true },
    async (cen) => {
      cen.gh.zips[SHA2] = zipSoComNomes(nomes, opcoes);
      const r = await cen.rodar();
      assert.equal(r.codigo, 0, r.saida);
      assert.equal(cen.json().atual, SHA1);
      assert.deepEqual(cen.json().recusadas, [SHA2]);
      assert.equal(fs.existsSync(path.join(cen.base, 'fora.txt')), false);
      assert.match(cen.log(), /suspeito/);
      assert.deepEqual(cen.versoes(), [SHA1]);
    });
}

cenario('outra execucao em andamento: sai sem fazer nada; trava velha ou com data no futuro e ignorada',
  { ligado: false, github: { sha: SHA1 } },
  async (cen) => {
    fs.writeFileSync(cen.arquivo('atualizacao.lock'), 'outra execucao');
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal(await cen.status(), null, 'nem a vigia roda: a outra execucao cuida');
    assert.equal(fs.readFileSync(cen.arquivo('atualizacao.lock'), 'utf8'), 'outra execucao');

    const velha = new Date(Date.now() - 31 * 60 * 1000);
    fs.utimesSync(cen.arquivo('atualizacao.lock'), velha, velha);
    const r2 = await cen.rodar();
    assert.equal(r2.codigo, 0, r2.saida);
    assert.equal((await esperarAte(() => cen.status(), 'vigia ligar o bridge')).falso, 'v1');
    assert.equal(fs.existsSync(cen.arquivo('atualizacao.lock')), false);

    // relogio voltou: a trava ficou "do futuro"
    for (const p of cen.pids()) { try { process.kill(p); } catch { /* ja saiu */ } }
    await esperarAte(async () => !(await cen.status()), 'bridge cair');
    fs.writeFileSync(cen.arquivo('atualizacao.lock'), 'do futuro');
    const futuro = new Date(Date.now() + 3 * 3600 * 1000);
    fs.utimesSync(cen.arquivo('atualizacao.lock'), futuro, futuro);
    const r3 = await cen.rodar();
    assert.equal(r3.codigo, 0, r3.saida);
    assert.equal((await esperarAte(() => cen.status(), 'vigia ligar o bridge de novo')).falso, 'v1');
  });

cenario('iniciar.js: sem a versao atual cai para a anterior, e forca MONITOR_DADOS na pasta da instalacao',
  { ligado: false },
  async (cen) => {
    cen.gravarJson({ ...cen.json(), atual: SHA3, anterior: SHA1 }); // SHA3 nao existe em versoes\
    const intruso = path.join(cen.base, 'dados-errados');
    const f = spawn(process.execPath, [cen.arquivo('iniciar.js')], {
      cwd: cen.base, env: { ...process.env, MONITOR_DADOS: intruso }, stdio: 'ignore', windowsHide: true
    });
    f.unref();
    const st = await esperarAte(() => cen.status(), 'bridge subir pelo lancador');
    assert.equal(st.falso, 'v1', 'caiu para a anterior');
    assert.equal(st.dados, cen.inst, 'MONITOR_DADOS valeu a pasta da instalacao, nao o valor do ambiente');
    assert.equal(Number(fs.readFileSync(cen.arquivo('bridge.pid'), 'utf8')), f.pid, 'grava bridge.pid');

    // sem nenhum ponteiro valido: a versao mais nova que existir
    f.kill();
    await esperarAte(async () => !(await cen.status()), 'bridge cair');
    cen.gravarJson({ ...cen.json(), atual: null, anterior: SHA3 });
    const g = spawn(process.execPath, [cen.arquivo('iniciar.js')], { cwd: cen.base, stdio: 'ignore', windowsHide: true });
    g.unref();
    assert.equal((await esperarAte(() => cen.status(), 'bridge subir com a mais nova')).falso, 'v1');
    g.kill();
  });

cenario('o lancador novo que vem na versao substitui o antigo (tmp + rename), so depois que a versao subiu',
  { ligado: true },
  async (cen) => {
    const extra = '\n// lancador da versao 2\n';
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2', iniciarExtra: extra });
    cen.statusMesa(SEGURA);
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal(cen.json().atual, SHA2);
    assert.ok(fs.readFileSync(cen.arquivo('iniciar.js'), 'utf8').endsWith(extra));
    assert.equal(fs.readFileSync(cen.arquivo('iniciar.js.bak'), 'utf8'), fs.readFileSync(path.join(RAIZ, 'instalar', 'iniciar.js'), 'utf8'), 'o anterior ficou em iniciar.js.bak');
    assert.equal(fs.existsSync(cen.arquivo('iniciar.novo.js')), false);
    assert.equal((await cen.status()).falso, 'v2');
  });

cenario('versao antiga que nao e a atual nem a anterior e apagada; versoes em uso nunca',
  { ligado: true, github: { sha: SHA1 } },
  async (cen) => {
    escreverProjeto(cen.arquivo('versoes', SHA3), { versao: 'v3', instalado: true });
    fs.mkdirSync(cen.arquivo('versoes', SHA2 + '.preparando'));
    fs.writeFileSync(cen.arquivo('versoes', 'minha-nota.txt'), 'nao e do atualizador');
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.deepEqual(cen.versoes(), [SHA1, 'minha-nota.txt']);
    dadosIguais(cen);
  });

/* ============ rodada de correcao 2 ===================================== */

const MESA_LIGADA = { midi: { simulado: false }, clientes: 0 };

test('contarReligacao: a 2a queda em ate 48 h da instalacao manda voltar (so se ha anterior)', () => {
  const t0 = Date.parse('2026-03-01T10:00:00Z');
  const h = 3600 * 1000;
  const novo = () => ({ instaladaEm: new Date(t0).toISOString(), religacoes: [], anterior: SHA1 });

  const a = novo();
  assert.equal(at.contarReligacao(a, t0 + 1 * h), false, '1a queda: so religa');
  assert.equal(a.religacoes.length, 1);
  assert.equal(at.contarReligacao(a, t0 + 5 * h), true, '2a queda: volta');

  const semAnterior = novo();
  at.contarReligacao(semAnterior, t0 + h, false);
  assert.equal(at.contarReligacao(semAnterior, t0 + 2 * h, false), false, 'sem anterior nao ha para onde voltar');

  const velha = novo();
  assert.equal(at.contarReligacao(velha, t0 + 49 * h), false, 'depois de 48 h nao conta');
  assert.deepEqual(velha.religacoes, []);
  assert.equal(at.contarReligacao(velha, t0 + 50 * h), false);

  const semData = { instaladaEm: null, religacoes: [], anterior: SHA1 };
  assert.equal(at.contarReligacao(semData, t0), false);
});

test('alvoDoConfig: porta lida com Number(), host do config quando nao for curinga', () => {
  assert.deepEqual(at.alvoDoConfig({ servidor: { porta: 9090, host: '127.0.0.2' } }), { host: '127.0.0.2', porta: 9090 });
  assert.deepEqual(at.alvoDoConfig({ servidor: { porta: '9090' } }), { host: '127.0.0.1', porta: 9090 });
  assert.deepEqual(at.alvoDoConfig({ servidor: { porta: 7000, host: 'localhost' } }), { host: 'localhost', porta: 7000 });
  for (const curinga of ['0.0.0.0', '::', '[::]', '', '   ', undefined, null, 5]) {
    assert.equal(at.alvoDoConfig({ servidor: { porta: 8080, host: curinga } }).host, '127.0.0.1', String(curinga));
  }
  assert.equal(at.alvoDoConfig({ servidor: { porta: 'abc' } }).porta, 8080);
  assert.equal(at.alvoDoConfig({ servidor: { porta: 70000 } }).porta, 8080);
  assert.equal(at.alvoDoConfig({ servidor: { porta: 8080, host: 'a b;c' } }).host, '127.0.0.1', 'host estranho');
  assert.deepEqual(at.alvoDoConfig(null), { host: '127.0.0.1', porta: 8080 });
});

test('casaAtualizador: so `node iniciar.js atualizar` desta instalacao', () => {
  const inst = 'C:\\Users\\Jo\u00e3o\\AppData\\Local\\Monitor01V96';
  assert.equal(at.casaAtualizador(`"C:\\Program Files\\nodejs\\node.exe" "${inst}\\iniciar.js" atualizar`, inst), true);
  assert.equal(at.casaAtualizador(`node ${inst}\\iniciar.js`, inst), false, 'o bridge nao e o atualizador');
  assert.equal(at.casaAtualizador(`node C:\\outra\\iniciar.js atualizar`, inst), false);
  assert.equal(at.casaAtualizador(null, inst), false);
});

cenario('vigia: a versao que sobe e cai de novo em menos de 48 h volta para a anterior e e recusada',
  {
    ligado: false,
    github: { sha: SHA2 },
    estadoInicial: { atual: SHA2, anterior: SHA1, instaladaEm: new Date().toISOString() },
    antes: (cen) => escreverProjeto(cen.arquivo('versoes', SHA2), { versao: 'v2', instalado: true })
  },
  async (cen) => {
    const r1 = await cen.rodar();
    assert.equal(r1.codigo, 0, r1.saida);
    assert.equal((await esperarAte(() => cen.status(), 'v2 subir')).falso, 'v2');
    assert.equal(cen.json().religacoes.length, 1);
    assert.equal(cen.json().atual, SHA2);

    await cen.matarBridges();
    const r2 = await cen.rodar();
    assert.equal(r2.codigo, 0, r2.saida);
    assert.equal((await esperarAte(() => cen.status(), 'v1 subir')).falso, 'v1');
    const e = cen.json();
    assert.equal(e.atual, SHA1);
    assert.equal(e.anterior, null);
    assert.deepEqual(e.recusadas, [SHA2]);
    assert.deepEqual(e.religacoes, []);
    assert.match(cen.log(), /caiu de novo em menos de 48 h/);
    dadosIguais(cen);
  });

test('pcAcabouDeLigar: so os primeiros 10 min depois de ligar o PC', () => {
  assert.equal(at.pcAcabouDeLigar(30), true);
  assert.equal(at.pcAcabouDeLigar(599), true);
  assert.equal(at.pcAcabouDeLigar(600), false);
  assert.equal(at.pcAcabouDeLigar(86400), false);
  assert.equal(at.pcAcabouDeLigar(NaN), false);
  assert.equal(at.pcAcabouDeLigar(-1), false);
});

cenario('vigia: programa fora logo depois de o PC ligar nao conta como queda da versao',
  {
    ligado: false,
    github: { sha: SHA2 },
    estadoInicial: { atual: SHA2, anterior: SHA1, instaladaEm: new Date().toISOString() },
    antes: (cen) => escreverProjeto(cen.arquivo('versoes', SHA2), { versao: 'v2', instalado: true })
  },
  async (cen) => {
    // Duas reinicializacoes seguidas (ex. Windows Update): a vigia religa a
    // mesma versao nas duas e nao volta para a anterior.
    for (const vez of [1, 2]) {
      if (vez === 2) await cen.matarBridges();
      const r = await cen.rodar({ MONITOR_ATUALIZAR_UPTIME_S: '60' });
      assert.equal(r.codigo, 0, r.saida);
      assert.equal((await esperarAte(() => cen.status(), 'v2 subir')).falso, 'v2');
    }
    const e = cen.json();
    assert.equal(e.atual, SHA2);
    assert.equal(e.anterior, SHA1);
    assert.deepEqual(e.recusadas, []);
    assert.equal((e.religacoes || []).length, 0);
    assert.match(cen.log(), /acabou de ligar/);
    dadosIguais(cen);
  });

cenario('pacote sem src/atualizar.js ou sem instalar/iniciar.js: recusa definitiva',
  { ligado: true },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2', semAtualizador: true });
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.deepEqual(cen.json().recusadas, [SHA2]);
    assert.match(cen.log(), /pacote sem src.atualizar\.js/);

    cen.gh.sha = SHA3;
    cen.gh.zips[SHA3] = zipDe(SHA3, { versao: 'v3', semLancador: true });
    cen.gravarJson({ ...cen.json(), ultimaConsulta: null });
    const r2 = await cen.rodar();
    assert.equal(r2.codigo, 0, r2.saida);
    assert.deepEqual(cen.json().recusadas, [SHA2, SHA3]);
    assert.match(cen.log(), /pacote sem instalar.iniciar\.js/);
    assert.deepEqual(cen.versoes(), [SHA1]);
  });

cenario('iniciar.js atualizar: se o atualizador da versao atual nao carrega, usa o da anterior',
  {
    ligado: false,
    github: { sha: SHA2 },
    estadoInicial: { atual: SHA2, anterior: SHA1 },
    antes: (cen) => escreverProjeto(cen.arquivo('versoes', SHA2), { versao: 'v2', instalado: true, atualizadorQuebrado: true })
  },
  async (cen) => {
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.match(cen.log(), /atualizador da versao 2222222 nao carregou/);
    assert.match(cen.log(), /usei o da 1111111/);
    assert.equal(cen.json().ultimoResultado, 'em dia', 'o atualizador da anterior rodou de verdade');
    assert.equal((await esperarAte(() => cen.status(), 'vigia ligar')).falso, 'v2');
  });

cenario('queda depois de mover o ponteiro, bridge novo no ar: nao troca por si mesma e preserva a anterior',
  {
    ligado: true,
    github: { sha: SHA2 },
    estadoInicial: {
      atual: SHA2, anterior: SHA1, alvo: SHA2, preparada: SHA2,
      emTroca: { de: SHA1, para: SHA2, anteriorAntes: null }
    },
    antes: (cen) => escreverProjeto(cen.arquivo('versoes', SHA2), { versao: 'v2', instalado: true })
  },
  async (cen) => {
    cen.statusMesa(SEGURA);
    assert.equal((await cen.status()).falso, 'v2');
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    const e = cen.json();
    assert.equal(e.atual, SHA2);
    assert.equal(e.anterior, SHA1, 'a anterior continua sendo a versao 1');
    assert.equal(e.emTroca, null);
    assert.equal(e.preparada, null);
    assert.equal(e.alvo, null);
    assert.doesNotMatch(cen.log(), /trocando para/);
    assert.equal(cen.pids().length, 1, 'o bridge nao foi reiniciado');
  });

cenario('host 127.0.0.2 e porta "9090" em texto no config, mesa ligada: nada e preparado nem trocado e o bridge nao morre',
  { ligado: true, config: { host: '127.0.0.2', portaTexto: true } },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2' });
    cen.statusMesa(MESA_LIGADA);
    for (let i = 0; i < 2; i++) {
      const r = await cen.rodar();
      assert.equal(r.codigo, 0, r.saida);
      assert.equal(cen.servidor.hits.zip, 0);
      assert.deepEqual(cen.versoes(), [SHA1]);
      assert.equal(cen.json().atual, SHA1);
      assert.equal((await cen.status()).falso, 'v1', 'o bridge segue no ar');
      assert.equal(cen.pids().length, 1);
    }
    assert.doesNotMatch(cen.log(), /liguei de novo/);
    dadosIguais(cen);
  });

cenario('bridge com processo vivo mas sem responder na porta nao e "fora do ar": nao liga outro nem troca',
  { ligado: false, v1: { modo: 'mudo' } },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2' });
    cen.ligarSemEsperar();
    await esperarAte(() => cen.pids().length === 1, 'bridge mudo iniciar');
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal(cen.pids().length, 1, 'nenhum segundo bridge');
    assert.equal(cen.servidor.hits.zip, 0, 'nada preparado');
    assert.equal(cen.json().atual, SHA1);
    assert.deepEqual(cen.versoes(), [SHA1]);
    assert.doesNotMatch(cen.log(), /liguei de novo/);
    assert.match(cen.log(), /respondeu de forma estranha/);
  });

cenario('o preparo roda npm e testes com MONITOR_DADOS numa pasta descartavel e sem MONITOR_INSTALACAO',
  { ligado: true },
  async (cen) => {
    const codigoTeste = [
      "const t = require('node:test'), a = require('node:assert'), fs = require('fs'), p = require('path');",
      "t('isolamento', () => {",
      "  a.ok(process.env.MONITOR_DADOS);",
      "  a.equal(process.env.MONITOR_INSTALACAO, undefined);",
      "  a.notEqual(p.resolve(process.env.MONITOR_DADOS), p.resolve(__dirname, '..', '..', '..'));",
      "  fs.writeFileSync(p.join(process.env.MONITOR_DADOS, 'config.json'), 'LIXO DO TESTE');",
      "});"
    ].join('\n');
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2', codigoTeste });
    cen.statusMesa(SEGURA);
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal(cen.json().atual, SHA2, 'os testes da candidata passaram (log: ' + cen.log() + ')');
    dadosIguais(cen);
    assert.doesNotMatch(fs.readFileSync(cen.arquivo('config.json'), 'latin1'), /LIXO DO TESTE/);
  });

cenario('trava orfa (atualizador morto no meio da troca): a proxima execucao recupera na hora, sem esperar 30 min',
  { ligado: true },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2', modo: 'mudo' });
    cen.statusMesa(SEGURA);
    const a = cen.iniciarAtualizador({ MONITOR_ATUALIZAR_ESPERA_MS: '120000' });
    await esperarAte(() => {
      try { const e = cen.json(); return e.emTroca && e.atual === SHA2; } catch { return false; }
    }, 'ponteiro movido e emTroca gravado', 90000);
    spawnSync('taskkill', ['/PID', String(a.filho.pid), '/T', '/F'], { windowsHide: true });
    await a.fim;
    assert.ok(fs.existsSync(cen.arquivo('atualizacao.lock')), 'a trava ficou para tras');
    assert.ok(cen.json().emTroca, 'e a troca ficou pela metade');

    const inicio = Date.now();
    const r = await cen.rodar({ MONITOR_ATUALIZAR_ESPERA_MS: '5000' });
    assert.equal(r.codigo, 0, r.saida);
    assert.ok(Date.now() - inicio < 120000);
    const e = cen.json();
    assert.equal(e.atual, SHA1, 'voltou o ponteiro');
    assert.equal(e.emTroca, null);
    assert.match(cen.log(), /troca interrompida/);
    assert.equal((await esperarAte(() => cen.status(), 'v1 de volta')).falso, 'v1');
    assert.equal(fs.existsSync(cen.arquivo('atualizacao.lock')), false);
    dadosIguais(cen);
  });

cenario('trava com PID de um processo vivo que nao e o atualizador desta instalacao e velha',
  { ligado: false, github: { sha: SHA1 } },
  async (cen) => {
    fs.writeFileSync(cen.arquivo('atualizacao.lock'), process.pid + ' ' + new Date().toISOString());
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal((await esperarAte(() => cen.status(), 'vigia ligar')).falso, 'v1', 'assumiu a trava');
  });

cenario('deixou de ser seguro antes do npm ci: para o preparo sem contar tentativa; depois prepara e troca',
  { ligado: true },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2' });
    cen.statusMesa({ sequencia: [SEGURA, SEGURA, { midi: { simulado: true }, clientes: 1 }] });
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    const e = cen.json();
    assert.deepEqual(e.tentativas, {});
    assert.deepEqual(e.recusadas, []);
    assert.equal(e.alvo, SHA2);
    assert.equal(e.ultimoResultado, at.RESULTADO.esperandoSeguro);
    assert.deepEqual(cen.versoes(), [SHA1]);
    assert.match(cen.log(), /deixou de ser seguro/);

    cen.statusMesa(SEGURA);
    const r2 = await cen.rodar();
    assert.equal(r2.codigo, 0, r2.saida);
    assert.equal(cen.json().atual, SHA2);
  });

cenario('npm ausente e problema de ambiente: nao conta tentativa nem recusa',
  { ligado: true },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2' });
    cen.statusMesa(SEGURA);
    const r = await cen.rodar({ MONITOR_ATUALIZAR_NPM_CLI: path.join(cen.base, 'nao-existe', 'npm-cli.js') });
    assert.equal(r.codigo, 0, r.saida);
    const e = cen.json();
    assert.deepEqual(e.tentativas, {});
    assert.deepEqual(e.recusadas, []);
    assert.equal(e.falhasRede, 1);
    assert.equal(e.alvo, SHA2);
    assert.equal(e.ultimoResultado, at.RESULTADO.semRede);
    assert.match(cen.log(), /npm nao encontrado/);
    assert.deepEqual(cen.versoes(), [SHA1]);
  });

cenario('lancador novo com erro de sintaxe nao substitui o atual',
  { ligado: true },
  async (cen) => {
    cen.gh.zips[SHA2] = zipDe(SHA2, { versao: 'v2', iniciarExtra: '\n)))( isto nao compila\n' });
    cen.statusMesa(SEGURA);
    const original = fs.readFileSync(cen.arquivo('iniciar.js'));
    const r = await cen.rodar();
    assert.equal(r.codigo, 0, r.saida);
    assert.equal(cen.json().atual, SHA2, 'a versao foi instalada');
    assert.equal(Buffer.compare(fs.readFileSync(cen.arquivo('iniciar.js')), original), 0, 'lancador intacto');
    assert.equal(fs.existsSync(cen.arquivo('iniciar.novo.js')), false);
    assert.match(cen.log(), /erro de sintaxe/);
  });

/* ============ /api/status mostra a versao instalada ==================== */

test('bridge: /api/status traz a versao lida de atualizacao.json na pasta de DADOS (e nao quebra sem o arquivo)', async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-versao-')));
  const prog = path.join(base, 'prog');
  const dados = path.join(base, 'dados');
  fs.mkdirSync(dados, { recursive: true });
  fs.cpSync(path.join(RAIZ, 'src'), path.join(prog, 'src'), { recursive: true });
  fs.cpSync(path.join(RAIZ, 'public'), path.join(prog, 'public'), { recursive: true });
  fs.copyFileSync(path.join(RAIZ, 'config.example.json'), path.join(prog, 'config.example.json'));
  const porta = await portaLivre();
  fs.writeFileSync(path.join(dados, 'config.json'), JSON.stringify({
    servidor: { porta, host: '127.0.0.1' },
    midi: { entrada: 'simulado', saida: 'simulado' },
    aplicarEstadoAoIniciar: false,
    controles: [{ id: 'guitarra', rotulo: 'Guitarra', tipo: 'canal', calibrado: false }]
  }));

  const filho = spawn(process.execPath, [path.join(prog, 'src', 'bridge.js')], {
    cwd: prog,
    env: { ...process.env, MONITOR_DADOS: dados, NODE_PATH: path.join(RAIZ, 'node_modules') },
    stdio: 'ignore',
    windowsHide: true
  });
  try {
    const sem = await esperarAte(() => pegarJson(porta), 'bridge subir');
    assert.deepEqual(sem.versao, { sha: null, instaladaEm: null, ultimoResultado: null }, 'sem atualizacao.json');

    fs.writeFileSync(path.join(dados, 'atualizacao.json'), JSON.stringify({
      atual: 'abcdef0123456789abcdef0123456789abcdef01',
      instaladaEm: '2026-03-04T05:06:07.000Z',
      ultimoResultado: 'em dia'
    }));
    const com = await pegarJson(porta);
    assert.deepEqual(com.versao, { sha: 'abcdef0', instaladaEm: '2026-03-04T05:06:07.000Z', ultimoResultado: 'em dia' });

    // com BOM (como o PowerShell 5 grava) tambem le
    fs.writeFileSync(path.join(dados, 'atualizacao.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ atual: 'abcdef0123456789abcdef0123456789abcdef01' }))]));
    assert.equal((await pegarJson(porta)).versao.sha, 'abcdef0');

    fs.writeFileSync(path.join(dados, 'atualizacao.json'), '{quebrado');
    assert.equal((await pegarJson(porta)).versao.sha, null, 'arquivo quebrado nao derruba o status');
  } finally {
    const saiu = new Promise((ok) => filho.once('exit', ok));
    filho.kill();
    await saiu;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
