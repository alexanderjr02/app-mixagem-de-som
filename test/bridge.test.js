'use strict';
/**
 * Teste de ponta a ponta: sobe o bridge de verdade, conecta dois "celulares"
 * por WebSocket e faz a mesa falar pelo /api/simular.
 *
 * Seguranca: o config de teste forca MIDI "simulado" e mora numa pasta
 * temporaria. Mesmo rodando no Pi ligado na mesa, nada sai pelo cabo e a
 * calibracao de verdade nao e tocada.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const mesa = require('../src/yamaha01v96');

const RAIZ = path.resolve(__dirname, '..');
const CONFIG_REAL = path.join(RAIZ, 'config.json');

// Mesmo formato do test/yamaha01v96.test.js.
const MINIMO = [0xf0, 0x43, 0x10, 0x3e, 0x0d, 0x01, 0x1c, 0x00, 0x00, 0x00, 0x00, 0xf7];
const MAXIMO = [0xf0, 0x43, 0x10, 0x3e, 0x0d, 0x01, 0x1c, 0x00, 0x00, 0x01, 0x7f, 0xf7];

// O modo simulado so imprime um envio a cada 200 ms; esperar mais que isso
// entre dois envios garante que o segundo aparece no terminal.
const INTERVALO_IMPRESSAO = 250;

const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function esperarAte(condicao, descricao, ms = 3000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    const r = condicao();
    if (r) return r;
    await pausa(10);
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

function pedir(porta, metodo, caminho, corpo) {
  return new Promise((ok, erro) => {
    const req = http.request(
      { host: '127.0.0.1', port: porta, method: metodo, path: caminho,
        headers: corpo ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let texto = '';
        res.on('data', (p) => { texto += p; });
        res.on('end', () => ok({ status: res.statusCode, texto }));
      }
    );
    req.on('error', erro);
    if (corpo) req.write(JSON.stringify(corpo));
    req.end();
  });
}

/** Faz de conta que a mesa mandou esse quadro. */
async function mesaManda(porta, bytes) {
  const r = await pedir(porta, 'POST', '/api/simular', { hex: mesa.paraHex(bytes) });
  assert.equal(r.status, 200, r.texto);
}

async function conectarCelular(porta) {
  const ws = new WebSocket('ws://127.0.0.1:' + porta);
  const recebidas = [];
  const todas = []; // tudo que chegou, na ordem, para conferir sequencia
  const tempos = []; // quando cada uma de "todas" chegou
  ws.on('message', (dados) => {
    const msg = JSON.parse(dados.toString());
    recebidas.push(msg);
    todas.push(msg);
    tempos.push(Date.now());
  });
  await new Promise((ok, erro) => { ws.once('open', ok); ws.once('error', erro); });

  return {
    todas,
    tempos,
    enviar: (objeto) => ws.send(JSON.stringify(objeto)),
    /** Tira da fila a primeira mensagem desse tipo que passe no filtro. */
    receber(tipo, filtro = () => true, ms) {
      return esperarAte(() => {
        const i = recebidas.findIndex((m) => m.type === tipo && filtro(m));
        return i >= 0 ? recebidas.splice(i, 1)[0] : null;
      }, 'mensagem "' + tipo + '"', ms);
    },
    esquecer: () => { recebidas.length = 0; },
    /** Ja chegou alguma mensagem desse tipo (sem tirar da fila)? */
    viu: (tipo) => recebidas.some((m) => m.type === tipo),
    fechar: () => ws.close()
  };
}

/**
 * Sobe um bridge numa pasta de dados temporaria, com o config dado.
 * "antes" sao argumentos extras do node (usado para trocar o pacote MIDI).
 */
async function subirBridge({ config, estado, antes = [], env = {}, arquivos = {} }) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-bridge-'));
  const porta = await portaLivre();
  fs.writeFileSync(path.join(pasta, 'config.json'), JSON.stringify({
    ...config,
    servidor: { porta, host: '127.0.0.1' }
  }));
  if (estado) fs.writeFileSync(path.join(pasta, 'estado.json'), JSON.stringify(estado));
  for (const [nome, conteudo] of Object.entries(arquivos)) fs.writeFileSync(path.join(pasta, nome), conteudo);

  const filho = spawn(process.execPath, [...antes, path.join(RAIZ, 'src', 'bridge.js')], {
    cwd: RAIZ,
    env: { ...process.env, ...env, MONITOR_DADOS: pasta },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const linhas = [];
  let erros = '';
  let resto = '';
  filho.stdout.on('data', (pedaco) => {
    const partes = (resto + pedaco).split(/\r?\n/);
    resto = partes.pop();
    linhas.push(...partes);
  });
  filho.stderr.on('data', (pedaco) => { erros += pedaco; });

  let saiu = false;
  filho.once('exit', () => { saiu = true; });
  await esperarAte(() => {
    if (saiu) throw new Error('o bridge fechou ao iniciar:\n' + erros);
    return linhas.some((l) => l.includes('Monitor 01V96 no ar'));
  }, 'bridge iniciar', 10000);

  return {
    filho, pasta, porta, linhas,
    async parar() {
      const saida = new Promise((ok) => filho.once('exit', ok));
      filho.kill();
      await saida;
      fs.rmSync(pasta, { recursive: true, force: true });
    }
  };
}

let bridge;
let celularA;
let celularB;
let configRealAntes;

test.before(async () => {
  configRealAntes = fs.existsSync(CONFIG_REAL) ? fs.readFileSync(CONFIG_REAL, 'utf8') : null;

  bridge = await subirBridge({
    config: {
      midi: { entrada: 'simulado', saida: 'simulado', intervaloEnvioMs: 10, janelaEcoMs: 50 },
      aplicarEstadoAoIniciar: false,
      controles: [{ id: 'guitarra', rotulo: 'Guitarra', tipo: 'canal', calibrado: false }]
    }
  });
  celularA = await conectarCelular(bridge.porta);
  celularB = await conectarCelular(bridge.porta);
});

test.after(async () => {
  celularA?.fechar();
  celularB?.fechar();
  await bridge?.parar();
});

/** Espera o quadro exato aparecer no terminal do bridge como envio para a mesa. */
function esperarEnvio(desde, bytes) {
  const esperado = '[midi simulado] ' + mesa.paraHex(bytes);
  return esperarAte(
    () => bridge.linhas.slice(desde).some((l) => l.includes(esperado)),
    'envio ' + esperado
  );
}

function enviosDesde(desde) {
  return bridge.linhas.slice(desde).filter((l) => l.includes('[midi simulado]'));
}

test('o app abre pelo navegador', async () => {
  const pagina = await pedir(bridge.porta, 'GET', '/');
  assert.equal(pagina.status, 200);
  assert.match(pagina.texto, /<html/i);

  const api = JSON.parse((await pedir(bridge.porta, 'GET', '/api/controls')).texto);
  assert.deepEqual(api.controls, [{ id: 'guitarra', label: 'Guitarra', type: 'canal', calibrated: false }]);
});

test('nao entrega arquivos de fora da pasta public', async () => {
  for (const caminho of ['/%2e%2e%2fsrc%2fconfig.js', '/..%5csrc%5cconfig.js']) {
    const r = await pedir(bridge.porta, 'GET', caminho);
    assert.ok(r.status === 403 || r.status === 404, caminho + ' respondeu ' + r.status);
    assert.doesNotMatch(r.texto, /CAMINHO_CONFIG/);
  }
});

test('ao conectar, o celular recebe controles, situacao do MIDI e estado', async () => {
  const controles = await celularA.receber('controls');
  assert.equal(controles.controls[0].id, 'guitarra');

  const status = await celularA.receber('status');
  assert.equal(status.midi.simulado, true);
  assert.equal(status.rota, null, 'sem teste da mesa, nao ha rota');

  const estado = await celularA.receber('state');
  assert.equal(typeof estado.values.guitarra, 'number');
  celularB.esquecer();
});

test('controle nao calibrado muda a tela mas nunca manda nada para a mesa', async () => {
  const desde = bridge.linhas.length;
  celularA.enviar({ type: 'set', control: 'guitarra', value: 0.8 });

  const noOutro = await celularB.receber('state', (m) => 'guitarra' in m.values);
  assert.equal(noOutro.values.guitarra, 0.8);

  await pausa(INTERVALO_IMPRESSAO);
  assert.deepEqual(enviosDesde(desde), []);
});

test('calibracao pelo celular, do comeco ao fim', async () => {
  celularA.enviar({ type: 'learn:iniciar', control: null, label: 'Bumbo', kind: 'canal' });
  assert.equal((await celularA.receber('learn:pronto-para')).step, 'min');

  // Tocar em "capturei" sem a mesa ter falado nada vira explicacao, nao erro mudo.
  celularA.enviar({ type: 'learn:capturar', step: 'min' });
  assert.match((await celularA.receber('learn:erro')).message, /Parameter Change TX/);

  await mesaManda(bridge.porta, MINIMO);
  const aoVivo = await celularA.receber('learn:midi');
  assert.equal(aoVivo.count, 1);
  assert.equal(aoVivo.hex, mesa.paraHex(MINIMO));

  celularA.enviar({ type: 'learn:capturar', step: 'min' });
  const min = await celularA.receber('learn:capturado');
  assert.equal(min.proximo, 'max');

  await mesaManda(bridge.porta, MAXIMO);
  celularA.enviar({ type: 'learn:capturar', step: 'max' });
  const max = await celularA.receber('learn:capturado');
  assert.equal(max.proximo, 'fim');

  celularA.enviar({ type: 'learn:salvar' });
  const salvo = await celularA.receber('learn:salvo');
  assert.deepEqual(salvo.control, { id: 'bumbo', label: 'Bumbo', type: 'canal' });
  assert.deepEqual(salvo.bytes, { offset: 9, length: 2 });
  assert.deepEqual(salvo.faixa, { rawMin: 0, rawMax: 255 });

  // O outro celular fica sabendo do controle novo, ja calibrado.
  const lista = await celularB.receber('controls', (m) => m.controls.some((c) => c.id === 'bumbo'));
  assert.equal(lista.controls.find((c) => c.id === 'bumbo').calibrated, true);

  // E ficou gravado no config.json da pasta de dados.
  const gravado = JSON.parse(fs.readFileSync(path.join(bridge.pasta, 'config.json'), 'utf8'));
  const bumbo = gravado.controles.find((c) => c.id === 'bumbo');
  assert.deepEqual(bumbo.template, MINIMO);
  assert.equal(bumbo.valueOffset, 9);
});

test('mexer no fader manda para a mesa exatamente o quadro esperado', async () => {
  const bumbo = { calibrado: true, template: MINIMO, valueOffset: 9, valueLength: 2, rawMin: 0, rawMax: 255 };
  await pausa(INTERVALO_IMPRESSAO);

  let desde = bridge.linhas.length;
  celularA.enviar({ type: 'set', control: 'bumbo', value: 1 });
  await esperarEnvio(desde, MAXIMO);
  // O segundo celular fica igual (sem filtro exato pegaria o estado da calibracao).
  await celularB.receber('state', (m) => m.values.bumbo === 1);

  await pausa(INTERVALO_IMPRESSAO);
  desde = bridge.linhas.length;
  celularA.enviar({ type: 'set', control: 'bumbo', value: 0.5 });
  await esperarEnvio(desde, mesa.montarFrame(bumbo, 0.5));
});

test('mudo manda o minimo e mexer no fader de novo tira o mudo', async () => {
  await pausa(INTERVALO_IMPRESSAO);
  const desde = bridge.linhas.length;
  celularA.enviar({ type: 'mute', control: 'bumbo', muted: true });
  await esperarEnvio(desde, MINIMO);
  assert.equal((await celularB.receber('state', (m) => m.mutes.bumbo === true)).mutes.bumbo, true);

  celularA.enviar({ type: 'set', control: 'bumbo', value: 0.6 });
  const depois = await celularB.receber('state', (m) => m.values.bumbo === 0.6);
  assert.equal(depois.mutes.bumbo, false);
});

test('quando alguem mexe direto na mesa, os dois celulares acompanham', async () => {
  // Passa da janela de eco (50 ms neste config) para nao ser tomado como eco.
  await pausa(100);
  celularA.esquecer();
  celularB.esquecer();

  const bumbo = { calibrado: true, template: MINIMO, valueOffset: 9, valueLength: 2, rawMin: 0, rawMax: 255 };
  const quadro = mesa.montarFrame(bumbo, 0.25);
  await mesaManda(bridge.porta, quadro);

  const esperado = mesa.escalarParaNormalizado(mesa.lerValorDoFrame(bumbo, quadro), 0, 255);
  for (const celular of [celularA, celularB]) {
    const m = await celular.receber('state', (s) => 'bumbo' in s.values);
    assert.equal(m.values.bumbo, esperado);
  }
});

test('criar os outros canais sem a mesa no cabo e recusado, so para quem pediu', async () => {
  await pausa(INTERVALO_IMPRESSAO);
  const desde = bridge.linhas.length;

  celularA.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [2, 3] });
  assert.match((await celularA.receber('gerar:erro')).message, /cabo USB/);

  celularA.enviar({ type: 'gerar:canais', base: 'guitarra', canais: [2] });
  assert.match((await celularA.receber('gerar:erro')).message, /Calibre este canal/);

  celularA.enviar({ type: 'gerar:canais', base: 'nao-existe', canais: [2] });
  assert.match((await celularA.receber('gerar:erro')).message, /Nao achei/);

  await pausa(INTERVALO_IMPRESSAO);
  assert.equal(celularB.viu('gerar:erro'), false);
  assert.deepEqual(enviosDesde(desde), []);
});

test('enquanto alguem calibra, ninguem cria canais (a resposta da mesa cairia na calibracao)', async () => {
  celularA.enviar({ type: 'learn:iniciar', control: null, label: 'Caixa', kind: 'canal' });
  await celularA.receber('learn:pronto-para');

  celularB.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [2] });
  assert.match((await celularB.receber('gerar:erro')).message, /calibrando um controle agora/);
  assert.equal(celularA.viu('gerar:erro'), false);

  // Calibracao cancelada: a recusa passa a ser outra (aqui, a falta da mesa).
  celularA.enviar({ type: 'learn:cancelar' });
  await pausa(50);
  celularB.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [2] });
  assert.match((await celularB.receber('gerar:erro')).message, /cabo USB/);
});

test('testar a mesa sem ela no cabo e recusado, so para quem pediu, sem mandar nada', async () => {
  await pausa(INTERVALO_IMPRESSAO);
  const desde = bridge.linhas.length;
  celularB.esquecer();
  celularA.enviar({ type: 'mesa:testar' });
  assert.match((await celularA.receber('controle:erro')).message, /Ligue a mesa no cabo USB/);
  await pausa(INTERVALO_IMPRESSAO);
  assert.equal(celularA.viu('mesa:teste'), false);
  assert.equal(celularB.viu('controle:erro'), false);
  assert.deepEqual(enviosDesde(desde), []);
});

test('a lista do app diz o canal de quem serve de modelo para criar os outros', async () => {
  const { controls } = JSON.parse((await pedir(bridge.porta, 'GET', '/api/controls')).texto);
  const bumbo = controls.find((c) => c.id === 'bumbo');
  const guitarra = controls.find((c) => c.id === 'guitarra');
  assert.equal(bumbo.canal, 1);
  assert.equal(Object.hasOwn(guitarra, 'canal'), false, 'nao calibrado nao tem canal');
});

test('renomear muda so o nome, no app e no config.json', async () => {
  const lerBumbo = () => JSON.parse(fs.readFileSync(path.join(bridge.pasta, 'config.json'), 'utf8'))
    .controles.find((c) => c.id === 'bumbo');
  const antes = lerBumbo();

  celularA.enviar({ type: 'controle:renomear', control: 'bumbo', label: '  Bumbo do Joao  ' });
  const lista = await celularB.receber('controls', (m) => m.controls.some((c) => c.label === 'Bumbo do Joao'));
  const item = lista.controls.find((c) => c.id === 'bumbo');
  assert.equal(item.calibrated, true);
  assert.equal(item.canal, 1);

  const depois = lerBumbo();
  assert.equal(depois.rotulo, 'Bumbo do Joao');
  assert.deepEqual({ ...depois, rotulo: antes.rotulo }, antes, 'id e calibracao continuam iguais');

  celularA.enviar({ type: 'controle:renomear', control: 'bumbo', label: 'B'.repeat(60) });
  await celularB.receber('controls', (m) => m.controls.some((c) => c.label === 'B'.repeat(40)));

  celularA.enviar({ type: 'controle:renomear', control: 'bumbo', label: '   ' });
  assert.match((await celularA.receber('controle:erro')).message, /nome/);
  celularA.enviar({ type: 'controle:renomear', control: 'nao-existe', label: 'Teclado' });
  assert.match((await celularA.receber('controle:erro')).message, /Nao achei/);
  assert.equal(lerBumbo().rotulo, 'B'.repeat(40));
  assert.equal(celularB.viu('controle:erro'), false);
});

test('devolver o mix quando a mesa ligar se liga pelo celular, sem editar arquivo', async () => {
  const lerConfig = () => JSON.parse(fs.readFileSync(path.join(bridge.pasta, 'config.json'), 'utf8'));

  celularA.enviar({ type: 'config:devolverMix', ligado: true });
  await celularB.receber('status', (m) => m.devolverMix === true);
  assert.equal(lerConfig().aplicarEstadoAoIniciar, true);

  celularA.enviar({ type: 'config:devolverMix', ligado: false });
  await celularB.receber('status', (m) => m.devolverMix === false);
  assert.equal(lerConfig().aplicarEstadoAoIniciar, false);
});

test('remover um controle tira ele do app e do config.json', async () => {
  celularA.enviar({ type: 'controle:remover', control: 'guitarra' });
  await celularB.receber('controls', (m) => !m.controls.some((c) => c.id === 'guitarra'));

  const gravado = JSON.parse(fs.readFileSync(path.join(bridge.pasta, 'config.json'), 'utf8'));
  assert.deepEqual(gravado.controles.map((c) => c.id), ['bumbo']);
});

