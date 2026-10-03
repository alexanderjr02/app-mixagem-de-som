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
  ws.on('message', (dados) => recebidas.push(JSON.parse(dados.toString())));
  await new Promise((ok, erro) => { ws.once('open', ok); ws.once('error', erro); });

  return {
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
async function subirBridge({ config, estado, antes = [], env = {} }) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-bridge-'));
  const porta = await portaLivre();
  fs.writeFileSync(path.join(pasta, 'config.json'), JSON.stringify({
    ...config,
    servidor: { porta, host: '127.0.0.1' }
  }));
  if (estado) fs.writeFileSync(path.join(pasta, 'estado.json'), JSON.stringify(estado));

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
 * Ela tambem responde Parameter request (F0 43 3n ...) como o manual descreve:
 * devolve, pelas entradas abertas, o Parameter change do mesmo endereco com o
 * valor de "respostas" no arquivo ({ "2": [0, 64] } = canal 2 responde 64).
 * Canal ausente em "respostas" = a mesa fica calada.
 */
const MESA_FALSA = `
const Module = require('module');
const fs = require('fs');
const ARQUIVO = process.env.MESA_FALSA;
function mesa() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')); } catch { return { portas: [], geracao: 0 }; }
}
const entradasAbertas = new Set();
function responderPedido(bytes) {
  if ((bytes[2] & 0xf0) !== 0x30) return;
  const valor = (mesa().respostas || {})[String(bytes[8] + 1)];
  if (!Array.isArray(valor)) return;
  const quadro = [0xf0, 0x43, 0x10 | (bytes[2] & 0x0f), ...bytes.slice(3, 9), ...valor, 0xf7];
  setTimeout(() => {
    for (const entrada of entradasAbertas) if (entrada.aoReceber) entrada.aoReceber(0, quadro);
  }, 5);
}
class Porta {
  getPortCount() { return mesa().portas.length; }
  getPortName(i) { return mesa().portas[i] || ''; }
  openPort(i) {
    const m = mesa();
    if (!m.portas[i]) throw new Error('Invalid MIDI port number');
    this.aberta = m.portas[i];
    this.geracao = m.geracao;
  }
  closePort() { this.aberta = null; }
  openVirtualPort() {}
  ignoreTypes() {}
  on() {}
  sendMessage(bytes) {
    const m = mesa();
    if (!this.aberta || !m.portas.includes(this.aberta) || m.geracao !== this.geracao) {
      throw new Error('Internal RtMidi error');
    }
    const hex = bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    console.log('[mesa falsa] #' + this.geracao + ' ' + hex);
    responderPedido(bytes);
  }
}
class Entrada extends Porta {
  on(evento, aoReceber) { if (evento === 'message') this.aoReceber = aoReceber; }
  openPort(i) { super.openPort(i); entradasAbertas.add(this); }
  closePort() { super.closePort(); entradasAbertas.delete(this); }
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
      midi: { entrada: null, saida: null, intervaloEnvioMs: 10, janelaEcoMs: 50, intervaloProcuraMs: 100 },
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
        intervaloProcuraMs: 100, esperaRespostaMs: 600 },
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

test('a calibracao de verdade (config.json do programa) nao foi tocada', () => {
  const agora = fs.existsSync(CONFIG_REAL) ? fs.readFileSync(CONFIG_REAL, 'utf8') : null;
  assert.equal(agora, configRealAntes);
});
