'use strict';
/**
 * Testes do config.json e do estado.json. Tudo acontece numa pasta
 * temporaria (MONITOR_DADOS), para nunca encostar na calibracao de verdade.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-config-'));
process.env.MONITOR_DADOS = PASTA;
const config = require('../src/config');

function esvaziarPasta() {
  for (const nome of fs.readdirSync(PASTA)) fs.rmSync(path.join(PASTA, nome), { force: true });
}

function escreverConfig(objeto) {
  fs.writeFileSync(config.CAMINHO_CONFIG, JSON.stringify(objeto), 'utf8');
}

test.beforeEach(esvaziarPasta);
test.after(() => fs.rmSync(PASTA, { recursive: true, force: true }));

test('com MONITOR_DADOS, config e estado ficam fora da pasta do programa', () => {
  assert.equal(path.dirname(config.CAMINHO_CONFIG), PASTA);
  assert.equal(path.dirname(config.CAMINHO_ESTADO), PASTA);
  assert.notEqual(PASTA, config.RAIZ);
});

test('primeira execucao cria o config.json a partir do exemplo', () => {
  const cfg = config.carregar();
  assert.ok(fs.existsSync(config.CAMINHO_CONFIG));
  assert.deepEqual(cfg.controles, []);
  assert.equal(cfg.servidor.porta, 8080);
  assert.equal(cfg.midi.saida, null);
  assert.equal(cfg.aplicarEstadoAoIniciar, false);
});

test('mantem o que o usuario escreveu e completa o resto com padroes', () => {
  escreverConfig({ midi: { saida: '01V96' }, servidor: { porta: 9000 } });
  const cfg = config.carregar();
  assert.equal(cfg.midi.saida, '01V96');
  assert.equal(cfg.midi.intervaloEnvioMs, 25);
  assert.equal(cfg.midi.janelaEcoMs, 400);
  assert.equal(cfg.midi.esperaRespostaMs, 300);
  assert.equal(cfg.servidor.porta, 9000);
  assert.equal(cfg.servidor.host, '0.0.0.0');
  assert.deepEqual(cfg.controles, []);
});

test('recusa id de controle repetido', () => {
  escreverConfig({ controles: [{ id: 'bumbo' }, { id: 'bumbo' }] });
  assert.throws(() => config.carregar(), /repetido.*bumbo/);
});

test('recusa controle sem id', () => {
  escreverConfig({ controles: [{ rotulo: 'Sem nome' }] });
  assert.throws(() => config.carregar(), /sem "id"/);
});

test('explica quando o config.json tem erro de digitacao', () => {
  fs.writeFileSync(config.CAMINHO_CONFIG, '{ "midi": ', 'utf8');
  assert.throws(() => config.carregar(), /sintaxe JSON/);
});

test('salvar guarda a versao anterior em .bak', () => {
  escreverConfig({ controles: [{ id: 'antigo' }] });
  config.salvar({ controles: [{ id: 'novo' }] });
  const atual = JSON.parse(fs.readFileSync(config.CAMINHO_CONFIG, 'utf8'));
  const anterior = JSON.parse(fs.readFileSync(config.CAMINHO_CONFIG + '.bak', 'utf8'));
  assert.equal(atual.controles[0].id, 'novo');
  assert.equal(anterior.controles[0].id, 'antigo');
});

test('estado.json ausente ou estragado volta vazio, sem derrubar nada', () => {
  assert.deepEqual(config.carregarEstado(), { valores: {}, mutes: {} });
  fs.writeFileSync(config.CAMINHO_ESTADO, 'isso nao e json', 'utf8');
  assert.deepEqual(config.carregarEstado(), { valores: {}, mutes: {} });
});

test('estado.json salvo e lido de volta', () => {
  config.salvarEstado({ valores: { bumbo: 0.7 }, mutes: { bumbo: true } });
  assert.deepEqual(config.carregarEstado(), { valores: { bumbo: 0.7 }, mutes: { bumbo: true } });
});

test('gerarId transforma o nome em id sem acento nem espaco', () => {
  assert.equal(config.gerarId('Voz Principal'), 'voz-principal');
  assert.equal(config.gerarId('Ação de Graças'), 'acao-de-gracas');
  assert.equal(config.gerarId('  Bumbo!! '), 'bumbo');
  assert.equal(config.gerarId(''), 'controle');
  assert.equal(config.gerarId(null), 'controle');
  assert.equal(config.gerarId('!!!'), 'controle');
  assert.ok(config.gerarId('a'.repeat(50)).length <= 32);
});

test('idUnico numera nomes repetidos e preserva o id ao recalibrar', () => {
  assert.equal(config.idUnico('Bumbo', []), 'bumbo');
  assert.equal(config.idUnico('Bumbo', [{ id: 'bumbo' }]), 'bumbo-2');
  assert.equal(config.idUnico('Bumbo', [{ id: 'bumbo' }, { id: 'bumbo-2' }]), 'bumbo-3');
  assert.equal(config.idUnico('Bumbo', [{ id: 'bumbo' }], 'bumbo'), 'bumbo');
});

test('config.json e estado.json que comecam com BOM (EF BB BF) sao lidos normalmente', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const cfgJson = { servidor: { porta: 9191 }, controles: [{ id: 'voz', rotulo: 'Voz', tipo: 'canal', calibrado: false }] };
  fs.writeFileSync(config.CAMINHO_CONFIG, Buffer.concat([bom, Buffer.from(JSON.stringify(cfgJson))]));
  assert.equal(config.carregar().servidor.porta, 9191);

  fs.writeFileSync(config.CAMINHO_ESTADO, Buffer.concat([bom, Buffer.from('{"valores":{"voz":0.5},"mutes":{}}')]));
  assert.deepEqual(config.carregarEstado().valores, { voz: 0.5 });
});

test('salvar e salvarEstado gravam por arquivo temporario: nunca deixam .tmp nem arquivo pela metade', () => {
  escreverConfig({ controles: [] });
  const cfg = config.carregar();
  cfg.servidor.porta = 8123;
  config.salvar(cfg);
  config.salvarEstado({ valores: { a: 1 }, mutes: {} });
  assert.deepEqual(fs.readdirSync(PASTA).filter((n) => n.endsWith('.tmp')), []);
  assert.equal(JSON.parse(fs.readFileSync(config.CAMINHO_CONFIG, 'utf8')).servidor.porta, 8123);
  assert.deepEqual(config.carregarEstado().valores, { a: 1 });
});