test('modo mapa sem mesa no cabo: o resumo diz que nao esta pronto, o fone mostra nomes padrao e mexer e recusado sem mandar nada', async () => {
  await pausa(INTERVALO_IMPRESSAO);
  celularA.esquecer();
  celularB.esquecer();
  const desde = bridge.linhas.length;
  const outro = await conectarCelular(bridge.porta);
  try {
    const resumo = await outro.receber('mesa:resumo');
    assert.deepEqual(resumo, {
      type: 'mesa:resumo', pronta: false,
      auxes: Array.from({ length: 8 }, (_, i) => ({ aux: i + 1, nome: 'Aux ' + (i + 1) })),
      resolucao: null, sincronizadaEm: null
    });
    celularA.enviar({ type: 'fone:escolher', aux: 2 });
    const e2 = await celularA.receber('fone:estado');
    assert.equal(e2.nome, 'Aux 2');
    assert.equal(e2.canais.length, 32);
    assert.ok(e2.canais.every((c) => c.valor === null && c.on === null && c.confirmado === false));
    celularA.enviar({ type: 'fone:send', aux: 2, canal: 1, valor: 0.7 });
    assert.match((await celularA.receber('controle:erro')).message, /Ligue a mesa/);
    celularA.enviar({ type: 'mesa:sincronizar' });
    assert.match((await celularA.receber('controle:erro')).message, /Ligue a mesa/);
    await pausa(INTERVALO_IMPRESSAO);
    assert.deepEqual(enviosDesde(desde), []);
    assert.equal(celularB.viu('fone:estado'), false, 'o outro celular nao escolheu fone');
    const s = JSON.parse((await pedir(bridge.porta, 'GET', '/api/status')).texto);
    assert.equal(s.mapa.ativo, true);
    assert.equal(s.mapa.pronta, false);
  } finally {
    outro.fechar();
  }
});

test('mensagem de mais de 64 KiB pelo WebSocket derruba so aquela conexao (1009); os outros celulares seguem', async () => {
  const ws = new WebSocket('ws://127.0.0.1:' + bridge.porta);
  ws.on('error', () => { /* o bridge fecha: esperado */ });
  await new Promise((ok, erro) => { ws.once('open', ok); ws.once('error', erro); });
  const fechou = new Promise((ok) => ws.once('close', (codigo) => ok(codigo)));
  ws.send(JSON.stringify({ type: 'ping', lixo: 'x'.repeat(70 * 1024) }));
  assert.equal(await fechou, 1009);
  celularA.esquecer();
  celularA.enviar({ type: 'ping' });
  await celularA.receber('pong');
});

test('atualizar:agora fora de uma instalacao do Windows e recusado, so para quem pediu, sem abrir nada', async () => {
  celularA.esquecer();
  celularB.esquecer();
  celularA.enviar({ type: 'atualizar:agora' });
  assert.match((await celularA.receber('controle:erro')).message, /instalado pelo instalador/);
  await pausa(100);
  assert.equal(celularA.viu('atualizar:estado'), false);
  assert.equal(celularB.viu('controle:erro'), false);
  assert.equal(bridge.linhas.some((l) => l.includes('[atualizar]')), false);
});

test('depois da atualizacao pedida pelo app, o bridge que sobe conta aos celulares como ela terminou', async () => {
  const id = '0123456789abcdef';
  const progresso = (fase, mensagem) => JSON.stringify({ id, fase, mensagem, em: new Date().toISOString() });
  const b = await subirBridge({
    config: { midi: { entrada: 'simulado', saida: 'simulado' }, controles: [] },
    arquivos: { 'atualizacao-agora.json': progresso('trocando', 'Trocando para a versao 2222222. O app reconecta sozinho.') }
  });
  const cel = await conectarCelular(b.porta);
  try {
    assert.deepEqual(await cel.receber('atualizar:estado'),
      { type: 'atualizar:estado', fase: 'trocando', mensagem: 'Trocando para a versao 2222222. O app reconecta sozinho.' });
    fs.writeFileSync(path.join(b.pasta, 'atualizacao-agora.json'), progresso('em-dia', 'Atualizado para a versao 2222222.'));
    assert.deepEqual(await cel.receber('atualizar:estado', (x) => x.fase === 'em-dia', 5000),
      { type: 'atualizar:estado', fase: 'em-dia', mensagem: 'Atualizado para a versao 2222222.' });
    // Quem conecta depois tambem fica sabendo como terminou.
    const outro = await conectarCelular(b.porta);
    assert.equal((await outro.receber('atualizar:estado')).fase, 'em-dia');
    outro.fechar();
    // Pedir de novo logo depois (menos de 10 min): devolve o resultado e nao abre nada.
    cel.esquecer();
    cel.enviar({ type: 'atualizar:agora' });
    assert.deepEqual(await cel.receber('atualizar:estado'),
      { type: 'atualizar:estado', fase: 'em-dia', mensagem: 'Atualizado para a versao 2222222.' });
    await pausa(150);
    assert.equal(cel.viu('controle:erro'), false);
    assert.equal(b.linhas.some((l) => l.includes('[atualizar] pedido pelo app')), false, 'abriu o atualizador de novo');
  } finally {
    cel.fechar();
    await b.parar();
  }
});

/** Le o estado.json sem ficar em cima do arquivo (no Windows, ler junto com o rename do bridge o faria falhar). */
async function esperarEstadoSalvo(pasta, condicao, descricao) {
  const arquivo = path.join(pasta, 'estado.json');
  const limite = Date.now() + 6000;
  while (Date.now() < limite) {
    try {
      const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      if (condicao(dados)) return dados;
    } catch { /* ainda nao gravou */ }
    await pausa(300);
  }
  throw new Error('estado.json nao chegou a ter ' + descricao);
}

test('sem mesa no cabo, a troca de cena so e registrada: nada vai para a mesa', async () => {
  await pausa(INTERVALO_IMPRESSAO);
  celularA.esquecer();
  celularB.esquecer();
  const desde = bridge.linhas.length;

  // Ja existe controle calibrado (bumbo), mas sem mesa nao ha o que reler.
  await mesaManda(bridge.porta, [0xc0, 0x02]);
  for (const celular of [celularA, celularB]) {
    const m = await celular.receber('cena', (x) => x.atual && x.atual.numero === 3);
    assert.deepEqual({ ...m.atual, em: typeof m.atual.em },
      { numero: 3, nome: null, em: 'string', origem: 'programa', bruto: 'C0 02' });
    assert.deepEqual(m.vistas, [3]);
  }

  // Programa #101 nao tem cena na tabela de fabrica: nao vira cena, fica no diagnostico.
  await mesaManda(bridge.porta, [0xc0, 0x64]);
  await pausa(700); // passa a espera da releitura (400 ms)
  assert.equal(celularA.viu('cena'), false);
  assert.equal(celularA.viu('cena:relida'), false);
  assert.deepEqual(enviosDesde(desde), [], 'saiu pedido para a mesa sem mesa');

  const status = JSON.parse((await pedir(bridge.porta, 'GET', '/api/status')).texto);
  assert.deepEqual({ ...status.cena, em: typeof status.cena.em },
    { numero: 3, origem: 'programa', bruto: 'C0 02', em: 'string' });
  assert.ok(status.avisos.some((l) => l.includes('Program Change sem cena') && l.includes('C0 64')));

  // A cena fica no estado.json, com a hora, para sobreviver a reinicio.
  const salvo = await esperarEstadoSalvo(bridge.pasta,
    (d) => d.cena && d.cena.atual && d.cena.atual.numero === 3, 'a cena 3');
  assert.deepEqual(salvo.cena.vistas, [3]);
  assert.equal(salvo.cena.atual.em, status.cena.em);
  assert.equal(salvo.cena.atual.bruto, 'C0 02');
});

test('o ultimo mix vai para o estado.json da pasta de dados', async () => {
  // O bridge grava 2 s depois da ultima mudanca; a primeira gravacao pode
  // ser de antes do bumbo existir, entao espera a que ja tem ele.
  const arquivo = path.join(bridge.pasta, 'estado.json');
  const salvo = await esperarAte(() => {
    try {
      const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      return typeof dados.valores.bumbo === 'number' ? dados : null;
    } catch {
      return null;
    }
  }, 'estado.json com o bumbo', 5000);
  assert.equal(salvo.mutes.bumbo, false);
});

/**
 * Mesa de mentira no lugar do pacote MIDI nativo, carregada com "node --require".
 * O teste controla por um arquivo quais portas existem e a "geracao" do cabo:
 * se a porta some, ou o cabo sai e volta (geracao nova), o envio pela porta
 * antiga falha, como acontece com a porta morta de verdade.
 *
 * Portas: "portas" vale para entradas e saidas (um nome so, como no Linux);
 * "entradas" e "saidas" separam os nomes, como o driver USB da Yamaha no
 * Windows ("YAMAHA USB IN 0-1" / "YAMAHA USB OUT 0-1").
 *
 * Canais e portas como na 01V96 (V2 p.215-218 e p.313-315), todos opcionais
 * (sem eles, o modelo antigo: aceita tudo e fala por todas as entradas):
 *   txCh          n com que a mesa MANDA (calibracao, cena): carimbado nos
 *                 quadros de "emitir".
 *   rxCh          n que a mesa ACEITA (Parameter change e request).
 *   rxLigado      false = PARAMETER CHANGE Rx OFF: nao aceita nada.
 *   portaRx       saida (PC -> mesa) pela qual ela aceita (GENERAL Rx PORT).
 *   portaTx       entrada (mesa -> PC) por onde saem os quadros de "emitir".
 *   portaResposta entrada por onde sai a resposta de um pedido.
 *   respostaCh    n da resposta (o manual diz Rx CH num lugar e Tx CH em
 *                 outro); sem ele, o rxCh, ou o n do pedido.
 * Cada quadro recebido vira duas linhas no terminal do bridge:
 * "[mesa falsa] #<geracao> <hex>" e "[mesa falsa] aceitou|ignorou <porta> | <hex>".
 * Abrir e fechar entrada tambem: "[mesa falsa] entrada aberta|fechada: <nome>".
 *
 * Ela responde Parameter request (F0 43 3n ...) aceito como o manual descreve:
 * devolve o Parameter change do mesmo endereco com o valor de "enderecos" no
 * arquivo ({ "0D 01 1C 00 00": [0, 64] }, bytes 4 a 8 do pedido) ou, sem ele,
 * de "respostas" ({ "2": [0, 64] } = canal 2 responde 64). Ausente nos dois =
 * a mesa fica calada. "atrasos" ({ endereco: ms }) faz a resposta daquele
 * endereco demorar.
 *
 * E faz a mesa falar sozinha, como quando a equipe chama uma cena: cada item
 * novo da fila "emitir" ([[1, "C0 02"], [2, "F0 43 ..."]]) vai uma vez, em
 * ordem (o arquivo e lido a cada 15 ms). "repetir" ("F0 43 ...") vai a cada
 * 15 ms enquanto estiver no arquivo: alguem mexendo num send sem parar.
 *
 * Com "guardar": true, ela lembra cada Parameter change aceito (o valor do
 * endereco muda de verdade) e responde os pedidos seguintes com ele: assim
 * da para ver que o que o app mandou ficou na mesa. Sem, nada muda.
 */
const MESA_FALSA = `
const Module = require('module');
const fs = require('fs');
const ARQUIVO = process.env.MESA_FALSA;
// Lido uma vez por callback: um lote de pedidos da leitura do mapa (mandado
// de uma vez, no mesmo callback) le o arquivo uma vez so, e o callback
// seguinte (outro timer, outra mensagem) ja le de novo e ve o que mudou.
let mesaDoCallback = null;
function mesa() {
  if (mesaDoCallback) return mesaDoCallback;
  try { mesaDoCallback = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')); } catch { mesaDoCallback = { portas: [], geracao: 0 }; }
  process.nextTick(() => { mesaDoCallback = null; });
  return mesaDoCallback;
}
const nomes = (m, lado) => (Array.isArray(m[lado]) ? m[lado] : m.portas) || [];
const ehN = (x) => Number.isInteger(x);
const entradasAbertas = new Set();
const hex = (bytes) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
function entregar(quadro, porta) {
  for (const entrada of entradasAbertas) {
    if (!entrada.aoReceber || (porta && entrada.aberta !== porta)) continue;
    entrada.aoReceber(0, quadro.slice());
  }
}
function comTx(m, quadro) {
  if (!ehN(m.txCh)) return quadro;
  const q = quadro.slice();
  if (q[0] === 0xf0 && q[1] === 0x43 && (q[2] & 0xf0) === 0x10) q[2] = 0x10 | m.txCh;
  else if (q.length === 2 && (q[0] & 0xf0) === 0xc0) q[0] = 0xc0 | m.txCh;
  return q;
}
function aceita(m, bytes, porta) {
  if (bytes[0] !== 0xf0 || bytes[1] !== 0x43) return false;
  if (m.rxLigado === false) return false;
  if (m.portaRx && porta !== m.portaRx) return false;
  if (ehN(m.rxCh) && (bytes[2] & 0x0f) !== m.rxCh) return false;
  return true;
}
const memoria = {};
function responderPedido(m, bytes) {
  const endereco = hex(bytes.slice(4, 9));
  const porEndereco = (m.guardar && memoria[endereco]) || (m.enderecos || {})[endereco];
  const valor = Array.isArray(porEndereco) ? porEndereco : (m.respostas || {})[String(bytes[8] + 1)];
  if (!Array.isArray(valor)) return;
  const n = ehN(m.respostaCh) ? m.respostaCh : ehN(m.rxCh) ? m.rxCh : bytes[2] & 0x0f;
  const quadro = [0xf0, 0x43, 0x10 | n, ...bytes.slice(3, 9), ...valor, 0xf7];
  const atraso = (m.atrasos || {})[endereco];
  setTimeout(() => entregar(quadro, m.portaResposta), Number.isFinite(atraso) ? atraso : 5);
}
let emitidos = 0;
setInterval(() => {
  const m = mesa();
  for (const [n, texto] of m.emitir || []) {
    if (n <= emitidos) continue;
    emitidos = n;
    entregar(comTx(m, texto.split(' ').map((h) => parseInt(h, 16))), m.portaTx);
  }
  if (m.repetir) entregar(comTx(m, m.repetir.split(' ').map((h) => parseInt(h, 16))), m.portaTx);
}, 15).unref();
class Porta {
  lado() { return 'saidas'; }
  getPortCount() { return nomes(mesa(), this.lado()).length; }
  getPortName(i) { return nomes(mesa(), this.lado())[i] || ''; }
  openPort(i) {
    const m = mesa();
    const nome = nomes(m, this.lado())[i];
    if (!nome) throw new Error('Invalid MIDI port number');
    this.aberta = nome;
    this.geracao = m.geracao;
  }
  closePort() { this.aberta = null; }
  openVirtualPort() {}
  ignoreTypes() {}
  on() {}
  sendMessage(bytes) {
    const m = mesa();
    if (!this.aberta || !nomes(m, 'saidas').includes(this.aberta) || m.geracao !== this.geracao) {
      throw new Error('Internal RtMidi error');
    }
    console.log('[mesa falsa] #' + this.geracao + ' ' + hex(bytes));
    const ok = aceita(m, bytes, this.aberta);
    console.log('[mesa falsa] ' + (ok ? 'aceitou ' : 'ignorou ') + this.aberta + ' | ' + hex(bytes));
    if (ok && (bytes[2] & 0xf0) === 0x30) responderPedido(m, bytes);
    if (ok && m.guardar && (bytes[2] & 0xf0) === 0x10 && bytes.length > 10) memoria[hex(bytes.slice(4, 9))] = bytes.slice(9, -1);
  }
}
class Entrada extends Porta {
  lado() { return 'entradas'; }
  on(evento, aoReceber) { if (evento === 'message') this.aoReceber = aoReceber; }
  openPort(i) {
    super.openPort(i);
    entradasAbertas.add(this);
    console.log('[mesa falsa] entrada aberta: ' + this.aberta);
  }
  closePort() {
    if (this.aberta) console.log('[mesa falsa] entrada fechada: ' + this.aberta);
    super.closePort();
    entradasAbertas.delete(this);
  }
}
const falso = { Input: Entrada, Output: Porta };
const carregar = Module._load;
Module._load = function (pedido, ...resto) {
  if (pedido === '@julusian/midi' || pedido === 'midi') return falso;
  return carregar.call(this, pedido, ...resto);
};
`;

/** Prepara a mesa de teste numa pasta temporaria; "fica" muda o que ela tem. */
function prepararMesaFalsa() {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-mesa-falsa-'));
  const preload = path.join(pasta, 'mesa-falsa.js');
  const arquivo = path.join(pasta, 'mesa.json');
  fs.writeFileSync(preload, MESA_FALSA);
  return {
    preload,
    arquivo,
    // Escreve e renomeia, para o bridge nunca ler o arquivo pela metade. No
    // Windows o rename falha (EPERM/EBUSY) se o bridge estiver lendo o arquivo
    // naquele instante; tenta de novo alguns milissegundos depois.
    fica(estado) {
      fs.writeFileSync(arquivo + '.tmp', JSON.stringify(estado));
      for (let tentativa = 1; ; tentativa++) {
        try {
          fs.renameSync(arquivo + '.tmp', arquivo);
          return;
        } catch (erro) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(erro.code) || tentativa >= 100) throw erro;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
    },
    apagar: () => fs.rmSync(pasta, { recursive: true, force: true })
  };
}

/** Quadros que o bridge mandou para a mesa de teste desde a linha "desde". */
function quadrosParaMesa(linhas, desde) {
  return linhas
    .slice(desde)
    .filter((l) => l.includes('[mesa falsa] #'))
    .map((l) => l.slice(l.indexOf('[mesa falsa] #')).split(' ').slice(3).map((h) => parseInt(h, 16)));
}

/** Os mesmos quadros, com a porta por onde chegaram e se a mesa aceitou. */
function chegadasNaMesa(linhas, desde = 0) {
  const marca = /\[mesa falsa\] (aceitou|ignorou) (.+) \| ([0-9A-F ]+)$/;
  return linhas.slice(desde).map((l) => l.match(marca)).filter(Boolean).map(([, resultado, porta, hex]) => ({
    aceitou: resultado === 'aceitou',
    porta,
    hex,
    bytes: hex.split(' ').map((h) => parseInt(h, 16))
  }));
}

/** Linhas do primeiro teste da mesa que comecou a partir de "desde" (do comeco ao fim). */
function linhasDoTeste(linhas, desde = 0) {
  const ini = linhas.findIndex((l, i) => i >= desde && l.includes('[mesa] teste da mesa comecou'));
  const fim = linhas.findIndex((l, i) => i > ini && l.includes('[mesa] fim do teste da mesa'));
  assert.ok(ini >= 0 && fim > ini, 'nao achei o comeco e o fim do teste da mesa no terminal');
  return { linhas: linhas.slice(ini, fim + 1), ini, fim };
}

/**
 * Rota ja confirmada (mesa com Rx CH = Tx CH = 1), para os testes que nao
 * sao sobre o teste da mesa: com ela, o bridge nao testa ao conectar.
 */
const rotaConfirmada = (saida = 'YAMAHA 01V96') =>
  ({ saida, entrada: saida, dispositivo: 0, em: '2026-10-01T10:00:00.000Z' });

