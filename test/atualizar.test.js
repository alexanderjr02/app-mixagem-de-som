'use strict';
/**
 * Decisoes da atualizacao automatica (src/atualizar.js): funcoes puras, rapidas
 * e sem PowerShell. Ficam na suite rapida, a que o PC da igreja roda antes de
 * instalar uma versao: o atualizador desta versao e quem vai fazer as
 * proximas atualizacoes, entao as decisoes dele sao conferidas la tambem.
 *
 * A integracao (o atualizar.js de verdade contra um "GitHub" local, com
 * PowerShell e processos soltos) esta em verificacao-completa/atualizador.verifica.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const at = require('../src/atualizar');

const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const SHA3 = '3'.repeat(40);

/* ======================= parte 1: funcoes puras ======================== */

test('shaValido: so 40 hexadecimais minusculos', () => {
  assert.equal(at.shaValido(SHA1), true);
  for (const ruim of ['', 'main', SHA1.slice(1), SHA1 + '0', 'G'.repeat(40), 'A'.repeat(40),
    SHA1.slice(0, 39) + '\n', '../' + SHA1, null, undefined, 123, {}]) {
    assert.equal(at.shaValido(ruim), false, String(ruim));
  }
});

test('deveConsultar: no maximo a cada 1 hora; falha de rede espera 30 min e depois 1 h', () => {
  const agora = Date.parse('2026-01-01T12:00:00Z');
  const h = 3600 * 1000;
  assert.equal(at.deveConsultar(null, agora), true);
  assert.equal(at.deveConsultar('lixo', agora), true);
  assert.equal(at.deveConsultar(new Date(agora - 0.99 * h).toISOString(), agora), false);
  assert.equal(at.deveConsultar(new Date(agora - 1 * h).toISOString(), agora), true);
  assert.equal(at.deveConsultar(new Date(agora + 5 * h).toISOString(), agora), true, 'relogio que voltou');

  const min = 60 * 1000;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9, 99].map(at.intervaloConsulta),
    [60 * min, 30 * min, 60 * min, 60 * min, 60 * min, 60 * min, 60 * min, 60 * min]);
});

test('opcoesDaLinha: "--agora" (com ou sem id) liga o modo agora; sem ele, nada muda', () => {
  const id = '0123456789abcdef';
  assert.deepEqual(at.opcoesDaLinha(['node', 'iniciar.js', 'atualizar']), {});
  assert.deepEqual(at.opcoesDaLinha(['node', 'iniciar.js', 'atualizar', '--agora', id]), { agora: { id } });
  assert.deepEqual(at.opcoesDaLinha(['node', 'iniciar.js', 'atualizar', '--agora']), { agora: { id: null } });
  assert.deepEqual(at.opcoesDaLinha(['node', 'iniciar.js', 'atualizar', '--agora', '../x']), { agora: { id: null } });
  assert.equal(at.DADOS_PROTEGIDOS.has('atualizacao-agora.json'), true);
  assert.deepEqual(at.FASES_AGORA, ['verificando', 'baixando', 'testando', 'trocando', 'em-dia', 'falhou']);
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

test('pcAcabouDeLigar: so os primeiros 10 min depois de ligar o PC', () => {
  assert.equal(at.pcAcabouDeLigar(30), true);
  assert.equal(at.pcAcabouDeLigar(599), true);
  assert.equal(at.pcAcabouDeLigar(600), false);
  assert.equal(at.pcAcabouDeLigar(86400), false);
  assert.equal(at.pcAcabouDeLigar(NaN), false);
  assert.equal(at.pcAcabouDeLigar(-1), false);
});
