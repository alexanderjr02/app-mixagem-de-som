'use strict';
/**
 * atualizar:agora de ponta a ponta (so Windows).
 *
 * O bridge DE VERDADE roda de uma instalacao temporaria (iniciar.js +
 * versoes\<sha>\, como no PC da igreja). Um celular conectado pede
 * "atualizar:agora"; o bridge abre o atualizador solto, pelo WMI (o mesmo jeito
 * que a vigia liga o bridge), e o atualizador, no modo agora, consulta na
 * hora (a ultima consulta foi agora ha pouco), prepara e roda os testes da
 * versao nova e troca, mesmo com o celular conectado. O "GitHub" e local
 * (127.0.0.1) e a versao nova e um bridge de mentirinha.
 *
 * O processo aberto pelo WMI nao herda o ambiente do teste, entao o lancador
 * da instalacao temporaria ja traz as variaveis de teste (MONITOR_TESTE=1 e o
 * endereco do GitHub local) no comeco do arquivo.
 *
 * Seguranca: tudo mora numa pasta temporaria; nunca toca na instalacao real,
 * em porta MIDI (a configuracao e "simulado") ou na internet. No fim, mata
 * todo node cuja linha de comando cite a instalacao temporaria.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const RAIZ = path.resolve(__dirname, '..');
const SKIP = process.platform === 'win32' ? false : 'a atualizacao automatica so existe no Windows';
const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);

const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function esperarAte(fn, descricao, ms = 30000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    const r = await fn();
    if (r) return r;
    await pausa(200);
  }
  throw new Error('esperei ' + ms + ' ms e nao aconteceu: ' + descricao);
}

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

function status(porta) {
  return new Promise((ok) => {
    const req = http.get({ host: '127.0.0.1', port: porta, path: '/api/status', timeout: 1500 }, (res) => {
      let t = '';
      res.on('data', (p) => { t += p; });
      res.on('end', () => { try { ok(JSON.parse(t)); } catch { ok(null); } });
    });
    req.on('error', () => ok(null));
    req.on('timeout', () => { req.destroy(); ok(null); });
  });
}

/** A versao nova: um bridge de mentirinha, com atualizador, lancador, lock sem dependencias e um teste. */
function escreverVersaoNova(pasta) {
  fs.mkdirSync(path.join(pasta, 'src'), { recursive: true });
  fs.mkdirSync(path.join(pasta, 'instalar'), { recursive: true });
  fs.mkdirSync(path.join(pasta, 'test'), { recursive: true });
  fs.writeFileSync(path.join(pasta, 'src', 'bridge.js'), [
    "'use strict';",
    "const http = require('http'), fs = require('fs'), path = require('path');",
    'const dados = process.env.MONITOR_DADOS;',
    "const t = fs.readFileSync(path.join(dados, 'config.json'), 'utf8');",
    "const porta = Number(JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t).servidor.porta);",
    "fs.appendFileSync(path.join(dados, '..', 'pids.txt'), process.pid + '\\n');",
    'http.createServer((req, res) => {',
    "  res.writeHead(200, { 'Content-Type': 'application/json' });",
    "  res.end(JSON.stringify({ falso: 'v2', midi: { simulado: false }, clientes: 3 }));",
    "}).listen(porta, '127.0.0.1');",
    'setTimeout(() => process.exit(0), 240000);',
    ''
  ].join('\n'));
  fs.copyFileSync(path.join(RAIZ, 'src', 'atualizar.js'), path.join(pasta, 'src', 'atualizar.js'));
  fs.copyFileSync(path.join(RAIZ, 'instalar', 'iniciar.js'), path.join(pasta, 'instalar', 'iniciar.js'));
  fs.writeFileSync(path.join(pasta, 'test', 'mini.test.js'), "require('node:test')('mini', () => {});\n");
  fs.writeFileSync(path.join(pasta, 'config.example.json'), '{}');
  fs.writeFileSync(path.join(pasta, 'package.json'), JSON.stringify({ name: 'mini', version: '2.0.0', private: true }));
  fs.writeFileSync(path.join(pasta, 'package-lock.json'), JSON.stringify({
    name: 'mini', version: '2.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'mini', version: '2.0.0' } }
  }));
}