/** Bridge com a mesa de teste; mesaFica junta mudancas ao que a mesa tem, mesaEmite faz ela falar. */
async function bridgeComMesa({ mesaInicial, config, estado }) {
  const mesaTeste = prepararMesaFalsa();
  let atual = { geracao: 1, emitir: [], ...mesaInicial };
  let seq = 0;
  mesaTeste.fica(atual);
  let b;
  try {
    b = await subirBridge({
      config, estado, antes: ['--require', mesaTeste.preload], env: { MESA_FALSA: mesaTeste.arquivo }
    });
  } catch (erro) {
    mesaTeste.apagar();
    throw erro;
  }
  return {
    b,
    mesaFica(mudancas) {
      atual = { ...atual, ...mudancas };
      mesaTeste.fica(atual);
    },
    mesaEmite(...mensagens) {
      atual = { ...atual, emitir: [...atual.emitir, ...mensagens.map((h) => [++seq, h])] };
      mesaTeste.fica(atual);
    },
    lerConfig: () => JSON.parse(fs.readFileSync(path.join(b.pasta, 'config.json'), 'utf8')),
    status: async () => JSON.parse((await pedir(b.porta, 'GET', '/api/status')).texto),
    async parar() {
      try {
        await b.parar();
      } finally {
        mesaTeste.apagar();
      }
    }
  };
}

test('PC ligado direto: a mesa desliga, liga de novo e o bridge volta sozinho', async () => {
  const mesaTeste = prepararMesaFalsa();
  const preload = mesaTeste.preload;
  const estadoMesa = mesaTeste.arquivo;
  const mesaFica = (portas, geracao) => mesaTeste.fica({ portas, geracao });
  mesaFica(['Microsoft GS Wavetable Synth', 'YAMAHA 01V96'], 1);

  const bumbo = { id: 'bumbo', rotulo: 'Bumbo', tipo: 'canal', calibrado: true,
    template: MINIMO, valueOffset: 9, valueLength: 2, rawMin: 0, rawMax: 255 };
  const b = await subirBridge({
    config: {
      midi: { entrada: null, saida: null, intervaloEnvioMs: 10, janelaEcoMs: 50, intervaloProcuraMs: 100,
        rota: rotaConfirmada(), mapa: false },
      aplicarEstadoAoIniciar: true,
      controles: [bumbo]
    },
    estado: { valores: { bumbo: 1 }, mutes: {} },
    antes: ['--require', preload],
    env: { MESA_FALSA: estadoMesa }
  });
  const celular = await conectarCelular(b.porta);
  const enviou = (geracao, bytes) => esperarAte(
    () => b.linhas.some((l) => l.includes('[mesa falsa] #' + geracao + ' ' + mesa.paraHex(bytes))),
    'mesa (cabo #' + geracao + ') receber ' + mesa.paraHex(bytes)
  );

  try {
    // Ligou com a mesa no cabo: acha sozinho e manda o ultimo mix.
    const inicio = await celular.receber('status');
    assert.equal(inicio.midi.simulado, false);
    assert.equal(inicio.midi.saida, 'YAMAHA 01V96');
    await enviou(1, MAXIMO);

    // Fim do culto, a mesa desliga: o celular fica sabendo.
    mesaFica(['Microsoft GS Wavetable Synth'], 1);
    await celular.receber('status', (m) => m.midi.simulado === true);

    // Domingo seguinte, a mesa liga: reconecta e reaplica o mix, sem reiniciar nada.
    mesaFica(['Microsoft GS Wavetable Synth', 'YAMAHA 01V96'], 2);
    const volta = await celular.receber('status', (m) => m.midi.simulado === false);
    assert.equal(volta.midi.saida, 'YAMAHA 01V96');
    await enviou(2, MAXIMO);

    // Alguem tira e poe o cabo rapido: o nome nunca saiu da lista, mas o envio
    // pela porta antiga falha. O bridge percebe, reabre e o fader volta a valer.
    mesaFica(['Microsoft GS Wavetable Synth', 'YAMAHA 01V96'], 3);
    celular.enviar({ type: 'set', control: 'bumbo', value: 0.5 });
    await enviou(3, mesa.montarFrame(bumbo, 0.5));
  } finally {
    celular.fechar();
    await b.parar();
    mesaTeste.apagar();
  }
});

test('criar os outros canais: so nasce controle no canal que a mesa confirmou', async (t) => {
  const mesaTeste = prepararMesaFalsa();
  const PORTAS = ['Microsoft GS Wavetable Synth', 'YAMAHA 01V96'];
  // Canais 2, 3 e 5 respondem; o 7 fica calado.
  const respostas = { 2: [0x00, 0x40], 3: [0x01, 0x00], 5: [0x01, 0x7f] };
  mesaTeste.fica({ portas: PORTAS, geracao: 1, respostas });

  const bumbo = { id: 'bumbo', rotulo: 'Bumbo', tipo: 'canal', valorInicial: 0.3, calibrado: true,
    template: MINIMO, valueOffset: 9, valueLength: 2, rawMin: 0, rawMax: 255 };
  // Canal 4 ja calibrado a mao, igualzinho ao que seria gerado.
  const caixa = { id: 'caixa', rotulo: 'Caixa', tipo: 'canal', ...mesa.controleParaCanal(bumbo, 4) };
  // Canal 6 calibrado a mao com a janela menor (so o byte de baixo mexeu): mesmo parametro.
  const tom = { id: 'tom', rotulo: 'Tom', tipo: 'canal', calibrado: true,
    template: [0xf0, 0x43, 0x10, 0x3e, 0x0d, 0x01, 0x1c, 0x00, 0x05, 0x00, 0x00, 0xf7],
    valueOffset: 10, valueLength: 1, rawMin: 0, rawMax: 127 };
  const reverb = { ...bumbo, id: 'reverb', rotulo: 'Reverb', tipo: 'reverb',
    template: [0xf0, 0x43, 0x10, 0x3e, 0x0d, 0x01, 0x1d, 0x00, 0x00, 0x00, 0x00, 0xf7] };
  const estranho = { ...bumbo, id: 'estranho', rotulo: 'Estranho',
    template: [0xf0, 0x43, 0x10, 0x3e, 0x7e, 0x01, 0x1c, 0x00, 0x00, 0x00, 0x00, 0xf7] };

  const b = await subirBridge({
    config: {
      midi: { entrada: null, saida: null, intervaloEnvioMs: 10, janelaEcoMs: 50,
        intervaloProcuraMs: 100, esperaRespostaMs: 600, rota: rotaConfirmada(), mapa: false },
      aplicarEstadoAoIniciar: false,
      controles: [bumbo, caixa, tom, reverb, estranho]
    },
    antes: ['--require', mesaTeste.preload],
    env: { MESA_FALSA: mesaTeste.arquivo }
  });
  const celular = await conectarCelular(b.porta);
  const lerConfig = () => JSON.parse(fs.readFileSync(path.join(b.pasta, 'config.json'), 'utf8'));
  const pedido = (canal) => mesa.montarPedido(bumbo, canal);

  try {
    assert.equal((await celular.receber('status')).midi.simulado, false);

    await t.test('a lista traz o canal so de quem serve de modelo', async () => {
      const { controls } = await celular.receber('controls');
      const canal = Object.fromEntries(controls.map((c) => [c.id, c.canal]));
      assert.deepEqual(canal, { bumbo: 1, caixa: 4, tom: 6, reverb: undefined, estranho: undefined });
      assert.equal(Object.hasOwn(controls.find((c) => c.id === 'reverb'), 'canal'), false);
    });

    await t.test('recusa modelo que nao serve e lista de canais invalida, sem mandar nada', async () => {
      const desde = b.linhas.length;
      const recusa = async (msg, motivo) => {
        celular.enviar({ type: 'gerar:canais', ...msg });
        assert.match((await celular.receber('gerar:erro')).message, motivo, JSON.stringify(msg));
      };
      await recusa({ base: 'reverb', canais: [2] }, /a partir de um canal/);
      await recusa({ base: 'estranho', canais: [2] }, /formato do manual da 01V96, calibre os canais um a um/);
      for (const canais of ['2', [0], [33], [1.5], ['2'], Array.from({ length: 33 }, () => 2)]) {
        await recusa({ base: 'bumbo', canais }, /canais de 1 a 32/);
      }
      await recusa({ base: 'bumbo', canais: [] }, /pelo menos um canal/);
      await pausa(50);
      assert.deepEqual(quadrosParaMesa(b.linhas, desde), []);
    });

    await t.test('confere canal por canal com pedido de leitura e cria so os confirmados', async () => {
      celular.esquecer();
      const desde = b.linhas.length;
      celular.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [7, 1, 2, 3, 4, 5, 6, 2] });

      const fim = await celular.receber('gerar:fim', () => true, 5000);
      assert.deepEqual(fim, {
        type: 'gerar:fim',
        criados: [
          { id: 'canal-2', label: 'Canal 2', canal: 2 },
          { id: 'canal-3', label: 'Canal 3', canal: 3 },
          { id: 'canal-5', label: 'Canal 5', canal: 5 }
        ],
        semResposta: [7],
        jaExistiam: [1, 4, 6],
        interrompido: false
      });

      const progresso = [];
      for (let i = 0; i < 4; i++) {
        const { canal, feitos, total, confirmado } = await celular.receber('gerar:progresso');
        progresso.push([canal, feitos, total, confirmado]);
      }
      assert.deepEqual(progresso, [[2, 1, 4, true], [3, 2, 4, true], [5, 3, 4, true], [7, 4, 4, false]]);

      // Os celulares recebem a lista nova e o valor que a mesa informou.
      const { controls } = await celular.receber('controls', (m) => m.controls.some((c) => c.id === 'canal-5'));
      const canal2 = controls.find((c) => c.id === 'canal-2');
      assert.deepEqual(canal2, { id: 'canal-2', label: 'Canal 2', type: 'canal', calibrated: true, canal: 2 });
      assert.equal(controls.some((c) => c.id === 'canal-7'), false, 'canal calado nao vira controle');
      const estado = await celular.receber('state', (m) => 'canal-2' in m.values);
      assert.equal(estado.values['canal-2'], 64 / 255);
      assert.equal(estado.values['canal-3'], 128 / 255);
      assert.equal(estado.values['canal-5'], 1);
      assert.equal(estado.mutes['canal-2'], false);

      // Gravado no config.json, depois dos que ja existiam, em ordem de canal.
      const gravado = lerConfig().controles;
      assert.deepEqual(gravado.map((c) => c.id),
        ['bumbo', 'caixa', 'tom', 'reverb', 'estranho', 'canal-2', 'canal-3', 'canal-5']);
      assert.deepEqual(gravado[6], {
        id: 'canal-3', rotulo: 'Canal 3', tipo: 'canal', valorInicial: 0.3, calibrado: true,
        template: [0xf0, 0x43, 0x10, 0x3e, 0x0d, 0x01, 0x1c, 0x00, 0x02, 0x00, 0x00, 0xf7],
        valueOffset: 9, valueLength: 2, rawMin: 0, rawMax: 255, geradoDe: 'bumbo'
      });

      // Seguranca: so sairam pedidos de leitura, um por canal conferido, e
      // nada de Parameter change, nem depois (o app so espelha a mesa).
      await pausa(200);
      const quadros = quadrosParaMesa(b.linhas, desde);
      assert.deepEqual(quadros, [pedido(2), pedido(3), pedido(5), pedido(7)]);
      for (const q of quadros) assert.equal(q[2] & 0xf0, 0x30, 'saiu algo que nao e pedido: ' + mesa.paraHex(q));
    });

    await t.test('mexer num canal criado manda o Parameter change com o byte do canal certo', async () => {
      const desde = b.linhas.length;
      celular.enviar({ type: 'set', control: 'canal-3', value: 1 });
      await esperarAte(
        () => quadrosParaMesa(b.linhas, desde).some((q) => mesa.paraHex(q) === 'F0 43 10 3E 0D 01 1C 00 02 01 7F F7'),
        'Parameter change do canal 3 no maximo'
      );
    });

    await t.test('o celular que pediu pode sair: a mesa confirma e todos recebem', async () => {
      mesaTeste.fica({ portas: PORTAS, geracao: 1, respostas: { ...respostas, 9: [0x00, 0x20] } });
      const outro = await conectarCelular(b.porta);
      outro.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [9] });
      outro.fechar();

      await celular.receber('controls', (m) => m.controls.some((c) => c.id === 'canal-9'));
      const estado = await celular.receber('state', (m) => 'canal-9' in m.values);
      assert.equal(estado.values['canal-9'], 32 / 255);
      assert.equal(lerConfig().controles.some((c) => c.id === 'canal-9'), true);
    });

    await t.test('criando canais, a calibracao nao abre e o app volta para o passo do nome', async () => {
      mesaTeste.fica({ portas: PORTAS, geracao: 1, respostas: { ...respostas, 16: [0x00, 0x30] } });
      celular.esquecer();

      // Canal 15 fica calado: a geracao fica 600 ms esperando a mesa.
      celular.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [15] });
      celular.enviar({ type: 'learn:iniciar', control: null, label: 'Caixa', kind: 'canal' });
      assert.deepEqual(await celular.receber('learn:erro'), {
        type: 'learn:erro',
        message: 'Estou criando canais agora. Espere terminar para calibrar.',
        etapa: 'nome'
      });
      assert.deepEqual((await celular.receber('gerar:fim', () => true, 5000)).semResposta, [15]);
      assert.equal(celular.viu('learn:pronto-para'), false);

      // Nenhuma sessao de calibracao ficou aberta: a proxima geracao passa.
      celular.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [16] });
      const fim = await celular.receber('gerar:fim', () => true, 5000);
      assert.deepEqual(fim.criados, [{ id: 'canal-16', label: 'Canal 16', canal: 16 }]);
    });

    await t.test('uma geracao por vez; se a mesa some no meio, salva o que ja confirmou', async () => {
      mesaTeste.fica({ portas: PORTAS, geracao: 1, respostas: { ...respostas, 8: [0x00, 0x10] } });
      celular.esquecer();
      const desde = b.linhas.length;

      celular.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [8, 10, 11, 12] });
      celular.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [13] });
      assert.match((await celular.receber('gerar:erro')).message, /criando canais agora/);

      assert.equal((await celular.receber('gerar:progresso', (m) => m.canal === 8)).confirmado, true);
      mesaTeste.fica({ portas: ['Microsoft GS Wavetable Synth'], geracao: 1, respostas });

      const fim = await celular.receber('gerar:fim', () => true, 5000);
      assert.equal(fim.interrompido, true);
      assert.deepEqual(fim.criados, [{ id: 'canal-8', label: 'Canal 8', canal: 8 }]);
      assert.equal(lerConfig().controles.some((c) => c.id === 'canal-8'), true);
      const pedidos = quadrosParaMesa(b.linhas, desde).map((q) => mesa.paraHex(q));
      assert.equal(pedidos.includes(mesa.paraHex(pedido(12))), false, 'continuou pedindo com a mesa fora');
      assert.equal(pedidos.includes(mesa.paraHex(pedido(13))), false);

      // Terminou: a trava solta, e sem mesa a resposta e pedir o cabo.
      await celular.receber('status', (m) => m.midi.simulado === true);
      celular.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [14] });
      assert.match((await celular.receber('gerar:erro')).message, /cabo USB/);
    });
  } finally {
    celular.fechar();
    await b.parar();
    mesaTeste.apagar();
  }
});

test('a ultima cena e os nomes voltam depois de reiniciar o programa', async () => {
  const em = '2026-10-05T10:00:00.000Z';
  const b = await subirBridge({
    config: {
      midi: { entrada: 'simulado', saida: 'simulado' },
      controles: [],
      // So o que e valido chega no app: numero de 0 a 99 e nome com texto.
      cenas: { 3: 'Pedro', 120: 'Nao existe', 5: '   ', 7: 42 }
    },
    estado: {
      valores: {},
      mutes: {},
      cena: { atual: { numero: 3, em, origem: 'programa', bruto: 'C0 02' }, vistas: [5, 3, 3, 200, 'x'] }
    }
  });
  const celular = await conectarCelular(b.porta);
  try {
    assert.deepEqual(await celular.receber('cena'), {
      type: 'cena',
      atual: { numero: 3, nome: 'Pedro', em, origem: 'programa', bruto: 'C0 02' },
      nomes: { 3: 'Pedro' },
      vistas: [3, 5]
    });
    const status = JSON.parse((await pedir(b.porta, 'GET', '/api/status')).texto);
    assert.deepEqual(status.cena, { numero: 3, origem: 'programa', bruto: 'C0 02', em });
  } finally {
    celular.fechar();
    await b.parar();
  }
});

