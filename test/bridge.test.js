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
 */
const MESA_FALSA = `
const Module = require('module');
const fs = require('fs');
const ARQUIVO = process.env.MESA_FALSA;
function mesa() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')); } catch { return { portas: [], geracao: 0 }; }
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
  }
}
const falso = { Input: Porta, Output: Porta };
const carregar = Module._load;
Module._load = function (pedido, ...resto) {
  if (pedido === '@julusian/midi' || pedido === 'midi') return falso;
  return carregar.call(this, pedido, ...resto);
};
`;

test('PC ligado direto: a mesa desliga, liga de novo e o bridge volta sozinho', async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-mesa-falsa-'));
  const preload = path.join(pasta, 'mesa-falsa.js');
  const estadoMesa = path.join(pasta, 'mesa.json');
  fs.writeFileSync(preload, MESA_FALSA);

  // Escreve e renomeia, para o bridge nunca ler o arquivo pela metade.
  const mesaFica = (portas, geracao) => {
    fs.writeFileSync(estadoMesa + '.tmp', JSON.stringify({ portas, geracao }));
    fs.renameSync(estadoMesa + '.tmp', estadoMesa);
  };
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
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

test('a calibracao de verdade (config.json do programa) nao foi tocada', () => {
  const agora = fs.existsSync(CONFIG_REAL) ? fs.readFileSync(CONFIG_REAL, 'utf8') : null;
  assert.equal(agora, configRealAntes);
});