/** Zip como o do GitHub: uma pasta app-mixagem-de-som-<sha> com tudo dentro. */
function zipDaVersaoNova(base) {
  const topo = path.join(base, 'zip', 'app-mixagem-de-som-' + SHA2);
  escreverVersaoNova(topo);
  const zip = path.join(base, 'zip', 'pacote.zip');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ProgressPreference='SilentlyContinue'; Compress-Archive -LiteralPath $env:TOPO -DestinationPath $env:ZIP -Force"],
  { env: { ...process.env, TOPO: topo, ZIP: zip }, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, 'Compress-Archive falhou: ' + r.stdout + r.stderr);
  return fs.readFileSync(zip);
}

/** node.exe cuja linha de comando cita a pasta (o bridge e o atualizador abertos pelo WMI). */
function nodesDaPasta(pasta) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); " +
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | " +
    'Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($env:PASTA.ToLower()) } | ' +
    'ForEach-Object { $_.ProcessId }'],
  { env: { ...process.env, PASTA: pasta }, encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}

test('atualizar:agora pelo app: o bridge abre o atualizador solto e ele troca de versao mesmo com celular conectado', { skip: SKIP, timeout: 300000 }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-agora-Jo\u00e3o-')));
  const inst = path.join(base, 'inst');
  const versao1 = path.join(inst, 'versoes', SHA1);
  const porta = await portaLivre();
  const zip = zipDaVersaoNova(base);

  const hits = { api: 0, zip: 0 };
  const github = http.createServer((req, res) => {
    if (req.url === '/commits/igreja') {
      hits.api++;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(SHA2);
      return;
    }
    if (req.url === '/zip/' + SHA2) {
      hits.zip++;
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(zip);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((ok) => github.listen(0, '127.0.0.1', ok));
  const url = 'http://127.0.0.1:' + github.address().port;

  // A instalacao: o bridge de verdade em versoes\<SHA1> (com o ws do projeto).
  for (const pasta of ['src', 'public']) fs.cpSync(path.join(RAIZ, pasta), path.join(versao1, pasta), { recursive: true });
  for (const arq of ['package.json', 'config.example.json']) fs.copyFileSync(path.join(RAIZ, arq), path.join(versao1, arq));
  fs.cpSync(path.join(RAIZ, 'node_modules', 'ws'), path.join(versao1, 'node_modules', 'ws'), { recursive: true });
  const ambiente = {
    MONITOR_TESTE: '1', MONITOR_ATUALIZAR_API: url, MONITOR_ATUALIZAR_ZIP: url,
    MONITOR_ATUALIZAR_PAUSA_MS: '100', MONITOR_ATUALIZAR_UPTIME_S: '86400', MONITOR_ATUALIZAR_ESPERA_MS: '30000'
  };
  const prefixo = Object.entries(ambiente).map(([k, v]) => 'process.env.' + k + ' = ' + JSON.stringify(v) + ';').join('\n');
  fs.writeFileSync(path.join(inst, 'iniciar.js'), prefixo + '\n' + fs.readFileSync(path.join(RAIZ, 'instalar', 'iniciar.js'), 'utf8'));
  fs.writeFileSync(path.join(inst, 'config.json'), JSON.stringify({
    servidor: { porta, host: '127.0.0.1' }, midi: { entrada: 'simulado', saida: 'simulado' }, controles: []
  }));
  // Consultou ha 5 minutos: sem o modo agora, so daqui a 55 min.
  fs.writeFileSync(path.join(inst, 'atualizacao.json'), JSON.stringify({
    atual: SHA1, anterior: null, emTroca: null, alvo: null, preparada: null, recusadas: [], tentativas: {},
    instaladaEm: '2026-01-01T00:00:00.000Z', ultimaConsulta: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    falhasRede: 0, ultimoResultado: 'em dia'
  }));

  const logBridge = fs.openSync(path.join(base, 'bridge-v1.log'), 'w');
  const v1 = spawn(process.execPath, [path.join(inst, 'iniciar.js')], { cwd: inst, stdio: ['ignore', logBridge, logBridge], windowsHide: true });
  const lerAgora = () => { try { return JSON.parse(fs.readFileSync(path.join(inst, 'atualizacao-agora.json'), 'utf8')); } catch { return null; } };
  const contexto = () => '\n--- bridge v1:\n' + fs.readFileSync(path.join(base, 'bridge-v1.log'), 'utf8').slice(-2000) +
    '\n--- atualizacao.log:\n' + (fs.existsSync(path.join(inst, 'atualizacao.log')) ? fs.readFileSync(path.join(inst, 'atualizacao.log'), 'utf8') : '');

  let ws = null;
  try {
    const s1 = await esperarAte(() => status(porta), 'o bridge de verdade subir pela instalacao', 20000);
    assert.equal(s1.versao.sha, '1111111', 'o bridge de verdade, lendo a instalacao temporaria');

    ws = new WebSocket('ws://127.0.0.1:' + porta);
    const estados = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'atualizar:estado') estados.push(m);
    });
    ws.on('error', () => { /* o bridge cai na troca: esperado */ });
    await new Promise((ok, erro) => { ws.once('open', ok); ws.once('error', erro); });
    assert.equal((await status(porta)).clientes, 1, 'com um celular conectado, o modo normal nao trocaria');

    ws.send(JSON.stringify({ type: 'atualizar:agora' }));
    const fim = await esperarAte(() => {
      const a = lerAgora();
      return a && (a.fase === 'em-dia' || a.fase === 'falhou') ? a : null;
    }, 'o atualizador terminar (atualizacao-agora.json)', 180000).catch((erro) => { throw new Error(erro.message + contexto()); });

    assert.equal(fim.fase, 'em-dia', JSON.stringify(fim) + contexto());
    assert.match(fim.mensagem, /2222222/);
    assert.match(fim.id, /^[0-9a-f]{16}$/);

    // O app acompanhou as fases ate o bridge velho ser parado na troca.
    const fases = estados.map((m) => m.fase);
    for (const f of ['verificando', 'baixando', 'testando']) assert.ok(fases.includes(f), 'faltou a fase ' + f + ': ' + fases.join(', '));
    assert.equal(fases.includes('falhou'), false, fases.join(', '));
    assert.ok(estados.every((m) => typeof m.mensagem === 'string' && !m.mensagem.includes(base)), 'mensagem com caminho');

    // Trocou: versao nova no ar, anterior guardada, testes do preparo rodados.
    const e = JSON.parse(fs.readFileSync(path.join(inst, 'atualizacao.json'), 'utf8'));
    assert.equal(e.atual, SHA2);
    assert.equal(e.anterior, SHA1);
    assert.equal(e.emTroca, null);
    assert.equal((await esperarAte(() => status(porta), 'a versao nova responder')).falso, 'v2');
    assert.deepEqual(hits, { api: 1, zip: 1 }, 'consultou na hora, sem esperar 1 h');
    const log = fs.readFileSync(path.join(inst, 'atualizacao.log'), 'utf8');
    assert.match(log, /pedido pelo app \(agora\)/);
    assert.match(log, /rodando os testes de 2222222/);
    assert.match(log, /atualizado para 2222222/);
    assert.ok(fs.existsSync(path.join(inst, 'versoes', SHA1, 'src', 'bridge.js')), 'a versao anterior ficou');
    // O atualizador saiu e soltou a trava.
    await esperarAte(() => !fs.existsSync(path.join(inst, 'atualizacao.lock')), 'a trava ser solta', 20000);
  } finally {
    if (ws) { try { ws.terminate(); } catch { /* ja fechou */ } }
    try { v1.kill(); } catch { /* ja saiu */ }
    // Mata o que o WMI abriu (bridge novo, atualizador se ainda estiver la).
    for (let i = 0; i < 20; i++) {
      const vivos = nodesDaPasta(base);
      if (!vivos.length) break;
      for (const pid of vivos) { try { process.kill(pid); } catch { /* ja saiu */ } }
      await pausa(300);
    }
    try { fs.closeSync(logBridge); } catch { /* ja fechou */ }
    await new Promise((ok) => { github.closeAllConnections?.(); github.close(ok); });
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(base, { recursive: true, force: true }); break; } catch { await pausa(300); }
    }
  }
});