test('troca de cena na mesa: o app mostra a cena e rele os faders so com pedidos de leitura', async (t) => {
  const mesaTeste = prepararMesaFalsa();
  const PORTAS = ['Microsoft GS Wavetable Synth', 'YAMAHA 01V96'];

  const bumbo = { id: 'bumbo', rotulo: 'Bumbo', tipo: 'canal', calibrado: true,
    template: MINIMO, valueOffset: 9, valueLength: 2, rawMin: 0, rawMax: 255 };
  const caixa = { id: 'caixa', rotulo: 'Caixa', tipo: 'canal', ...mesa.controleParaCanal(bumbo, 2) };
  const reverb = { ...bumbo, id: 'reverb', rotulo: 'Reverb', tipo: 'reverb',
    template: [0xf0, 0x43, 0x10, 0x3e, 0x0d, 0x01, 0x1d, 0x00, 0x00, 0x00, 0x00, 0xf7] };
  // Volume geral: cc fora de 0..31, nao serve de modelo de canal, mas e relido.
  const master = { ...bumbo, id: 'master', rotulo: 'Volume geral', tipo: 'master',
    template: [0xf0, 0x43, 0x10, 0x3e, 0x0d, 0x01, 0x20, 0x00, 0x40, 0x00, 0x00, 0xf7] };
  // Fora do formato do manual e sem calibracao: nunca sao pedidos.
  const estranho = { ...bumbo, id: 'estranho', rotulo: 'Estranho',
    template: [0xf0, 0x43, 0x10, 0x3e, 0x7e, 0x01, 0x1c, 0x00, 0x00, 0x00, 0x00, 0xf7] };
  const guitarra = { id: 'guitarra', rotulo: 'Guitarra', tipo: 'canal', calibrado: false };

  const endereco = (c) => mesa.paraHex(c.template.slice(4, 9));
  const pedido = (c) => mesa.montarPedidoDoControle(c);
  const TODOS = [pedido(bumbo), pedido(caixa), pedido(reverb), pedido(master)];
  // Bumbo 64, caixa 128, reverb no maximo; o volume geral fica calado.
  const VALORES = {
    [endereco(bumbo)]: [0x00, 0x40],
    [endereco(caixa)]: [0x01, 0x00],
    [endereco(reverb)]: [0x01, 0x7f]
  };

  let atual = { portas: PORTAS, geracao: 1, enderecos: VALORES, atrasos: {}, emitir: [] };
  let seq = 0;
  const mesaFica = (mudancas) => {
    atual = { ...atual, ...mudancas };
    mesaTeste.fica(atual);
  };
  /** A mesa manda essas mensagens sozinha, na ordem (como ao chamar uma cena). */
  const mesaEmite = (...mensagens) => mesaFica({ emitir: [...atual.emitir, ...mensagens.map((h) => [++seq, h])] });
  mesaFica({});

  const b = await subirBridge({
    config: {
      midi: { entrada: null, saida: null, intervaloEnvioMs: 10, janelaEcoMs: 50,
        intervaloProcuraMs: 100, esperaRespostaMs: 300, rota: rotaConfirmada(), mapa: false },
      aplicarEstadoAoIniciar: false,
      controles: [bumbo, caixa, reverb, master, estranho, guitarra]
    },
    // O bumbo estava mudo no app: a cena nova tem som nele, entao o mudo sai.
    estado: { valores: { bumbo: 0.9 }, mutes: { bumbo: true } },
    antes: ['--require', mesaTeste.preload],
    env: { MESA_FALSA: mesaTeste.arquivo }
  });
  const celular = await conectarCelular(b.porta);
  const outro = await conectarCelular(b.porta);
  const lerConfig = () => JSON.parse(fs.readFileSync(path.join(b.pasta, 'config.json'), 'utf8'));
  const quadrosDesde = (desde) => quadrosParaMesa(b.linhas, desde);
  const soPedidos = (quadros) => {
    for (const q of quadros) assert.equal(q[2] & 0xf0, 0x30, 'saiu algo que nao e pedido: ' + mesa.paraHex(q));
  };
  const cenaNumero = (n) => (m) => m.atual !== null && m.atual.numero === n;

  try {
    assert.equal((await celular.receber('status')).midi.simulado, false);
    assert.deepEqual(await celular.receber('cena'), { type: 'cena', atual: null, nomes: {}, vistas: [] });

    await t.test('a mesa chama uma cena: todos recebem o numero e a mensagem bruta, e os faders sao relidos', async () => {
      celular.esquecer();
      const marca = celular.todas.length;
      const desde = b.linhas.length;
      mesaEmite('C0 02');

      for (const c of [celular, outro]) {
        const m = await c.receber('cena', cenaNumero(3));
        assert.deepEqual({ ...m.atual, em: typeof m.atual.em },
          { numero: 3, nome: null, em: 'string', origem: 'programa', bruto: 'C0 02' });
        assert.ok(!Number.isNaN(Date.parse(m.atual.em)));
        assert.deepEqual(m.vistas, [3]);
        assert.deepEqual(m.nomes, {});
      }

      const relida = await celular.receber('cena:relida', () => true, 5000);
      assert.deepEqual(relida,
        { type: 'cena:relida', numero: 3, lidos: ['bumbo', 'caixa', 'reverb'], semResposta: ['master'] });

      // Os valores vem pelo "state" de sempre, antes do aviso de fim.
      const depois = celular.todas.slice(marca);
      const iState = depois.findIndex((m) => m.type === 'state' && 'bumbo' in m.values);
      const iRelida = depois.findIndex((m) => m.type === 'cena:relida');
      assert.ok(iState >= 0 && iState < iRelida, 'state depois do cena:relida');
      assert.deepEqual(depois[iState].values, { bumbo: 64 / 255, caixa: 128 / 255, reverb: 1 });
      assert.deepEqual(depois[iState].mutes, { bumbo: false, caixa: false, reverb: false });
      await outro.receber('state', (m) => m.values.bumbo === 64 / 255);

      // Seguranca: um pedido de leitura por controle no formato do manual, e
      // nenhum Parameter change, nem depois.
      await pausa(300);
      const quadros = quadrosDesde(desde);
      assert.deepEqual(quadros, TODOS);
      soPedidos(quadros);

      // "Copiar diagnostico" mostra o numero e a mensagem bruta.
      const status = JSON.parse((await pedir(b.porta, 'GET', '/api/status')).texto);
      assert.deepEqual({ ...status.cena, em: typeof status.cena.em },
        { numero: 3, origem: 'programa', bruto: 'C0 02', em: 'string' });
    });

    await t.test('Program Change e SysEx do mesmo recall contam uma vez so', async () => {
      celular.esquecer();
      const desde = b.linhas.length;
      mesaEmite('C0 03', 'F0 43 10 3E 7F 10 01 00 04 00 00 F7');

      const m = await celular.receber('cena', cenaNumero(4));
      assert.equal(m.atual.origem, 'programa');
      assert.equal(m.atual.bruto, 'C0 03');
      assert.equal((await celular.receber('cena:relida', () => true, 5000)).numero, 4);
      await pausa(400);
      assert.equal(celular.viu('cena'), false, 'o mesmo recall virou duas trocas');
      assert.equal(celular.viu('cena:relida'), false, 'releu duas vezes');
      assert.deepEqual(quadrosDesde(desde), TODOS);

      // So o SysEx de funcao (Program Change que nao vale para a cena).
      mesaEmite('F0 43 10 3E 7F 10 01 00 0A 00 00 F7');
      const f = await celular.receber('cena', cenaNumero(10));
      assert.equal(f.atual.origem, 'funcao');
      assert.equal(f.atual.bruto, 'F0 43 10 3E 7F 10 01 00 0A 00 00 F7');
      assert.deepEqual(f.vistas, [3, 4, 10]);
      await celular.receber('cena:relida', (x) => x.numero === 10, 5000);
    });

    await t.test('relendo, calibrar e criar canais sao recusados; troca nova no meio reinicia a releitura', async () => {
      mesaFica({ enderecos: {} }); // mesa calada: cada pedido espera 300 ms
      celular.esquecer();
      const desde = b.linhas.length;
      mesaEmite('C0 04'); // cena 5
      await esperarAte(() => quadrosDesde(desde).length >= 1, 'primeiro pedido da releitura');

      celular.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [3] });
      assert.match((await celular.receber('gerar:erro')).message, /relendo a mesa/);
      celular.enviar({ type: 'learn:iniciar', control: null, label: 'Teclado', kind: 'canal' });
      assert.deepEqual(await celular.receber('learn:erro'), {
        type: 'learn:erro',
        message: 'Estou relendo a mesa depois da troca de cena. Espere uns segundos para calibrar.',
        etapa: 'nome'
      });

      mesaEmite('C0 05'); // cena 6, com a releitura da 5 no meio
      await celular.receber('cena', cenaNumero(6));
      const relida = await celular.receber('cena:relida', () => true, 5000);
      assert.deepEqual(relida,
        { type: 'cena:relida', numero: 6, lidos: [], semResposta: ['bumbo', 'caixa', 'reverb', 'master'] });
      assert.equal(celular.viu('cena:relida'), false, 'a releitura interrompida da cena 5 avisou fim');
      assert.equal(celular.viu('learn:pronto-para'), false);

      const quadros = quadrosDesde(desde);
      soPedidos(quadros);
      assert.deepEqual(quadros.slice(-4), TODOS, 'a releitura da cena 6 recomecou do primeiro controle');
      assert.ok(quadros.length < 8, 'a releitura da cena 5 foi ate o fim: ' + quadros.length);
    });

    await t.test('com calibracao aberta, a releitura espera e a cena nao vira quadro de calibracao', async () => {
      mesaFica({ enderecos: VALORES });
      celular.esquecer();
      celular.enviar({ type: 'learn:iniciar', control: null, label: 'Teclado', kind: 'canal' });
      await celular.receber('learn:pronto-para');
      const desde = b.linhas.length;

      try {
        mesaEmite('C0 06', 'F0 43 10 3E 7F 10 01 00 07 00 00 F7'); // cena 7, pelas duas vias
        await celular.receber('cena', cenaNumero(7));
        await pausa(700); // passa a espera da releitura
        assert.equal(celular.viu('learn:midi'), false, 'mensagem de cena chegou na calibracao');
        assert.deepEqual(quadrosDesde(desde), [], 'releu com a calibracao aberta');

        // A calibracao nao guardou nada da cena: capturar ainda pede para mexer na mesa.
        celular.enviar({ type: 'learn:capturar', step: 'min' });
        assert.match((await celular.receber('learn:erro')).message, /Parameter Change TX/);
      } finally {
        // Calibracao cancelada: a releitura que esperava roda agora.
        celular.enviar({ type: 'learn:cancelar' });
      }
      assert.equal((await celular.receber('cena:relida', () => true, 5000)).numero, 7);
      assert.deepEqual(quadrosDesde(desde), TODOS);
    });

    await t.test('resposta atrasada nao cai no controle seguinte nem na calibracao aberta logo depois', async () => {
      // O bumbo responde 1,2 s depois do pedido (a espera e 300 ms), com outro valor.
      mesaFica({ enderecos: { ...VALORES, [endereco(bumbo)]: [0x00, 0x11] }, atrasos: { [endereco(bumbo)]: 1200 } });
      celular.esquecer();
      mesaEmite('C0 07'); // cena 8

      const relida = await celular.receber('cena:relida', (x) => x.numero === 8, 5000);
      assert.deepEqual(relida.lidos, ['caixa', 'reverb']);
      assert.deepEqual(relida.semResposta, ['bumbo', 'master']);
      const lidos = await celular.receber('state', (m) => 'caixa' in m.values);
      assert.deepEqual(lidos.values, { caixa: 128 / 255, reverb: 1 }, 'a resposta do bumbo caiu em outro controle');

      // Calibracao aberta logo em seguida: a resposta atrasada do bumbo chega
      // durante ela e vale so como o valor do proprio bumbo.
      celular.enviar({ type: 'learn:iniciar', control: null, label: 'Teclado', kind: 'canal' });
      await celular.receber('learn:pronto-para');
      try {
        const atrasada = await celular.receber('state', (m) => 'bumbo' in m.values, 3000);
        assert.equal(atrasada.values.bumbo, 0x11 / 255);
        assert.equal(celular.viu('learn:midi'), false, 'a resposta atrasada virou quadro de calibracao');
        celular.enviar({ type: 'learn:capturar', step: 'min' });
        assert.match((await celular.receber('learn:erro')).message, /Parameter Change TX/);
      } finally {
        celular.enviar({ type: 'learn:cancelar' });
        mesaFica({ enderecos: VALORES, atrasos: {} });
      }
    });

    await t.test('criando canais, a releitura espera a criacao terminar', async () => {
      celular.esquecer();
      const marca = celular.todas.length;
      const desde = b.linhas.length;

      // Canais 20 e 21 calados: a criacao fica 2 x 300 ms esperando a mesa.
      celular.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [20, 21] });
      await esperarAte(() => quadrosDesde(desde).length >= 1, 'primeiro pedido da criacao');
      mesaEmite('C0 08'); // cena 9
      await celular.receber('cena', cenaNumero(9));

      assert.deepEqual((await celular.receber('gerar:fim', () => true, 5000)).semResposta, [20, 21]);
      const relida = await celular.receber('cena:relida', (x) => x.numero === 9, 5000);
      assert.deepEqual(relida.lidos, ['bumbo', 'caixa', 'reverb']);

      const ordem = celular.todas.slice(marca).map((m) => m.type);
      assert.ok(ordem.indexOf('gerar:fim') < ordem.indexOf('cena:relida'));
      // Na mesa: primeiro os pedidos da criacao, depois os da releitura, sem misturar.
      const quadros = quadrosDesde(desde);
      assert.deepEqual(quadros, [mesa.montarPedido(bumbo, 20), mesa.montarPedido(bumbo, 21), ...TODOS]);
      soPedidos(quadros);
    });

    await t.test('dar nome a cena: todos recebem e fica no config.json', async () => {
      celular.esquecer();
      outro.esquecer();

      celular.enviar({ type: 'cena:nomear', numero: 3, nome: '  Pedro  ' });
      let m = await outro.receber('cena', (x) => x.nomes['3'] === 'Pedro');
      assert.deepEqual(m.nomes, { 3: 'Pedro' });
      assert.deepEqual({ numero: m.atual.numero, nome: m.atual.nome }, { numero: 9, nome: null });
      await celular.receber('cena', (x) => x.nomes['3'] === 'Pedro'); // quem pediu tambem recebe
      assert.deepEqual(lerConfig().cenas, { 3: 'Pedro' });

      // A cena atual com nome; no maximo 30 letras.
      const longo = 'Louvor ' + 'x'.repeat(40);
      celular.enviar({ type: 'cena:nomear', numero: 9, nome: longo });
      m = await outro.receber('cena', (x) => '9' in x.nomes);
      assert.equal(m.atual.nome, longo.slice(0, 30));
      assert.deepEqual(lerConfig().cenas, { 3: 'Pedro', 9: longo.slice(0, 30) });

      // Nome vazio apaga.
      celular.enviar({ type: 'cena:nomear', numero: 3, nome: '   ' });
      await outro.receber('cena', (x) => !('3' in x.nomes));
      assert.deepEqual(lerConfig().cenas, { 9: longo.slice(0, 30) });

      for (const msg of [{ numero: 100, nome: 'x' }, { numero: -1, nome: 'x' }, { numero: 1.5, nome: 'x' },
        { numero: '3', nome: 'x' }, { nome: 'x' }, { numero: 3, nome: 42 }]) {
        celular.enviar({ type: 'cena:nomear', ...msg });
        assert.match((await celular.receber('controle:erro')).message, /Cena invalida|texto/, JSON.stringify(msg));
      }
      await pausa(100);
      assert.equal(outro.viu('controle:erro'), false);
      assert.deepEqual(lerConfig().cenas, { 9: longo.slice(0, 30) }, 'pedido invalido mexeu no config');
      // A calibracao continua inteira no config.json.
      assert.deepEqual(lerConfig().controles.map((c) => c.id),
        ['bumbo', 'caixa', 'reverb', 'master', 'estranho', 'guitarra']);
    });

    await t.test('a ultima cena vista fica no estado.json', async () => {
      const salvo = await esperarEstadoSalvo(b.pasta,
        (d) => d.cena && d.cena.atual && d.cena.atual.numero === 9, 'a cena 9');
      assert.deepEqual(salvo.cena.vistas, [3, 4, 5, 6, 7, 8, 9, 10]);
      assert.equal(salvo.cena.atual.origem, 'programa');
      assert.equal(salvo.cena.atual.bruto, 'C0 08');
    });
  } finally {
    celular.fechar();
    outro.fechar();
    await b.parar();
    mesaTeste.apagar();
  }
});

// ---------------------------------------------------------------------------
// Teste da mesa (descoberta da rota): a 01V96 so aceita com o n do Rx CH e
// pela porta do GENERAL Rx PORT (V2 p.215-218 e p.313-315).
// ---------------------------------------------------------------------------

const USB = {
  in1: 'YAMAHA USB IN 0-1',
  in2: 'YAMAHA USB IN 0-2',
  out1: 'YAMAHA USB OUT 0-1',
  out2: 'YAMAHA USB OUT 0-2'
};
const SINTETIZADOR = 'Microsoft GS Wavetable Synth';

// mapa: false = plano B (so controles calibrados), como antes do modo mapa.
// Os testes do modo mapa ficam no fim do arquivo.
const midiDeTeste = {
  entrada: null, saida: null, intervaloEnvioMs: 10, janelaEcoMs: 50,
  intervaloProcuraMs: 100, esperaRespostaMs: 300, esperaTesteMs: 100, mapa: false
};

/** Bumbo calibrado no canal 1, com o molde que a mesa mandou com o n do Tx CH. */
function bumboDoTx(txCh) {
  const template = MINIMO.slice();
  template[2] = 0x10 | txCh;
  return { id: 'bumbo', rotulo: 'Bumbo', tipo: 'canal', calibrado: true,
    template, valueOffset: 9, valueLength: 2, rawMin: 0, rawMax: 255 };
}

const pedidoHex = (controle, n) => mesa.paraHex(mesa.montarPedidoDoControle(controle, n));
const ehPedido = (chegada) => (chegada.bytes[2] & 0xf0) === 0x30;

test('Rx CH diferente do Tx CH: a primeira calibracao testa a mesa, acha o canal certo e ela passa a obedecer', async (t) => {
  // A mesa manda com Tx CH 2 (n = 1) e so aceita com Rx CH 4 (n = 3).
  const m = await bridgeComMesa({
    mesaInicial: {
      entradas: [USB.in1], saidas: [SINTETIZADOR, USB.out1, USB.out2],
      txCh: 1, rxCh: 3, portaRx: USB.out1, portaTx: USB.in1, portaResposta: USB.in1,
      respostas: { 1: [0x00, 0x20], 2: [0x00, 0x40], 3: [0x01, 0x00] }
    },
    config: { midi: midiDeTeste, aplicarEstadoAoIniciar: false, controles: [] }
  });
  const { b } = m;
  const celular = await conectarCelular(b.porta);
  const molde = bumboDoTx(1);

  try {
    const inicio = await celular.receber('status');
    assert.equal(inicio.midi.saida, USB.out1);
    assert.equal(inicio.rota, null);

    await t.test('sem controle calibrado nao ha teste; o botao explica o que falta', async () => {
      celular.enviar({ type: 'mesa:testar' });
      assert.match((await celular.receber('controle:erro')).message, /Calibre um controle primeiro/);
      await pausa(200);
      assert.deepEqual(chegadasNaMesa(b.linhas), []);
      assert.equal(celular.viu('mesa:teste'), false);
    });

    await t.test('salvar a primeira calibracao testa a mesa e acha o canal MIDI 4, so com pedidos de leitura', async () => {
      celular.enviar({ type: 'learn:iniciar', control: null, label: 'Bumbo', kind: 'canal' });
      await celular.receber('learn:pronto-para');
      m.mesaEmite(mesa.paraHex(MINIMO)); // a mesa carimba o n do Tx CH
      assert.equal((await celular.receber('learn:midi')).hex, mesa.paraHex(molde.template));
      celular.enviar({ type: 'learn:capturar', step: 'min' });
      await celular.receber('learn:capturado');
      await pausa(250); // o aviso ao vivo vai no maximo 5 vezes por segundo
      m.mesaEmite(mesa.paraHex(MAXIMO));
      await celular.receber('learn:midi');
      celular.enviar({ type: 'learn:capturar', step: 'max' });
      await celular.receber('learn:capturado');

      celular.esquecer();
      const desde = b.linhas.length;
      celular.enviar({ type: 'learn:salvar' });
      await celular.receber('learn:salvo');
      assert.deepEqual(await celular.receber('mesa:teste'),
        { type: 'mesa:teste', fase: 'testando', rota: null, testados: 0, motivo: null, conferir: [] });
      assert.deepEqual(await celular.receber('mesa:teste', () => true, 5000), {
        type: 'mesa:teste', fase: 'ok',
        rota: { saida: USB.out1, entrada: USB.in1, canalMidi: 4, reconfirmada: true },
        testados: 4, motivo: null, conferir: []
      });
      const status = await celular.receber('status', (x) => x.rota !== null);
      assert.deepEqual({ ...status.rota, em: typeof status.rota.em },
        { saida: USB.out1, canalMidi: 4, em: 'string', reconfirmada: true });

      // Na mesa: so pedidos de leitura, um por vez: o n do molde (1), 0, 2, 3,
      // a confirmacao do 3 e a contra-prova com o 4 (a mesa fica calada).
      const chegadas = chegadasNaMesa(b.linhas, desde);
      assert.deepEqual(chegadas.map((c) => c.hex), [1, 0, 2, 3, 3, 4].map((n) => pedidoHex(molde, n)));
      assert.deepEqual(chegadas.map((c) => c.aceitou), [false, false, false, true, true, false]);
      assert.ok(chegadas.every(ehPedido), 'saiu Parameter change durante o teste');

      // Gravado no config.json: a saida e a rota.
      const { midi } = m.lerConfig();
      assert.equal(midi.saida, USB.out1);
      assert.deepEqual({ ...midi.rota, em: typeof midi.rota.em },
        { saida: USB.out1, entrada: USB.in1, dispositivo: 3, em: 'string', reconfirmada: true });
      assert.equal(midi.rota.em, status.rota.em);
    });

    await t.test('o fader do celular sai com o n da rota (1 3) e a mesa aceita', async () => {
      const desde = b.linhas.length;
      celular.enviar({ type: 'set', control: 'bumbo', value: 1 });
      const esperado = 'F0 43 13 3E 0D 01 1C 00 00 01 7F F7';
      await esperarAte(() => chegadasNaMesa(b.linhas, desde).some((c) => c.hex === esperado && c.aceitou),
        'a mesa aceitar ' + esperado);
      assert.deepEqual(chegadasNaMesa(b.linhas, desde).filter((c) => !c.aceitou), [], 'saiu quadro que a mesa ignora');
    });

    await t.test('criar os outros canais funciona direto, com os pedidos no n da rota', async () => {
      celular.esquecer();
      const desde = b.linhas.length;
      celular.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [2, 3] });
      const fim = await celular.receber('gerar:fim', () => true, 5000);
      assert.deepEqual(fim.criados,
        [{ id: 'canal-2', label: 'Canal 2', canal: 2 }, { id: 'canal-3', label: 'Canal 3', canal: 3 }]);
      assert.deepEqual(fim.semResposta, []);
      assert.equal(celular.viu('mesa:teste'), false, 'testou de novo com a rota confirmada');
      const chegadas = chegadasNaMesa(b.linhas, desde);
      assert.deepEqual(chegadas.map((c) => c.hex), [2, 3].map((canal) => mesa.paraHex(mesa.montarPedido(molde, canal, 3))));
      assert.ok(chegadas.every((c) => c.aceitou));
      const estado = await celular.receber('state', (x) => 'canal-3' in x.values);
      assert.equal(estado.values['canal-3'], 128 / 255);

      // O canal criado guarda o molde do Tx, mas escreve com o n da rota.
      const desde2 = b.linhas.length;
      celular.enviar({ type: 'set', control: 'canal-3', value: 1 });
      await esperarAte(() => chegadasNaMesa(b.linhas, desde2)
        .some((c) => c.hex === 'F0 43 13 3E 0D 01 1C 00 02 01 7F F7' && c.aceitou), 'a mesa aceitar o canal 3');
    });

    await t.test('criando canais, testar a mesa e recusado; depois o teste confirma de primeira', async () => {
      celular.esquecer();
      celular.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [20] }); // canal 20 calado: 300 ms
      celular.enviar({ type: 'mesa:testar' });
      assert.match((await celular.receber('controle:erro')).message, /criando canais/);
      await celular.receber('gerar:fim', () => true, 5000);

      const desde = b.linhas.length;
      celular.enviar({ type: 'mesa:testar' });
      const ok = await celular.receber('mesa:teste', (x) => x.fase !== 'testando', 5000);
      assert.equal(ok.fase, 'ok');
      assert.equal(ok.testados, 1, 'o n da rota e o primeiro testado');
      assert.equal(ok.rota.canalMidi, 4);
      assert.deepEqual(chegadasNaMesa(b.linhas, desde).map((c) => c.hex),
        [pedidoHex(molde, 3), pedidoHex(molde, 3), pedidoHex(molde, 4)]);
    });

    await t.test('caixa preta no /api/status: rota, ultimas mensagens com a porta e os moldes em hex', async () => {
      // Arrastar o fader: varias mensagens do mesmo endereco viram uma linha so.
      for (const v of [0.1, 0.2, 0.3, 0.4, 0.5]) {
        celular.enviar({ type: 'set', control: 'bumbo', value: v });
        await pausa(30);
      }
      await pausa(100);
      const s = await m.status();
      assert.deepEqual({ ...s.rota, em: typeof s.rota.em }, { saida: USB.out1, entrada: USB.in1, dispositivo: 3,
        canalMidi: 4, em: 'string', reconfirmada: true, valeParaSaidaAberta: true });
      assert.ok(s.ultimosMidi.length > 0 && s.ultimosMidi.length <= 40);
      for (const x of s.ultimosMidi) {
        assert.deepEqual(Object.keys(x).sort(), ['dir', 'em', 'hex', 'porta', 'vezes']);
        assert.equal(new Date(x.em).toISOString(), x.em);
        assert.ok(x.dir === 'entrada' || x.dir === 'saida');
      }
      assert.ok(s.ultimosMidi.some((x) => x.dir === 'saida' && x.porta === USB.out1 && x.hex === pedidoHex(molde, 3)),
        'o pedido do teste, com a porta');
      assert.ok(s.ultimosMidi.some((x) => x.dir === 'entrada' && x.porta === USB.in1 &&
        x.hex === 'F0 43 13 3E 0D 01 1C 00 00 00 20 F7'), 'a resposta da mesa, com a porta');
      const arrasto = s.ultimosMidi.filter((x) => x.dir === 'saida' && x.hex.startsWith('F0 43 13 3E 0D 01 1C 00 00 '));
      assert.equal(arrasto.at(-1).hex, mesa.paraHex(mesa.montarFrame(molde, 0.5, 3)));
      assert.ok(arrasto.at(-1).vezes >= 3, 'o arrasto virou ' + arrasto.length + ' linhas');

      assert.deepEqual(s.controlesHex.map((c) => c.id), ['bumbo', 'canal-2', 'canal-3']);
      // O molde guarda o n do Tx (11); o que sai de verdade leva o n da rota (13).
      assert.deepEqual(s.controlesHex[0], { id: 'bumbo', rotulo: 'Bumbo',
        hex: 'F0 43 11 3E 0D 01 1C 00 00 00 00 F7', offset: 9, length: 2, rawMin: 0, rawMax: 255, enviaCom: 'F0 43 13' });
      assert.equal(s.midi.entradaResposta, null, 'a resposta vem pela entrada principal');
    });

    await t.test('porta trocada pelo app com calibracao aberta: o fader na porta nova nao usa o n da rota velha', async () => {
      celular.esquecer();
      celular.enviar({ type: 'learn:iniciar', control: null, label: 'Caixa', kind: 'canal' });
      await celular.receber('learn:pronto-para');
      celular.enviar({ type: 'midi:usar', porta: USB.out2 });
      const status = await celular.receber('status', (x) => x.midi.saida === USB.out2);
      assert.equal(status.rota.saida, USB.out1, 'a rota guardada continua sendo da USB 1');
      assert.equal(status.midi.entrada, USB.in1, 'nenhuma entrada se chama USB OUT: volta para a automatica');

      // O teste da porta nova espera a calibracao; o fader, nao. Sai com o n do
      // molde (11), nunca com o n da rota da outra porta (13).
      const desde = b.linhas.length;
      celular.enviar({ type: 'set', control: 'bumbo', value: 1 });
      await esperarAte(() => chegadasNaMesa(b.linhas, desde).some((c) => c.porta === USB.out2), 'o fader sair pela USB 2');
      assert.deepEqual(chegadasNaMesa(b.linhas, desde).map((c) => c.porta + ' ' + c.hex),
        [USB.out2 + ' F0 43 11 3E 0D 01 1C 00 00 01 7F F7']);
      assert.equal(celular.viu('mesa:teste'), false, 'testou com a calibracao aberta');
      const s = await m.status();
      assert.equal(s.rota.valeParaSaidaAberta, false);
      assert.equal(s.controlesHex[0].enviaCom, 'F0 43 11');

      // Calibracao cancelada: o teste que esperava roda, e a mesa so responde pela USB 1.
      celular.enviar({ type: 'learn:cancelar' });
      const ok = await celular.receber('mesa:teste', (x) => x.fase !== 'testando', 8000);
      assert.equal(ok.fase, 'ok');
      assert.deepEqual(ok.rota, { saida: USB.out1, entrada: USB.in1, canalMidi: 4, reconfirmada: true });
      assert.equal(m.lerConfig().midi.saida, USB.out1);
      const pedidos = chegadasNaMesa(b.linhas, desde).slice(1);
      assert.ok(pedidos.every(ehPedido));
      assert.deepEqual(pedidos.filter((c) => c.porta === USB.out2).map((c) => c.bytes[2] & 0x0f),
        [3, 1, 0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 'na USB 2: o n da rota, o do molde e o resto');
    });
  } finally {
    celular.fechar();
    await m.parar();
  }
});

test('Rx PORT em outra USB: ao conectar, o teste acha a saida certa, abre a entrada da resposta e aceita resposta com outro n', async (t) => {
  const bumbo = bumboDoTx(0);
  const caixa = { id: 'caixa', rotulo: 'Caixa', tipo: 'canal', ...mesa.controleParaCanal(bumbo, 2) };
  // A mesa ouve e responde pela USB 2, com n = 5 na resposta (o manual se
  // contradiz sobre esse n); calibracao e cena saem pela USB 1.
  const m = await bridgeComMesa({
    mesaInicial: {
      entradas: [USB.in1, USB.in2], saidas: [SINTETIZADOR, USB.out1, USB.out2],
      txCh: 0, rxCh: 0, respostaCh: 5, portaRx: USB.out2, portaTx: USB.in1, portaResposta: USB.in2,
      respostas: { 1: [0x00, 0x40], 2: [0x01, 0x00] }
    },
    config: { midi: midiDeTeste, aplicarEstadoAoIniciar: false, controles: [bumbo, caixa] }
  });
  const { b } = m;
  const celular = await conectarCelular(b.porta);

  try {
    await t.test('o teste da conexao passa pela USB 1 (calada) e acha a USB 2', async () => {
      const status = await celular.receber('status', (x) => x.rota !== null, 8000);
      assert.equal(status.midi.saida, USB.out2);
      assert.deepEqual({ ...status.rota, em: typeof status.rota.em },
        { saida: USB.out2, canalMidi: 1, em: 'string', reconfirmada: true });

      const chegadas = chegadasNaMesa(linhasDoTeste(b.linhas).linhas);
      assert.deepEqual(chegadas.map((c) => c.porta + ' ' + c.hex), [
        ...Array.from({ length: 16 }, (_, n) => USB.out1 + ' ' + pedidoHex(bumbo, n)),
        USB.out2 + ' ' + pedidoHex(bumbo, 0),
        USB.out2 + ' ' + pedidoHex(bumbo, 0),
        USB.out2 + ' ' + pedidoHex(bumbo, 1) // contra-prova: calada
      ]);
      assert.ok(chegadas.every(ehPedido), 'saiu Parameter change durante o teste');

      const { midi } = m.lerConfig();
      assert.equal(midi.saida, USB.out2);
      assert.deepEqual({ ...midi.rota, em: typeof midi.rota.em },
        { saida: USB.out2, entrada: USB.in2, dispositivo: 0, em: 'string', reconfirmada: true });

      // A resposta veio com n = 5, diferente do pedido, e valeu; a USB 2 ficou aberta.
      const s = await m.status();
      assert.ok(s.ultimosMidi.some((x) => x.dir === 'entrada' && x.porta === USB.in2 &&
        x.hex === 'F0 43 15 3E 0D 01 1C 00 00 00 40 F7'));
      assert.equal(s.midi.entrada, USB.in1);
      assert.equal(s.midi.entradaResposta, USB.in2);
    });

    await t.test('troca de cena: chega pela USB 1, a releitura sai pela USB 2 e a resposta volta pela USB 2', async () => {
      celular.esquecer();
      const desde = b.linhas.length;
      m.mesaEmite('C0 02');
      await celular.receber('cena', (x) => x.atual && x.atual.numero === 3);
      assert.deepEqual(await celular.receber('cena:relida', () => true, 5000),
        { type: 'cena:relida', numero: 3, lidos: ['bumbo', 'caixa'], semResposta: [] });
      const estado = await celular.receber('state', (x) => 'caixa' in x.values);
      assert.deepEqual(estado.values, { bumbo: 64 / 255, caixa: 128 / 255 });
      assert.deepEqual(chegadasNaMesa(b.linhas, desde).map((c) => c.porta + ' ' + c.hex + ' ' + c.aceitou), [
        USB.out2 + ' ' + pedidoHex(bumbo, 0) + ' true',
        USB.out2 + ' ' + pedidoHex(caixa, 0) + ' true'
      ]);
      const s = await m.status();
      assert.ok(s.ultimosMidi.some((x) => x.dir === 'entrada' && x.porta === USB.in1 && x.hex === 'C0 02'),
        'o Program Change na caixa preta');
    });

    await t.test('o fader sai pela USB 2 e a mesa aceita', async () => {
      const desde = b.linhas.length;
      celular.enviar({ type: 'set', control: 'caixa', value: 1 });
      await esperarAte(() => chegadasNaMesa(b.linhas, desde).some((c) => c.porta === USB.out2 && c.aceitou &&
        c.hex === 'F0 43 10 3E 0D 01 1C 00 01 01 7F F7'), 'a caixa no maximo pela USB 2');
    });

    await t.test('cabo sai e volta: reabre as duas entradas e nao testa de novo', async () => {
      celular.esquecer();
      const desde = b.linhas.length;
      m.mesaFica({ geracao: 2 });
      celular.enviar({ type: 'set', control: 'caixa', value: 0.5 }); // falha na porta velha
      await celular.receber('status', () => true, 5000);
      const entradas = () => b.linhas.slice(desde).filter((l) => l.includes('[mesa falsa] entrada '))
        .map((l) => l.slice(l.indexOf('entrada ')));
      await esperarAte(() => entradas().filter((l) => l.startsWith('entrada aberta')).length >= 2, 'reabrir as duas entradas');
      assert.deepEqual(entradas().sort(), [
        'entrada aberta: ' + USB.in1, 'entrada aberta: ' + USB.in2,
        'entrada fechada: ' + USB.in1, 'entrada fechada: ' + USB.in2
      ]);

      m.mesaEmite('C0 03');
      const relida = await celular.receber('cena:relida', (x) => x.numero === 4, 5000);
      assert.deepEqual(relida.lidos, ['bumbo', 'caixa'], 'a resposta pela USB 2 parou de chegar');
      assert.equal(celular.viu('mesa:teste'), false, 'testou de novo sem precisar');
    });

    await t.test('a entrada das respostas some e volta: o bridge reabre ela sozinho', async () => {
      celular.esquecer();
      const desde = b.linhas.length;
      const eventos = () => b.linhas.slice(desde).filter((l) => l.includes('[mesa falsa] entrada ') && l.includes(USB.in2))
        .map((l) => l.slice(l.indexOf('entrada ')));
      m.mesaFica({ entradas: [USB.in1] }); // a USB 2 de entrada some da lista
      await esperarAte(() => eventos().includes('entrada fechada: ' + USB.in2), 'fechar a entrada das respostas');
      await pausa(300); // algumas voltas do procurarMesa sem a USB 2
      assert.equal((await m.status()).midi.entradaResposta, null);

      m.mesaFica({ entradas: [USB.in1, USB.in2] });
      await esperarAte(() => eventos().at(-1) === 'entrada aberta: ' + USB.in2, 'reabrir a entrada das respostas');
      assert.equal((await m.status()).midi.entradaResposta, USB.in2);
      m.mesaEmite('C0 04');
      const relida = await celular.receber('cena:relida', (x) => x.numero === 5, 5000);
      assert.deepEqual(relida.lidos, ['bumbo', 'caixa'], 'a resposta pela USB 2 nao voltou');
      assert.equal(celular.viu('mesa:teste'), false);
    });

    await t.test('a mesa some no meio de um teste: ele para sem gravar nada', async () => {
      m.mesaFica({ portaRx: 'nenhuma' }); // a mesa para de responder: o teste fica pedindo
      const antes = m.lerConfig().midi;
      celular.esquecer();
      const desde = b.linhas.length;
      celular.enviar({ type: 'mesa:testar' });
      await celular.receber('mesa:teste', (x) => x.fase === 'testando');
      await esperarAte(() => chegadasNaMesa(b.linhas, desde).length >= 2, 'o teste comecar a pedir');
      m.mesaFica({ entradas: [], saidas: [SINTETIZADOR] });

      const falhou = await celular.receber('mesa:teste', (x) => x.fase === 'falhou', 5000);
      assert.match(falhou.motivo, /saiu do (cabo|ar) no meio do teste\. Nada foi gravado\./);
      assert.deepEqual(falhou.rota, { saida: USB.out2, entrada: USB.in2, canalMidi: 1, reconfirmada: true },
        'a rota boa vem como estava');
      assert.deepEqual(falhou.conferir, []);
      const status = await celular.receber('status', (x) => x.midi.simulado === true, 5000);
      assert.equal(status.rota.saida, USB.out2, 'a rota boa continua');
      assert.deepEqual(m.lerConfig().midi, antes, 'gravou algo com a mesa saindo no meio');
      assert.ok(chegadasNaMesa(b.linhas, desde).every(ehPedido));
    });
  } finally {
    celular.fechar();
    await m.parar();
  }
});

test('a mesa nao responde: o teste falha com o que conferir, sem Parameter change, e nada roda junto com ele', async (t) => {
  const bumbo = bumboDoTx(0);
  const m = await bridgeComMesa({
    mesaInicial: {
      entradas: [USB.in1, USB.in2], saidas: [USB.out1, USB.out2],
      txCh: 0, rxCh: 0, rxLigado: false, portaTx: USB.in1, portaResposta: USB.in1,
      respostas: { 1: [0x00, 0x40], 2: [0x00, 0x10] }
    },
    config: {
      // Rota velha, de uma porta que nao existe mais: o n dela e o primeiro testado.
      midi: { ...midiDeTeste, rota: { saida: 'YAMAHA USB OUT 0-9', entrada: USB.in1, dispositivo: 7, em: '2026-10-01T10:00:00.000Z' } },
      aplicarEstadoAoIniciar: true,
      controles: [bumbo]
    },
    // O mix guardado volta para a mesa ao ligar: tem que esperar o teste acabar.
    estado: { valores: { bumbo: 1 }, mutes: {} }
  });
  const { b } = m;
  const celular = await conectarCelular(b.porta);
  const outro = await conectarCelular(b.porta);

  try {
    await t.test('o teste da conexao falha, diz o que conferir na mesa e fecha a entrada extra', async () => {
      const falhou = await celular.receber('mesa:teste', (x) => x.fase === 'falhou', 10000);
      // A rota guardada nao some: continua, marcada como nao reconfirmada.
      assert.deepEqual(falhou.rota, { saida: 'YAMAHA USB OUT 0-9', entrada: USB.in1, canalMidi: 8, reconfirmada: false });
      assert.equal(falhou.testados, 32);
      assert.match(falhou.motivo, /nao respondeu em nenhuma porta nem canal MIDI \(32 teste/);
      const texto = falhou.conferir.join('\n');
      for (const trecho of ['MIDI | SETUP', 'PARAMETER CHANGE', 'Rx ON', 'Tx e Rx', 'DIO/SETUP | MIDI/HOST',
        'GENERAL Rx PORT', 'Tx PORT', '"AirFader"']) {
        assert.ok(texto.includes(trecho), 'falta "' + trecho + '" no que conferir');
      }
      assert.doesNotMatch(texto, /<[a-z/]/i, 'HTML no texto do que conferir');

      // Durante o teste: so pedidos de leitura, 16 por saida. Antes dele, nada.
      const teste = linhasDoTeste(b.linhas);
      const durante = chegadasNaMesa(teste.linhas);
      assert.deepEqual(durante.map((c) => c.porta), [...Array(16).fill(USB.out1), ...Array(16).fill(USB.out2)]);
      assert.ok(durante.every(ehPedido), 'saiu Parameter change durante o teste');
      // Em cada saida: o n da rota velha (7), o do molde (0) e o resto de 0 a 15.
      assert.deepEqual(durante.slice(0, 16).map((c) => c.bytes[2] & 0x0f), [7, 0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15]);
      assert.deepEqual(chegadasNaMesa(b.linhas.slice(0, teste.ini)), []);
      // O mix guardado (Parameter change) so sai depois que o teste acaba.
      await esperarAte(() => chegadasNaMesa(b.linhas, teste.fim).some((c) => c.hex === mesa.paraHex(MAXIMO)),
        'o mix guardado sair depois do teste');

      const { midi } = m.lerConfig();
      assert.deepEqual(midi.rota, { saida: 'YAMAHA USB OUT 0-9', entrada: USB.in1, dispositivo: 7,
        em: '2026-10-01T10:00:00.000Z', reconfirmada: false }, 'a rota guardada sumiu ou nao foi marcada');
      assert.equal(midi.saida, null, 'mexeu na porta sem achar rota');
      const s = await m.status();
      assert.equal(s.rota.reconfirmada, false);
      assert.equal(s.rota.valeParaSaidaAberta, false, 'a rota e de outra porta');
      assert.equal(s.midi.entradaResposta, null);
      // Rota de outra porta: o mix saiu com o n do molde (MAXIMO), nao com o 7 da rota.
      assert.equal(s.controlesHex[0].enviaCom, 'F0 43 10');
      assert.ok(s.avisos.some((l) => l.includes('nao respondeu ao teste') && l.includes('PARAMETER CHANGE')),
        'o que conferir no diagnostico');
      const extra = b.linhas.filter((l) => l.includes('[mesa falsa] entrada ') && l.includes(USB.in2))
        .map((l) => l.slice(l.indexOf('entrada ')));
      assert.deepEqual(extra, ['entrada aberta: ' + USB.in2, 'entrada fechada: ' + USB.in2]);
    });

    await t.test('criar canais sem rota testa antes; no meio do teste o resto espera ou e recusado', async () => {
      celular.esquecer();
      outro.esquecer();
      const desde = b.linhas.length;
      celular.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [2] });
      await celular.receber('mesa:teste', (x) => x.fase === 'testando');

      outro.enviar({ type: 'learn:iniciar', control: null, label: 'Caixa', kind: 'canal' });
      assert.deepEqual(await outro.receber('learn:erro'), {
        type: 'learn:erro',
        message: 'Estou testando a mesa agora (pode levar ate uns 20 segundos). Espere terminar para calibrar.',
        etapa: 'nome'
      });
      outro.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [3] });
      assert.match((await outro.receber('gerar:erro')).message, /testando a mesa/);
      outro.enviar({ type: 'mesa:testar' });
      assert.match((await outro.receber('controle:erro')).message, /Ja estou testando a mesa/);
      m.mesaEmite('C0 02'); // a equipe chama a cena 3 no meio do teste
      await celular.receber('cena', (x) => x.atual && x.atual.numero === 3);

      assert.equal((await celular.receber('mesa:teste', (x) => x.fase === 'falhou', 10000)).testados, 32);
      assert.match((await celular.receber('gerar:erro', () => true, 3000)).message,
        /nao respondeu ao teste, entao nao criei nenhum canal/);
      // A releitura da cena esperou o teste e rodou depois dele.
      assert.deepEqual(await celular.receber('cena:relida', () => true, 5000),
        { type: 'cena:relida', numero: 3, lidos: [], semResposta: ['bumbo'] });
      assert.equal(celular.viu('gerar:fim'), false);
      assert.equal(outro.viu('learn:pronto-para'), false);

      const teste = linhasDoTeste(b.linhas, desde);
      assert.equal(chegadasNaMesa(teste.linhas).length, 32);
      assert.deepEqual(chegadasNaMesa(b.linhas, teste.fim).map((c) => c.hex), [pedidoHex(bumbo, 0)],
        'depois do teste, so o pedido da releitura');
      assert.ok(chegadasNaMesa(b.linhas, desde).every(ehPedido));
    });

    await t.test('com calibracao aberta ou releitura rodando, testar a mesa e recusado', async () => {
      celular.esquecer();
      celular.enviar({ type: 'learn:iniciar', control: null, label: 'Caixa', kind: 'canal' });
      await celular.receber('learn:pronto-para');
      celular.enviar({ type: 'mesa:testar' });
      assert.match((await celular.receber('controle:erro')).message, /calibrando um controle agora/);
      celular.enviar({ type: 'learn:cancelar' });
      await pausa(50);

      const desde = b.linhas.length;
      m.mesaEmite('C0 04'); // cena 5: a releitura espera 300 ms pela mesa calada
      await esperarAte(() => chegadasNaMesa(b.linhas, desde).length >= 1, 'o pedido da releitura');
      celular.enviar({ type: 'mesa:testar' });
      assert.match((await celular.receber('controle:erro')).message, /relendo a mesa/);
      await celular.receber('cena:relida', (x) => x.numero === 5, 5000);
      assert.equal(celular.viu('mesa:teste'), false);
    });

    await t.test('alguem mexendo no mesmo send durante o teste nao vira rota falsa (contra-prova)', async () => {
      celular.esquecer();
      const desde = b.linhas.length;
      // A mesa continua surda (Rx OFF), mas o send do bumbo chega sem parar,
      // como alguem arrastando o fader na mesa durante o teste.
      m.mesaFica({ repetir: 'F0 43 10 3E 0D 01 1C 00 00 00 30 F7' });
      try {
        celular.enviar({ type: 'mesa:testar' });
        const fim = await celular.receber('mesa:teste', (x) => x.fase !== 'testando', 15000);
        assert.equal(fim.fase, 'falhou', 'quadro da mesa virou rota');
        assert.match(fim.motivo, /nao se confirmou/);
        assert.deepEqual(fim.rota, { saida: 'YAMAHA USB OUT 0-9', entrada: USB.in1, canalMidi: 8, reconfirmada: false });
      } finally {
        m.mesaFica({ repetir: null });
      }
      // Em cada n "achado", a contra-prova com o n seguinte tambem recebeu o quadro: descartado.
      const teste = linhasDoTeste(b.linhas, desde);
      assert.ok(teste.linhas.some((l) => l.includes('alguem mexendo nesse send na mesa')));
      assert.ok(chegadasNaMesa(teste.linhas).every(ehPedido));
      assert.equal(m.lerConfig().midi.rota.dispositivo, 7, 'a rota guardada mudou');
      await pausa(100);
    });

    await t.test('com o Rx ligado no canal MIDI 16, o criar canais acha a rota e continua sozinho', async () => {
      m.mesaFica({ rxLigado: true, rxCh: 15 });
      celular.esquecer();
      outro.esquecer();
      const desde = b.linhas.length;
      celular.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [2] });
      await celular.receber('mesa:teste', (x) => x.fase === 'testando');
      outro.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [2] });
      assert.match((await outro.receber('gerar:erro')).message, /testando a mesa/);

      const ok = await celular.receber('mesa:teste', (x) => x.fase === 'ok', 8000);
      assert.deepEqual(ok.rota, { saida: USB.out1, entrada: USB.in1, canalMidi: 16, reconfirmada: true });
      assert.equal(ok.testados, 16);
      const fim = await celular.receber('gerar:fim', () => true, 5000);
      assert.deepEqual(fim.criados, [{ id: 'canal-2', label: 'Canal 2', canal: 2 }]);
      assert.equal(outro.viu('gerar:fim'), false, 'o pedido recusado rodou');

      // n da rota velha (7), o do molde (0), o resto; confirmacao do 15,
      // contra-prova com o 0 (calada) e o pedido do canal 2 ja no n 15.
      const ordem = [7, 0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15];
      const chegadas = chegadasNaMesa(b.linhas, desde);
      assert.deepEqual(chegadas.map((c) => c.hex), [
        ...ordem.map((n) => pedidoHex(bumbo, n)),
        pedidoHex(bumbo, 15),
        pedidoHex(bumbo, 0),
        mesa.paraHex(mesa.montarPedido(bumbo, 2, 15))
      ]);
      assert.deepEqual(chegadas.map((c) => c.aceitou), [...Array(15).fill(false), true, true, false, true]);
      assert.equal(m.lerConfig().midi.rota.dispositivo, 15);
      assert.equal(m.lerConfig().midi.rota.reconfirmada, true);
    });
  } finally {
    celular.fechar();
    outro.fechar();
    await m.parar();
  }
});

test('rota confirmada que fica sem resposta: continua valendo, nao reconfirmada, e o app pergunta de novo sozinho', async (t) => {
  const bumbo = bumboDoTx(0);
  // A mesa escuta no canal MIDI 3 (n = 2) pela USB 1; o caminho ja foi confirmado antes.
  const m = await bridgeComMesa({
    mesaInicial: {
      entradas: [USB.in1], saidas: [USB.out1],
      txCh: 0, rxCh: 2, portaRx: USB.out1, portaTx: USB.in1, portaResposta: USB.in1,
      respostas: { 1: [0x00, 0x40] }
    },
    config: {
      midi: { ...midiDeTeste, retestarRotaMs: 3000,
        rota: { saida: USB.out1, entrada: USB.in1, dispositivo: 2, em: '2026-10-01T10:00:00.000Z' } },
      aplicarEstadoAoIniciar: false,
      controles: [bumbo]
    }
  });
  const { b } = m;
  const celular = await conectarCelular(b.porta);
  const fader = (valor) => mesa.paraHex(mesa.montarFrame(bumbo, valor, 2));

  try {
    const inicio = await celular.receber('status');
    assert.deepEqual(inicio.rota, { saida: USB.out1, canalMidi: 3, em: '2026-10-01T10:00:00.000Z', reconfirmada: true });
    await pausa(300);
    assert.equal(celular.viu('mesa:teste'), false, 'testou com a rota confirmada');

    await t.test('Rx desligado e Testar: falha, mas a rota fica (nao reconfirmada) e o fader continua no n dela', async () => {
      m.mesaFica({ rxLigado: false });
      celular.esquecer();
      celular.enviar({ type: 'mesa:testar' });
      const falhou = await celular.receber('mesa:teste', (x) => x.fase === 'falhou', 8000);
      assert.deepEqual(falhou.rota, { saida: USB.out1, entrada: USB.in1, canalMidi: 3, reconfirmada: false });
      assert.equal(falhou.testados, 16);
      assert.ok(falhou.conferir.length > 0);
      const status = await celular.receber('status', (x) => x.rota && x.rota.reconfirmada === false);
      assert.equal(status.rota.canalMidi, 3);
      assert.deepEqual(m.lerConfig().midi.rota, { saida: USB.out1, entrada: USB.in1, dispositivo: 2,
        em: '2026-10-01T10:00:00.000Z', reconfirmada: false });

      const desde = b.linhas.length;
      celular.enviar({ type: 'set', control: 'bumbo', value: 1 });
      await esperarAte(() => chegadasNaMesa(b.linhas, desde).some((c) => c.hex === fader(1)), 'o fader sair no n da rota');
    });

    await t.test('calibrar com a rota nao reconfirmada testa a mesa de novo (nao so na primeira calibracao)', async () => {
      celular.esquecer();
      celular.enviar({ type: 'learn:iniciar', control: null, label: 'Caixa', kind: 'canal' });
      await celular.receber('learn:pronto-para');
      m.mesaEmite('F0 43 10 3E 0D 01 1C 00 01 00 00 F7');
      await celular.receber('learn:midi');
      celular.enviar({ type: 'learn:capturar', step: 'min' });
      await celular.receber('learn:capturado');
      await pausa(250);
      m.mesaEmite('F0 43 10 3E 0D 01 1C 00 01 01 7F F7');
      await celular.receber('learn:midi');
      celular.enviar({ type: 'learn:capturar', step: 'max' });
      await celular.receber('learn:capturado');
      celular.enviar({ type: 'learn:salvar' });
      await celular.receber('learn:salvo');
      await celular.receber('mesa:teste', (x) => x.fase === 'testando');
      const falhou = await celular.receber('mesa:teste', (x) => x.fase !== 'testando', 8000);
      assert.equal(falhou.fase, 'falhou');
      assert.equal(falhou.rota.reconfirmada, false);
    });

    await t.test('Rx religado: o fader sai com o n da rota e a mesa aceita', async () => {
      m.mesaFica({ rxLigado: true });
      const desde = b.linhas.length;
      celular.enviar({ type: 'set', control: 'bumbo', value: 0.5 });
      await esperarAte(() => chegadasNaMesa(b.linhas, desde).some((c) => c.hex === fader(0.5) && c.aceitou),
        'a mesa aceitar o fader no n da rota');
    });

    await t.test('sem ninguem pedir, o app reconfirma a rota (so pergunta pelo caminho guardado)', async () => {
      celular.esquecer();
      const desde = b.linhas.length;
      await celular.receber('mesa:teste', (x) => x.fase === 'testando', 10000);
      const ok = await celular.receber('mesa:teste', () => true, 5000);
      assert.equal(ok.fase, 'ok');
      assert.deepEqual(ok.rota, { saida: USB.out1, entrada: USB.in1, canalMidi: 3, reconfirmada: true });
      assert.equal(ok.testados, 1);
      assert.deepEqual(chegadasNaMesa(b.linhas, desde).map((c) => c.hex),
        [pedidoHex(bumbo, 2), pedidoHex(bumbo, 2), pedidoHex(bumbo, 3)], 'pedido, confirmacao e contra-prova');
      await celular.receber('status', (x) => x.rota && x.rota.reconfirmada === true);
      assert.equal(m.lerConfig().midi.rota.reconfirmada, true);
      // Reconfirmada: nao pergunta de novo.
      celular.esquecer();
      await pausa(3500);
      assert.equal(celular.viu('mesa:teste'), false);
      assert.equal(chegadasNaMesa(b.linhas, desde).length, 3);
    });
  } finally {
    celular.fechar();
    await m.parar();
  }
});

// ---------------------------------------------------------------------------
// Modo mapa: le e escreve os fones pelos enderecos do mapa da 01V96, sem
// calibrar. Os enderecos daqui foram escritos a mao, copiados do
// message-types.ts do kryops/remote-mixer: a mesa de teste nao usa
// src/mapa01v96.js, entao uma tabela gerada errada derruba o teste.
// ---------------------------------------------------------------------------

const hx = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const END = {
  send: (aux, canal) => '7F 01 23 ' + hx(3 * aux - 1) + ' ' + hx(canal - 1),
  sendOn: (aux, canal) => '7F 01 23 ' + hx(3 * aux - 3) + ' ' + hx(canal - 1),
  master: (aux) => '7F 01 39 00 ' + hx(aux - 1),
  masterOn: (aux) => '7F 01 36 00 ' + hx(aux - 1),
  nomeCanal: (canal, letra) => '0D 02 04 ' + hx(3 + letra) + ' ' + hx(canal - 1),
  nomeAux: (aux, letra) => '0D 02 10 ' + hx(3 + letra) + ' ' + hx(aux - 1),
  resolucao: '0D 03 5E 00 00'
};
const TOTAL_MAPA = 1 + 8 * 18 + 32 * 32;
const quatro = (v) => [0, 0, v >> 7, v & 0x7f];
/** Parameter change que a mesa manda sozinha (alguem mexendo nela). */
const quadroDaMesa = (endereco, v) =>
  mesa.paraHex([0xf0, 0x43, 0x10, 0x3e, ...endereco.split(' ').map((h) => parseInt(h, 16)), ...quatro(v), 0xf7]);
const NOMES_AUX = ['Pastor', 'Baixo', 'Bateria', 'Guitarra', 'Teclado', 'Violao', 'Coral', 'Reserva'];
const midiDoMapa = { ...midiDeTeste, mapa: true };

/** O que a mesa de teste tem, no formato "enderecos" dela. */
function mesaDoMapa({
  send = (a, c) => a * 20 + c, on = (a, c) => c % 3 !== 0, master = (a) => 100 + a * 10, masterOn = (a) => a !== 8,
  nomeCanal = (c) => 'Voz ' + c, nomeAux = (a) => NOMES_AUX[a - 1], resolucao = 1, sem = [], extra = {}
} = {}) {
  const e = { [END.resolucao]: quatro(resolucao) };
  for (let a = 1; a <= 8; a++) {
    e[END.master(a)] = quatro(master(a));
    e[END.masterOn(a)] = quatro(masterOn(a) ? 1 : 0);
    const nome = nomeAux(a).padEnd(16);
    for (let l = 1; l <= 16; l++) e[END.nomeAux(a, l)] = quatro(nome.charCodeAt(l - 1));
  }
  for (let c = 1; c <= 32; c++) {
    for (let a = 1; a <= 8; a++) {
      e[END.send(a, c)] = quatro(send(a, c));
      e[END.sendOn(a, c)] = quatro(on(a, c) ? 1 : 0);
    }
    const nome = nomeCanal(c).padEnd(16);
    for (let l = 1; l <= 16; l++) e[END.nomeCanal(c, l)] = quatro(nome.charCodeAt(l - 1));
  }
  for (const k of sem) delete e[k];
  return { ...e, ...extra };
}

/** Espera o /api/status passar na condicao. */
async function esperarStatus(m, condicao, descricao, ms = 20000) {
  const limite = Date.now() + ms;
  let s;
  while (Date.now() < limite) {
    s = await m.status();
    if (condicao(s)) return s;
    await pausa(100);
  }
  throw new Error('esperei ' + ms + ' ms e o status nao chegou a: ' + descricao + '\n' + JSON.stringify(s && s.mapa));
}

const ehMudanca = (c) => (c.bytes[2] & 0xf0) === 0x10;
const valorDoQuadro = (bytes) => (bytes[11] << 7) + bytes[12];

test('modo mapa: sem calibrar nada, acha a rota, le a mesa toda e cada celular mexe so no proprio fone', async (t) => {
  // Bumbo calibrado mais adiante (plano B), no formato antigo: responde 64.
  const BUMBO = '0D 01 1C 00 00';
  let conteudo = {
    sem: [END.send(8, 32)], // o send do canal 32 para o Aux 8 nao responde
    nomeCanal: (c) => (c === 2 ? 'Teclado' : 'Voz ' + c),
    nomeAux: (a) => (a === 4 ? 'Retorno' : NOMES_AUX[a - 1]),
    extra: { [BUMBO]: [0x00, 0x40] }
  };
  const m = await bridgeComMesa({
    mesaInicial: {
      entradas: [USB.in1], saidas: [SINTETIZADOR, USB.out1],
      txCh: 0, rxCh: 2, portaRx: USB.out1, portaTx: USB.in1, portaResposta: USB.in1,
      enderecos: mesaDoMapa({ ...conteudo, nomeCanal: (c) => 'Voz ' + c, nomeAux: (a) => NOMES_AUX[a - 1] }),
      guardar: true
    },
    config: { midi: midiDoMapa, aplicarEstadoAoIniciar: false, controles: [] }
  });
  const { b } = m;
  const fone3 = await conectarCelular(b.porta);
  const outro3 = await conectarCelular(b.porta);
  const fone4 = await conectarCelular(b.porta);
  const todos = [fone3, outro3, fone4];
  const mudancasDesde = (desde) => chegadasNaMesa(b.linhas, desde).filter(ehMudanca);
  const pronta = (c, ms = 20000) => c.receber('mesa:sincronia', (x) => x.fase !== 'lendo', ms);
  /** Manda e espera a mesa de teste aceitar exatamente esse quadro. */
  async function mandaEConfere(cel, msg, hex) {
    const desde = b.linhas.length;
    cel.enviar(msg);
    await esperarAte(() => mudancasDesde(desde).some((c) => c.hex === hex && c.aceitou), 'a mesa aceitar ' + hex);
  }

  try {
    await t.test('sem nenhum controle calibrado, a conexao testa a mesa pelo send do canal 1 no Aux 1 e acha a rota', async () => {
      const s = await esperarStatus(m, (x) => x.mapa.pronta, 'a leitura ficar pronta');
      assert.equal(s.rota.dispositivo, 2);
      assert.equal(s.rota.reconfirmada, true);
      const teste = linhasDoTeste(b.linhas);
      assert.deepEqual(chegadasNaMesa(teste.linhas).map((c) => c.hex),
        [0, 1, 2, 2, 3].map((n) => 'F0 43 ' + hx(0x30 | n) + ' 3E ' + END.send(1, 1) + ' F7'));
      assert.deepEqual(chegadasNaMesa(b.linhas.slice(0, teste.ini)), [], 'nada antes do teste');
    });

    await t.test('a leitura so manda pedido de leitura (3n) no n da rota, todo o mapa, e pergunta de novo uma vez o que faltou', async () => {
      const teste = linhasDoTeste(b.linhas);
      const pedidos = chegadasNaMesa(b.linhas, teste.fim);
      assert.ok(pedidos.every((c) => c.bytes[2] === 0x32), 'saiu algo que nao e pedido no n da rota');
      assert.ok(pedidos.every((c) => c.aceitou));
      assert.equal(pedidos.length, TOTAL_MAPA + 1, 'um pedido por endereco, mais a segunda tentativa do que faltou');
      const faltou = 'F0 43 32 3E ' + END.send(8, 32) + ' F7';
      assert.equal(pedidos.filter((c) => c.hex === faltou).length, 2);
      const pedidosHex = new Set(pedidos.map((c) => mesa.paraHex(c.bytes.slice(4, 9))));
      for (const endereco of Object.keys(mesaDoMapa())) assert.ok(pedidosHex.has(endereco), 'nao pediu ' + endereco);

      const s = await m.status();
      assert.deepEqual({ ...s.mapa, sincronizadaEm: typeof s.mapa.sincronizadaEm, auxes: s.mapa.auxes.map((a) => a.nome) }, {
        ativo: true, pronta: true, resolucao: 'baixa', resolucaoCrua: 1,
        motivoResolucao: 'nenhum valor acima de 255 (Fader Resolution cru = 1)',
        lidos: TOTAL_MAPA - 1, total: TOTAL_MAPA,
        semResposta: ['kInputAUX/kAUX8Level#32'], semRespostaTotal: 1,
        sincronizadaEm: 'string', lendo: null, auxes: NOMES_AUX
      });
      assert.ok(!Number.isNaN(Date.parse(s.mapa.sincronizadaEm)));
      for (const c of todos) {
        const r = await c.receber('mesa:resumo', (x) => x.pronta, 5000);
        assert.deepEqual(r.auxes, NOMES_AUX.map((nome, i) => ({ aux: i + 1, nome })));
        assert.equal(r.resolucao, 'baixa');
        assert.equal(r.sincronizadaEm, s.mapa.sincronizadaEm);
      }
    });

    await t.test('escolher o fone traz os 32 canais com nome, valor e On; Aux invalido e recusado', async () => {
      fone3.enviar({ type: 'fone:escolher', aux: 3 });
      const e3 = await fone3.receber('fone:estado');
      assert.equal(e3.aux, 3);
      assert.equal(e3.nome, 'Bateria');
      assert.deepEqual(e3.master, { valor: 130 / 255, on: true });
      assert.equal(e3.canais.length, 32);
      assert.deepEqual(e3.canais[4], { canal: 5, nome: 'Voz 5', valor: 65 / 255, on: true, confirmado: true });
      assert.deepEqual(e3.canais[2], { canal: 3, nome: 'Voz 3', valor: 63 / 255, on: false, confirmado: true });
      outro3.enviar({ type: 'fone:escolher', aux: 3 });
      await outro3.receber('fone:estado');
      fone4.enviar({ type: 'fone:escolher', aux: 8 });
      const e8 = await fone4.receber('fone:estado');
      assert.deepEqual(e8.master, { valor: 180 / 255, on: false });
      assert.deepEqual(e8.canais[31], { canal: 32, nome: 'Voz 32', valor: null, on: true, confirmado: false });

      for (const aux of [0, 9, '3', 2.5, null]) {
        fone3.enviar({ type: 'fone:escolher', aux });
        assert.match((await fone3.receber('controle:erro')).message, /Aux 1 a Aux 8/);
      }
    });

    await t.test('endereco que nao respondeu nunca e escrito', async () => {
      const desde = b.linhas.length;
      fone4.enviar({ type: 'fone:send', aux: 8, canal: 32, valor: 1 });
      assert.match((await fone4.receber('controle:erro')).message, /nao confirmou/);
      await pausa(150);
      assert.deepEqual(mudancasDesde(desde), [], 'saiu Parameter change para endereco sem confirmacao');
      fone4.enviar({ type: 'fone:escolher', aux: 4 });
      await fone4.receber('fone:estado');
    });

    await t.test('mexer: sai Parameter change no endereco do mapa, com o n da rota e a escala LOW; a mesa aceita; so o mesmo Aux fica sabendo', async () => {
      for (const c of todos) c.esquecer();
      const desde = b.linhas.length;
      await mandaEConfere(fone3, { type: 'fone:send', aux: 3, canal: 5, valor: 1 }, 'F0 43 12 3E 7F 01 23 08 04 00 00 01 7F F7');
      assert.deepEqual(await outro3.receber('fone:mudou'), { type: 'fone:mudou', aux: 3, canal: 5, campo: 'valor', valor: 1 });
      await mandaEConfere(fone3, { type: 'fone:send', aux: 3, canal: 5, valor: 0.5 }, 'F0 43 12 3E 7F 01 23 08 04 00 00 01 00 F7');
      assert.equal((await outro3.receber('fone:mudou')).valor, 128 / 255);
      // Fora de 0..1: nunca passa do maximo da escala (255 em LOW).
      await mandaEConfere(fone3, { type: 'fone:send', aux: 3, canal: 5, valor: 7 }, 'F0 43 12 3E 7F 01 23 08 04 00 00 01 7F F7');
      await mandaEConfere(fone3, { type: 'fone:sendOn', aux: 3, canal: 5, on: false }, 'F0 43 12 3E 7F 01 23 06 04 00 00 00 00 F7');
      assert.deepEqual(await outro3.receber('fone:mudou', (x) => x.campo === 'on'),
        { type: 'fone:mudou', aux: 3, canal: 5, campo: 'on', valor: false });
      await mandaEConfere(fone3, { type: 'fone:master', aux: 3, valor: 0.2 }, 'F0 43 12 3E 7F 01 39 00 02 00 00 00 33 F7');
      await mandaEConfere(fone3, { type: 'fone:masterOn', aux: 3, on: false }, 'F0 43 12 3E 7F 01 36 00 02 00 00 00 00 F7');
      assert.deepEqual(await outro3.receber('fone:mudou', (x) => x.campo === 'masterOn'),
        { type: 'fone:mudou', aux: 3, canal: null, campo: 'masterOn', valor: false });

      for (const msg of [
        { type: 'fone:send', aux: 3, canal: 33, valor: 0.5 }, { type: 'fone:send', aux: 3, canal: 5, valor: 'x' },
        { type: 'fone:sendOn', aux: 3, canal: 5, on: 'sim' }, { type: 'fone:master', aux: 0, valor: 0.5 },
        { type: 'fone:masterOn', aux: 3 }
      ]) {
        fone3.enviar(msg);
        await fone3.receber('controle:erro');
      }
      await pausa(150);
      const mudancas = mudancasDesde(desde);
      assert.equal(mudancas.length, 6, mudancas.map((c) => c.hex).join('\n'));
      assert.ok(mudancas.every((c) => c.aceitou && c.bytes[2] === 0x12));
      assert.ok(mudancas.every((c) => valorDoQuadro(c.bytes) <= 255), 'valor acima de 255 em LOW');
      assert.equal(fone3.viu('fone:mudou'), false, 'quem mexeu recebeu o proprio eco');
      assert.equal(fone4.todas.some((x) => x.type === 'fone:mudou'), false, 'o fone do Aux 4 soube do Aux 3');

      // Lendo a mesa de novo, o que o app mandou esta la.
      fone3.enviar({ type: 'mesa:sincronizar' });
      assert.equal((await pronta(fone3)).fase, 'pronta');
      const e3 = await fone3.receber('fone:estado', () => true, 5000);
      assert.deepEqual(e3.canais[4], { canal: 5, nome: 'Voz 5', valor: 1, on: false, confirmado: true });
      assert.deepEqual(e3.master, { valor: 51 / 255, on: false });
      assert.equal(fone4.todas.some((x) => x.type === 'fone:estado' && x.aux === 3), false);
    });

    await t.test('quem mexe na mesa: o Aux vai so para quem escolheu ele; nome de canal vai para todos', async () => {
      for (const c of todos) c.esquecer();
      m.mesaEmite(quadroDaMesa(END.send(3, 7), 64));
      for (const c of [fone3, outro3]) {
        assert.deepEqual(await c.receber('fone:mudou'), { type: 'fone:mudou', aux: 3, canal: 7, campo: 'valor', valor: 64 / 255 });
      }
      // Fader acima de 1023 (nao existe na mesa) e ignorado: nem valor, nem escala HIGH.
      m.mesaEmite(quadroDaMesa(END.send(3, 8), 1024), quadroDaMesa(END.send(3, 8), 50));
      assert.deepEqual(await fone3.receber('fone:mudou', (x) => x.canal === 8),
        { type: 'fone:mudou', aux: 3, canal: 8, campo: 'valor', valor: 50 / 255 });
      assert.equal(fone3.viu('mesa:resumo'), false, 'o 1024 mexeu na escala');
      assert.equal((await m.status()).mapa.resolucao, 'baixa');
      const nome = 'Teclado'.padEnd(16);
      m.mesaEmite(...Array.from({ length: 16 }, (_, i) => quadroDaMesa(END.nomeCanal(2, i + 1), nome.charCodeAt(i))));
      // Cada celular recebe com o Aux que escolheu (o app ignora mudanca de outro Aux).
      for (const [c, aux] of [[fone3, 3], [outro3, 3], [fone4, 4]]) {
        assert.deepEqual(await c.receber('fone:mudou', (x) => x.campo === 'nome'),
          { type: 'fone:mudou', aux, canal: 2, campo: 'nome', valor: 'Teclado' });
      }
      const aux4 = 'Retorno'.padEnd(16);
      m.mesaEmite(...Array.from({ length: 16 }, (_, i) => quadroDaMesa(END.nomeAux(4, i + 1), aux4.charCodeAt(i))));
      assert.deepEqual(await fone4.receber('fone:mudou', (x) => x.campo === 'nome'),
        { type: 'fone:mudou', aux: 4, canal: null, campo: 'nome', valor: 'Retorno' });
      for (const c of todos) await c.receber('mesa:resumo', (x) => x.auxes[3].nome === 'Retorno');
      await pausa(200);
      assert.equal(fone4.todas.some((x) => x.type === 'fone:mudou' && x.aux === 3), false);
      assert.equal(fone3.todas.some((x) => x.type === 'fone:mudou' && x.aux === 4), false);
      assert.equal(fone4.todas.some((x) => x.type === 'fone:mudou' && x.campo === 'valor'), false,
        'o send do Aux 3 que a mesa mudou chegou no fone do Aux 4');
    });

    await t.test('troca de cena le a mesa de novo (no lugar da releitura antiga), em lotes com pausa, e o fone ve os valores novos', async () => {
      conteudo = { ...conteudo, send: (a, c) => (a === 3 && c === 6 ? 99 : a * 20 + c) };
      m.mesaFica({ enderecos: mesaDoMapa(conteudo) });
      for (const c of todos) c.esquecer();
      const desde = b.linhas.length;
      m.mesaEmite('C0 02');
      await fone3.receber('cena', (x) => x.atual && x.atual.numero === 3);
      const lendo = await fone3.receber('mesa:sincronia', (x) => x.fase === 'lendo', 5000);
      const fim = await pronta(fone3);
      assert.deepEqual({ fase: fim.fase, lidos: fim.lidos, total: fim.total }, { fase: 'pronta', lidos: TOTAL_MAPA - 1, total: TOTAL_MAPA });
      // So conta o que o app mexe (send, On e master: 528), nao letra de nome.
      assert.match(fim.motivo, /^1 de 528 controle\(s\) sem resposta/);
      const ms = fone3.tempos[fone3.todas.indexOf(fim)] - fone3.tempos[fone3.todas.indexOf(lendo)];
      assert.ok(ms >= 1000, 'leu ' + TOTAL_MAPA + ' enderecos em ' + ms + ' ms: sem as pausas entre os lotes');
      const e3 = await fone3.receber('fone:estado', () => true, 5000);
      assert.equal(e3.canais[5].valor, 99 / 255);
      assert.equal(e3.canais[1].nome, 'Teclado');
      const quadros = chegadasNaMesa(b.linhas, desde);
      assert.ok(quadros.every((c) => c.bytes[2] === 0x32), 'saiu algo que nao e pedido');
      assert.equal(quadros.length, TOTAL_MAPA + 1);
      assert.equal(fone3.viu('cena:relida'), false, 'sem calibrados nao ha releitura antiga');
      assert.equal(b.linhas.slice(desde).some((l) => l.includes('[cena] relendo')), false);
    });

    await t.test('lendo a mesa: calibrar, criar canais, testar a mesa e outra leitura sao recusados; sem resposta, nada fica confirmado', async () => {
      m.mesaFica({ rxLigado: false });
      for (const c of todos) c.esquecer();
      fone3.enviar({ type: 'mesa:sincronizar' });
      await fone3.receber('mesa:sincronia', (x) => x.fase === 'lendo');
      fone3.enviar({ type: 'learn:iniciar', control: null, label: 'Caixa', kind: 'canal' });
      assert.deepEqual(await fone3.receber('learn:erro'),
        { type: 'learn:erro', message: 'Estou lendo a mesa agora. Espere uns segundos para calibrar.', etapa: 'nome' });
      fone3.enviar({ type: 'gerar:canais', base: 'qualquer', canais: [2] });
      assert.match((await fone3.receber('gerar:erro')).message, /lendo a mesa/);
      fone3.enviar({ type: 'mesa:testar' });
      assert.match((await fone3.receber('controle:erro')).message, /lendo a mesa/);
      fone3.enviar({ type: 'mesa:sincronizar' });
      assert.match((await fone3.receber('controle:erro')).message, /Ja estou lendo/);

      const falhou = await pronta(fone3, 30000);
      assert.deepEqual({ fase: falhou.fase, lidos: falhou.lidos }, { fase: 'falhou', lidos: 0 });
      assert.match(falhou.motivo, /nao respondeu a nenhum pedido/);
      await fone3.receber('mesa:resumo', (x) => x.pronta === false);
      assert.equal(fone3.viu('learn:pronto-para'), false);

      const desde = b.linhas.length;
      fone3.enviar({ type: 'fone:send', aux: 3, canal: 5, valor: 0.3 });
      assert.match((await fone3.receber('controle:erro')).message, /nao confirmou/);
      await pausa(150);
      assert.deepEqual(mudancasDesde(desde), []);

      m.mesaFica({ rxLigado: true });
      fone3.enviar({ type: 'mesa:sincronizar' });
      assert.equal((await pronta(fone3)).fase, 'pronta');
    });

    await t.test('com calibracao aberta, a leitura da troca de cena espera; o calibrado (plano B) entra na leitura e vem o cena:relida', async () => {
      for (const c of todos) c.esquecer();
      fone3.enviar({ type: 'learn:iniciar', control: null, label: 'Bumbo', kind: 'canal' });
      await fone3.receber('learn:pronto-para');
      const desde = b.linhas.length;
      m.mesaEmite('C0 03'); // cena 4
      await fone3.receber('cena', (x) => x.atual && x.atual.numero === 4);
      await pausa(700);
      assert.equal(fone3.viu('mesa:sincronia'), false, 'leu a mesa com a calibracao aberta');
      assert.deepEqual(chegadasNaMesa(b.linhas, desde), []);

      m.mesaEmite(mesa.paraHex(MINIMO));
      await fone3.receber('learn:midi');
      fone3.enviar({ type: 'learn:capturar', step: 'min' });
      await fone3.receber('learn:capturado');
      await pausa(250);
      m.mesaEmite(mesa.paraHex(MAXIMO));
      await fone3.receber('learn:midi');
      fone3.enviar({ type: 'learn:capturar', step: 'max' });
      await fone3.receber('learn:capturado');
      fone3.enviar({ type: 'learn:salvar' });
      await fone3.receber('learn:salvo');

      const fim = await pronta(fone3);
      assert.deepEqual({ fase: fim.fase, lidos: fim.lidos, total: fim.total }, { fase: 'pronta', lidos: TOTAL_MAPA, total: TOTAL_MAPA + 1 });
      assert.deepEqual(await fone3.receber('cena:relida', () => true, 5000),
        { type: 'cena:relida', numero: 4, lidos: ['bumbo'], semResposta: [] });
      // (o primeiro "state" com o bumbo e o da calibracao, com o valor inicial)
      await fone3.receber('state', (x) => x.values.bumbo === 64 / 255, 5000);
      assert.equal(fone3.viu('mesa:teste'), false, 'testou a mesa com a rota conferida');
      const quadros = chegadasNaMesa(b.linhas, desde);
      assert.ok(quadros.every((c) => c.bytes[2] === 0x32));
      assert.ok(quadros.some((c) => c.hex === pedidoHex(bumboDoTx(0), 2)), 'o calibrado nao foi relido');
    });

    await t.test('criando canais, pedir leitura e recusado e a leitura da troca de cena espera a criacao acabar', async () => {
      for (const c of todos) c.esquecer();
      const desde = b.linhas.length;
      fone3.enviar({ type: 'gerar:canais', base: 'bumbo', canais: [2] }); // canal 2 do bumbo fica calado: 300 ms
      fone3.enviar({ type: 'mesa:sincronizar' });
      assert.match((await fone3.receber('controle:erro')).message, /criando canais/);
      m.mesaEmite('C0 04'); // cena 5
      assert.deepEqual((await fone3.receber('gerar:fim', () => true, 5000)).semResposta, [2]);
      await pronta(fone3);
      await fone3.receber('cena:relida', (x) => x.numero === 5, 5000);
      const quadros = chegadasNaMesa(b.linhas, desde);
      assert.equal(quadros[0].hex, mesa.paraHex(mesa.montarPedido(bumboDoTx(0), 2, 2)), 'a leitura nao esperou a criacao');
      assert.ok(quadros.slice(1).length >= TOTAL_MAPA);
      assert.ok(quadros.every((c) => c.bytes[2] === 0x32));
    });

    await t.test('testando a mesa, pedir leitura e recusado; com a rota conferida, a mesa e lida logo depois do teste', async () => {
      for (const c of todos) c.esquecer();
      const desde = b.linhas.length;
      fone3.enviar({ type: 'mesa:testar' });
      fone3.enviar({ type: 'mesa:sincronizar' });
      assert.match((await fone3.receber('controle:erro')).message, /testando a mesa/);
      assert.equal((await fone3.receber('mesa:teste', (x) => x.fase !== 'testando', 8000)).fase, 'ok');
      assert.equal((await pronta(fone3)).fase, 'pronta');
      const teste = linhasDoTeste(b.linhas, desde);
      assert.deepEqual(chegadasNaMesa(teste.linhas).map((c) => c.hex), [2, 2, 3].map((n) => pedidoHex(bumboDoTx(0), n)));
      const depois = chegadasNaMesa(b.linhas, teste.fim);
      assert.ok(depois.length >= TOTAL_MAPA && depois.every((c) => c.bytes[2] === 0x32));
    });

    await t.test('valor lido acima de 255 prova HIGH: a escala vira 1023 e mexer manda ate 1023', async () => {
      m.mesaFica({ guardar: false, enderecos: mesaDoMapa({ ...conteudo, master: (a) => (a === 1 ? 823 : 100 + a * 10), resolucao: 0 }) });
      for (const c of todos) c.esquecer();
      fone3.enviar({ type: 'mesa:sincronizar' });
      assert.equal((await pronta(fone3)).fase, 'pronta');
      await fone3.receber('mesa:resumo', (x) => x.resolucao === 'alta', 5000);
      const e3 = await fone3.receber('fone:estado', () => true, 5000);
      assert.equal(e3.canais[4].valor, 65 / 1023);
      await mandaEConfere(fone3, { type: 'fone:send', aux: 3, canal: 9, valor: 1 }, 'F0 43 12 3E 7F 01 23 08 08 00 00 07 7F F7');
      await mandaEConfere(fone3, { type: 'fone:send', aux: 3, canal: 9, valor: 0.5 }, 'F0 43 12 3E 7F 01 23 08 08 00 00 04 00 F7');
      const s = await m.status();
      assert.deepEqual([s.mapa.resolucao, s.mapa.resolucaoCrua, s.mapa.motivoResolucao], ['alta', 0, 'valor lido acima de 255']);
    });

    await t.test('HIGH -> LOW com um endereco sem resposta: o valor velho acima de 255 nao segura a escala HIGH', async () => {
      // O operador passa a mesa para LOW; o master do Aux 1 (que estava em 823)
      // nao responde mais. A escala tem que voltar para LOW.
      m.mesaFica({ enderecos: mesaDoMapa({ ...conteudo, resolucao: 0, sem: [...conteudo.sem, END.master(1)] }) });
      for (const c of todos) c.esquecer();
      fone3.enviar({ type: 'mesa:sincronizar' });
      assert.equal((await pronta(fone3)).fase, 'pronta');
      await fone3.receber('mesa:resumo', (x) => x.resolucao === 'baixa', 5000);
      const s = await m.status();
      assert.equal(s.mapa.resolucao, 'baixa', 'o 823 velho do master do Aux 1 segurou HIGH');
      assert.ok(s.mapa.semResposta.includes('kAUXFader/kFader#1'));
      await mandaEConfere(fone3, { type: 'fone:send', aux: 3, canal: 9, valor: 1 }, 'F0 43 12 3E 7F 01 23 08 08 00 00 01 7F F7');
      // O master que nao respondeu fica desconhecido e nao e escrito.
      fone3.enviar({ type: 'fone:master', aux: 1, valor: 1 });
      assert.match((await fone3.receber('controle:erro')).message, /nao confirmou/);
    });

    await t.test('lendo a mesa, o que o celular mexe espera a leitura acabar e vale mais que a resposta velha', async () => {
      m.mesaFica({ enderecos: mesaDoMapa({ ...conteudo, resolucao: 0 }) }); // a mesa responde 70 no canal 10 do Aux 3
      for (const c of todos) c.esquecer();
      const desde = b.linhas.length;
      fone3.enviar({ type: 'mesa:sincronizar' });
      await fone3.receber('mesa:sincronia', (x) => x.fase === 'lendo');
      fone3.enviar({ type: 'fone:send', aux: 3, canal: 10, valor: 1 });
      assert.equal((await pronta(fone3)).fase, 'pronta');
      const e3 = await fone3.receber('fone:estado', () => true, 5000);
      assert.equal(e3.canais[9].valor, 1, 'a resposta velha da leitura passou por cima do que o musico mexeu');
      const esperado = 'F0 43 12 3E 7F 01 23 08 09 00 00 01 7F F7';
      await esperarAte(() => mudancasDesde(desde).some((c) => c.hex === esperado && c.aceitou), 'o send sair depois da leitura');
      const chegadas = chegadasNaMesa(b.linhas, desde);
      const iEnvio = chegadas.findIndex((c) => c.hex === esperado);
      const iUltimoPedido = chegadas.map(ehPedido).lastIndexOf(true);
      assert.ok(iEnvio > iUltimoPedido, 'o Parameter change saiu no meio da leitura');
      assert.equal(chegadas.filter(ehMudanca).length, 1);
    });

    await t.test('On que responde fora de 0 ou 1 nao confirma o endereco, e ele nao e escrito', async () => {
      m.mesaFica({ enderecos: mesaDoMapa({ ...conteudo, resolucao: 0, extra: { ...conteudo.extra, [END.sendOn(3, 11)]: quatro(5) } }) });
      for (const c of todos) c.esquecer();
      fone3.enviar({ type: 'mesa:sincronizar' });
      assert.equal((await pronta(fone3)).fase, 'pronta');
      const e3 = await fone3.receber('fone:estado', () => true, 5000);
      assert.deepEqual({ on: e3.canais[10].on, confirmado: e3.canais[10].confirmado }, { on: null, confirmado: false });
      assert.ok((await m.status()).mapa.semResposta.includes('kInputAUX/kAUX3On#11'));
      const desde = b.linhas.length;
      fone3.enviar({ type: 'fone:sendOn', aux: 3, canal: 11, on: true });
      assert.match((await fone3.receber('controle:erro')).message, /nao confirmou/);
      await pausa(150);
      assert.deepEqual(mudancasDesde(desde), []);
    });

    await t.test('so a leitura de Fader Resolution, sem codificacao conferida, nao basta: na duvida, LOW', async () => {
      m.mesaFica({ enderecos: mesaDoMapa({ ...conteudo, resolucao: 0 }) });
      for (const c of todos) c.esquecer();
      fone3.enviar({ type: 'mesa:sincronizar' });
      assert.equal((await pronta(fone3)).fase, 'pronta');
      await fone3.receber('mesa:resumo', (x) => x.resolucao === 'baixa', 5000);
      await mandaEConfere(fone3, { type: 'fone:send', aux: 3, canal: 9, valor: 1 }, 'F0 43 12 3E 7F 01 23 08 08 00 00 01 7F F7');
      const s = await m.status();
      assert.deepEqual([s.mapa.resolucao, s.mapa.resolucaoCrua], ['baixa', 0]);
      assert.match(s.mapa.motivoResolucao, /nenhum valor acima de 255/);
    });

    await t.test('resposta atrasada acima de 255 com a escala em LOW nao sobe a escala; o envio seguinte sai ate 255', async () => {
      // O send do canal 32 para o Aux 7 responde 300, 1,8 s depois: chega
      // depois do fim da leitura, na quarentena, como resposta velha.
      const atrasado = END.send(7, 32);
      m.mesaFica({
        enderecos: mesaDoMapa({ ...conteudo, resolucao: 0, extra: { ...conteudo.extra, [atrasado]: quatro(300) } }),
        atrasos: { [atrasado]: 1800 }
      });
      for (const c of todos) c.esquecer();
      try {
        fone3.enviar({ type: 'mesa:sincronizar' });
        assert.equal((await pronta(fone3)).fase, 'pronta');
        assert.equal((await m.status()).mapa.resolucao, 'baixa');
        await esperarAte(() => b.linhas.filter((l) => l.includes('resposta atrasada da mesa') &&
          l.includes(atrasado)).length >= 2, 'as duas respostas atrasadas chegarem', 6000);
        assert.equal((await m.status()).mapa.resolucao, 'baixa', 'a resposta atrasada de 300 subiu a escala para HIGH');
        await mandaEConfere(fone3, { type: 'fone:send', aux: 3, canal: 9, valor: 1 }, 'F0 43 12 3E 7F 01 23 08 08 00 00 01 7F F7');
      } finally {
        m.mesaFica({ atrasos: {} });
      }
    });

    await t.test('resposta atrasada da leitura nao cai na calibracao aberta logo depois', async () => {
      // A ultima letra do nome do canal 32 (o ultimo pedido da leitura)
      // responde 1,8 s depois, as duas vezes: depois do fim da leitura e
      // dentro da quarentena (2 s a partir do fim).
      const ultima = END.nomeCanal(32, 16);
      m.mesaFica({ atrasos: { [ultima]: 1800 } });
      for (const c of todos) c.esquecer();
      fone3.enviar({ type: 'mesa:sincronizar' });
      const fim = await pronta(fone3);
      // Faltam o send 8/32 (a mesa nao tem) e a letra atrasada.
      assert.equal(fim.lidos, fim.total - 2, 'a letra atrasada nao podia ter chegado durante a leitura');
      fone3.enviar({ type: 'learn:iniciar', control: null, label: 'Teclado', kind: 'canal' });
      await fone3.receber('learn:pronto-para');
      try {
        await esperarAte(() => b.linhas.filter((l) => l.includes('resposta atrasada da mesa') &&
          l.includes(ultima)).length >= 2, 'as duas respostas atrasadas chegarem', 5000);
        assert.equal(fone3.viu('learn:midi'), false, 'a resposta atrasada virou quadro de calibracao');
        fone3.enviar({ type: 'learn:capturar', step: 'min' });
        assert.match((await fone3.receber('learn:erro')).message, /Parameter Change TX/);
      } finally {
        fone3.enviar({ type: 'learn:cancelar' });
        m.mesaFica({ atrasos: {} });
      }
      const s = await m.status();
      assert.ok(s.mapa.semResposta.includes('kInputChannelName/kChannelNameLong16#32'));
    });
  } finally {
    for (const c of todos) c.fechar();
    await m.parar();
  }
});

test('modo mapa sem rota: a mesa nao responde ao teste, nada e lido nem escrito; com a codificacao conferida no config, a leitura de Fader Resolution decide HIGH', async (t) => {
  const m = await bridgeComMesa({
    mesaInicial: {
      entradas: [USB.in1], saidas: [USB.out1],
      txCh: 0, rxCh: 0, rxLigado: false, portaTx: USB.in1, portaResposta: USB.in1,
      enderecos: mesaDoMapa({ resolucao: 0 })
    },
    // Ciclo de envio de 1 s: da para ver um lote de cada vez (teste dos 32 por ciclo).
    config: { midi: { ...midiDoMapa, resolucaoAltaCrua: 0, intervaloEnvioMs: 1000 }, aplicarEstadoAoIniciar: false, controles: [] }
  });
  const { b } = m;
  const cel = await conectarCelular(b.porta);
  try {
    await t.test('sem rota: o fone mostra so os nomes padrao e nada sai para a mesa alem do teste', async () => {
      await esperarAte(() => b.linhas.some((l) => l.includes('[mesa] fim do teste da mesa')), 'o teste da mesa acabar', 10000);
      const teste = linhasDoTeste(b.linhas);
      const chegadas = chegadasNaMesa(teste.linhas);
      assert.equal(chegadas.length, 16);
      assert.ok(chegadas.every((c) => ehPedido(c) && mesa.paraHex(c.bytes.slice(4, 9)) === END.send(1, 1)));

      cel.enviar({ type: 'fone:escolher', aux: 1 });
      const e1 = await cel.receber('fone:estado');
      assert.equal(e1.nome, 'Aux 1');
      assert.deepEqual(e1.master, { valor: null, on: null });
      assert.deepEqual(e1.canais[0], { canal: 1, nome: 'Canal 1', valor: null, on: null, confirmado: false });
      assert.equal((await cel.receber('mesa:resumo')).pronta, false);

      const desde = b.linhas.length;
      cel.enviar({ type: 'fone:send', aux: 1, canal: 1, valor: 1 });
      assert.match((await cel.receber('controle:erro')).message, /caminho/);
      cel.enviar({ type: 'fone:masterOn', aux: 1, on: true });
      assert.match((await cel.receber('controle:erro')).message, /caminho/);
      cel.enviar({ type: 'mesa:sincronizar' });
      assert.match((await cel.receber('controle:erro')).message, /Testar a mesa/);
      await pausa(300);
      assert.deepEqual(chegadasNaMesa(b.linhas, desde), [], 'saiu algo para a mesa sem rota');
      assert.ok(chegadasNaMesa(b.linhas).every(ehPedido), 'saiu Parameter change sem rota');
      const s = await m.status();
      assert.deepEqual([s.mapa.pronta, s.mapa.lidos, s.mapa.resolucao, s.mapa.sincronizadaEm], [false, 0, null, null]);
    });

    await t.test('a mesa volta a ouvir: o teste acha a rota, a mesa e lida e a leitura de Fader Resolution decide HIGH', async () => {
      m.mesaFica({ rxLigado: true });
      cel.esquecer();
      cel.enviar({ type: 'mesa:testar' });
      assert.equal((await cel.receber('mesa:teste', (x) => x.fase !== 'testando', 8000)).fase, 'ok');
      assert.equal((await cel.receber('mesa:sincronia', (x) => x.fase !== 'lendo', 20000)).fase, 'pronta');
      assert.equal((await cel.receber('mesa:resumo', (x) => x.pronta, 5000)).resolucao, 'alta');
      const s = await m.status();
      assert.match(s.mapa.motivoResolucao, /leitura da mesa \(Fader Resolution = 0\)/);
      const desde = b.linhas.length;
      cel.enviar({ type: 'fone:send', aux: 1, canal: 1, valor: 1 });
      await esperarAte(() => chegadasNaMesa(b.linhas, desde).some((c) => c.aceitou &&
        c.hex === 'F0 43 10 3E 7F 01 23 02 00 00 00 07 7F F7'), 'o send no maximo de HIGH');
    });

    await t.test('muitos envios de uma vez saem no maximo 32 por ciclo; o resto sai no ciclo seguinte', async () => {
      // Durante a leitura os envios esperam na fila: 40 enderecos diferentes
      // ficam la ao mesmo tempo e saem quando ela acaba.
      cel.esquecer();
      const desde = b.linhas.length;
      cel.enviar({ type: 'mesa:sincronizar' });
      await cel.receber('mesa:sincronia', (x) => x.fase === 'lendo');
      for (let canal = 1; canal <= 32; canal++) cel.enviar({ type: 'fone:send', aux: 1, canal, valor: 0.5 });
      for (let canal = 1; canal <= 8; canal++) cel.enviar({ type: 'fone:send', aux: 2, canal, valor: 0.5 });
      assert.equal((await cel.receber('mesa:sincronia', (x) => x.fase !== 'lendo', 20000)).fase, 'pronta');
      const mudancas = () => chegadasNaMesa(b.linhas, desde).filter(ehMudanca);
      await esperarAte(() => mudancas().length > 0, 'o primeiro lote sair', 5000);
      await pausa(300); // o proximo ciclo e daqui a 1 s
      assert.equal(mudancas().length, 32, 'o primeiro ciclo nao parou em 32');
      await esperarAte(() => mudancas().length === 40, 'o resto sair no ciclo seguinte', 5000);
      assert.ok(mudancas().every((c) => c.aceitou && valorDoQuadro(c.bytes) === 512), 'valor errado (HIGH: 0.5 = 512)');
    });
  } finally {
    cel.fechar();
    await m.parar();
  }
});

test('a calibracao de verdade (config.json do programa) nao foi tocada', () => {
  const agora = fs.existsSync(CONFIG_REAL) ? fs.readFileSync(CONFIG_REAL, 'utf8') : null;
  assert.equal(agora, configRealAntes);
});
