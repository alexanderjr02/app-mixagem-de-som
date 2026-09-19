'use strict';
/**
 * bridge.js
 * O programa que fica rodando na maquina ligada na mesa por USB (Raspberry Pi
 * ou um PC). Ele faz quatro coisas ao mesmo tempo:
 *
 *   1. serve o app (pasta public/) por HTTP, para o celular abrir no navegador
 *   2. mantem um WebSocket com cada celular conectado, para resposta imediata
 *   3. traduz cada movimento de fader em uma mensagem SysEx para a 01V96
 *   4. conduz a calibracao pedida pelo celular, sem precisar de terminal
 *
 * Seguranca de audio: o bridge so envia SysEx de controles marcados como
 * "calibrado": true no config.json. Enquanto voce nao calibrar, mexer nos
 * faders so muda a tela, nunca a mesa. Assim nao tem risco de mandar um
 * endereco chutado e bagunçar a mixagem da igreja.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch {
  console.error('Falta instalar as dependencias. Rode: npm install');
  process.exit(1);
}

const configArquivo = require('./config');
const { abrirSaida, abrirEntrada, midiDisponivel, mensagemErroMidi } = require('./midi-io');
const mesa = require('./yamaha01v96');

const DIR_PUBLIC = path.join(configArquivo.RAIZ, 'public');

// ---------------------------------------------------------------------------
// Configuracao e estado
// ---------------------------------------------------------------------------

let cfg;
try {
  cfg = configArquivo.carregar();
} catch (erro) {
  console.error('Erro no config.json: ' + erro.message);
  process.exit(1);
}

// A lista de controles muda em tempo de execucao (calibracao pelo celular),
// entao ela e sempre alterada no lugar, nunca trocada por outro array.
const controles = cfg.controles;
const porId = new Map();
const naoCalibrados = [];

const estado = { valores: {}, mutes: {} };
const salvo = configArquivo.carregarEstado();

/** Refaz os indices depois de qualquer mudanca na lista de controles. */
function aplicarListaDeControles(lista) {
  controles.length = 0;
  controles.push(...lista);

  porId.clear();
  naoCalibrados.length = 0;

  for (const c of controles) {
    porId.set(c.id, c);

    if (typeof estado.valores[c.id] !== 'number') {
      const restaurado = salvo.valores[c.id];
      estado.valores[c.id] = typeof restaurado === 'number'
        ? mesa.limitar01(restaurado)
        : mesa.limitar01(typeof c.valorInicial === 'number' ? c.valorInicial : 0.5);
    }
    if (typeof estado.mutes[c.id] !== 'boolean') {
      estado.mutes[c.id] = salvo.mutes[c.id] === true;
    }

    if (!mesa.estaCalibrado(c)) {
      naoCalibrados.push(c.id);
      continue;
    }
    const problemas = mesa.validarControle(c);
    if (problemas.length) {
      console.warn('[config] controle "' + c.id + '": ' + problemas.join('; '));
    }
  }
}

aplicarListaDeControles(cfg.controles.slice());

/** Grava a lista atual no config.json, relendo o arquivo para nao perder nada. */
function gravarControles(transformar) {
  const atual = configArquivo.carregar();
  const nova = transformar(atual.controles.slice());
  atual.controles = nova;
  configArquivo.salvar(atual);
  aplicarListaDeControles(nova);
}

// ---------------------------------------------------------------------------
// MIDI
// ---------------------------------------------------------------------------

const saidaMidi = abrirSaida(cfg.midi.saida);
const entradaMidi = abrirEntrada(cfg.midi.entrada, aoReceberDaMesa);

if (saidaMidi.simulado) {
  console.warn('[midi] SAIDA em modo simulado. Motivo: ' + saidaMidi.motivo);
  console.warn('[midi] A interface funciona normalmente, mas nada chega na mesa.');
} else {
  console.log('[midi] saida: ' + saidaMidi.nome);
}

if (entradaMidi.simulado) {
  console.warn('[midi] ENTRADA em modo simulado. Motivo: ' + entradaMidi.motivo);
} else {
  console.log('[midi] entrada: ' + entradaMidi.nome);
}

/**
 * Fila de envio. Arrastar um fader gera dezenas de eventos por segundo; em vez
 * de despejar tudo na mesa, guardamos so o ultimo valor de cada controle e
 * mandamos em lote a cada intervaloEnvioMs. A resposta continua imediata no
 * ouvido e a mesa nao leva enxurrada de SysEx.
 */
const pendentes = new Map();
const ultimoEnvio = new Map(); // id -> instante do ultimo envio, para ignorar eco

function valorEfetivo(id) {
  return estado.mutes[id] ? 0 : estado.valores[id];
}

function agendarEnvio(id) {
  pendentes.set(id, valorEfetivo(id));
}

function despacharFila() {
  if (!pendentes.size) return;
  for (const [id, valor] of pendentes) {
    const controle = porId.get(id);
    if (!controle) continue;
    if (!mesa.estaCalibrado(controle)) continue; // protecao: nunca chutar bytes
    try {
      saidaMidi.enviar(mesa.montarFrame(controle, valor));
      ultimoEnvio.set(id, Date.now());
    } catch (erro) {
      console.error('[midi] falha ao montar quadro de "' + id + '": ' + erro.message);
    }
  }
  pendentes.clear();
}

setInterval(despacharFila, Math.max(5, cfg.midi.intervaloEnvioMs || 25)).unref();

/**
 * Chegou SysEx da mesa.
 *
 * Se alguem estiver calibrando pelo celular, o quadro vai para essa conversa.
 * Fora isso, se ele bater com o molde de algum controle ja calibrado, o estado
 * e atualizado e os celulares avisados: mexeu no send direto na mesa, o app
 * acompanha em vez de mostrar valor errado.
 */
function aoReceberDaMesa(bytes) {
  if (sessoes.size) {
    for (const [cliente, sessao] of sessoes) alimentarSessao(cliente, sessao, bytes);
    return;
  }

  const janela = cfg.midi.janelaEcoMs || 400;
  for (const controle of controles) {
    const raw = mesa.lerValorDoFrame(controle, bytes);
    if (raw === null) continue;

    // Se acabamos de mandar esse controle, o que voltou e eco do nosso proprio
    // envio. Aceitar isso faria o fader tremer na mao do usuario.
    const quando = ultimoEnvio.get(controle.id) || 0;
    if (Date.now() - quando < janela) return;

    const valor = mesa.escalarParaNormalizado(raw, controle.rawMin, controle.rawMax);
    estado.valores[controle.id] = valor;
    if (valor > 0) estado.mutes[controle.id] = false;

    transmitir({
      type: 'state',
      values: { [controle.id]: valor },
      mutes: { [controle.id]: estado.mutes[controle.id] }
    });
    agendarSalvamento();
    return;
  }
}

// ---------------------------------------------------------------------------
// Calibracao conduzida pelo celular
// ---------------------------------------------------------------------------

/**
 * Uma sessao por celular que estiver calibrando. Guarda o ultimo quadro que a
 * mesa mandou, que e justamente o valor em que o controle parou quando a
 * pessoa tirou a mao.
 */
const sessoes = new Map();

function alimentarSessao(cliente, sessao, bytes) {
  sessao.ultimoFrame = bytes;
  sessao.contagem++;

  // Feedback ao vivo ("a mesa esta falando"), no maximo cinco vezes por segundo.
  const agora = Date.now();
  if (agora - sessao.ultimoAviso < 200) return;
  sessao.ultimoAviso = agora;

  enviarPara(cliente, {
    type: 'learn:midi',
    count: sessao.contagem,
    hex: mesa.paraHex(bytes)
  });
}

function iniciarSessao(cliente, msg) {
  sessoes.set(cliente, {
    idAtual: typeof msg.control === 'string' ? msg.control : null,
    rotulo: String(msg.label || '').trim().slice(0, 40),
    tipo: ['canal', 'reverb', 'master'].includes(msg.kind) ? msg.kind : 'canal',
    frameMin: null,
    frameMax: null,
    ultimoFrame: null,
    contagem: 0,
    ultimoAviso: 0
  });
  enviarPara(cliente, { type: 'learn:pronto-para', step: 'min' });
}

function capturarNaSessao(cliente, msg) {
  const sessao = sessoes.get(cliente);
  if (!sessao) return;

  if (!sessao.ultimoFrame) {
    enviarPara(cliente, {
      type: 'learn:erro',
      message:
        'Nenhuma mensagem chegou da mesa. Confira no menu MIDI da 01V96 se o ' +
        'Parameter Change TX esta ligado e se a porta e USB, e mexa no controle antes de tocar aqui.'
    });
    return;
  }

  const passo = msg.step === 'max' ? 'max' : 'min';
  if (passo === 'min') sessao.frameMin = sessao.ultimoFrame;
  else sessao.frameMax = sessao.ultimoFrame;

  const hex = mesa.paraHex(sessao.ultimoFrame);
  sessao.ultimoFrame = null;
  sessao.contagem = 0;

  enviarPara(cliente, {
    type: 'learn:capturado',
    step: passo,
    hex,
    proximo: passo === 'min' ? 'max' : 'fim'
  });
}

function salvarSessao(cliente) {
  const sessao = sessoes.get(cliente);
  if (!sessao) return;

  if (!sessao.frameMin || !sessao.frameMax) {
    enviarPara(cliente, { type: 'learn:erro', message: 'Faltou capturar o minimo ou o maximo.' });
    return;
  }

  const rotulo = sessao.rotulo || 'Controle';
  const id = configArquivo.idUnico(rotulo, controles, sessao.idAtual);

  let resultado;
  try {
    resultado = mesa.criarControle({
      id,
      rotulo,
      tipo: sessao.tipo,
      valorInicial: porId.get(sessao.idAtual)?.valorInicial ?? 0.5,
      frameMin: sessao.frameMin,
      frameMax: sessao.frameMax
    });
  } catch (erro) {
    enviarPara(cliente, { type: 'learn:erro', message: erro.message });
    return;
  }

  const controle = resultado.controle;

  try {
    gravarControles((lista) => {
      const i = lista.findIndex((c) => c.id === (sessao.idAtual || controle.id));
      if (i >= 0) lista[i] = controle;
      else lista.push(controle);
      return lista;
    });
  } catch (erro) {
    enviarPara(cliente, { type: 'learn:erro', message: 'Nao consegui salvar: ' + erro.message });
    return;
  }

  sessoes.delete(cliente);
  console.log('[learn] controle "' + controle.rotulo + '" calibrado (offset ' +
    controle.valueOffset + ', ' + controle.valueLength + ' byte(s), ' +
    controle.rawMin + ' a ' + controle.rawMax + ')');

  enviarPara(cliente, {
    type: 'learn:salvo',
    control: { id: controle.id, label: controle.rotulo, type: controle.tipo },
    faixa: { rawMin: controle.rawMin, rawMax: controle.rawMax },
    bytes: { offset: controle.valueOffset, length: controle.valueLength },
    avisos: resultado.avisos
  });

  anunciarControles();
}

function anunciarControles() {
  transmitir({ type: 'controls', controls: listaParaApp() });
  transmitir({ type: 'state', values: estado.valores, mutes: estado.mutes });
}

// ---------------------------------------------------------------------------
// Servidor HTTP (o app em si)
// ---------------------------------------------------------------------------

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function responderJson(res, dados, status = 200) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(corpo),
    'Cache-Control': 'no-store'
  });
  res.end(corpo);
}

function listaParaApp() {
  return controles.map((c) => ({
    id: c.id,
    label: c.rotulo || c.id,
    type: c.tipo || 'canal',
    calibrated: mesa.estaCalibrado(c)
  }));
}

const servidor = http.createServer((req, res) => {
  let caminhoUrl;
  try {
    caminhoUrl = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  } catch {
    res.writeHead(400);
    res.end('URL invalida');
    return;
  }

  // Entrada de mesa simulada: so existe quando nao ha porta MIDI de verdade.
  // E o que permite testar a calibracao inteira sem estar perto da 01V96.
  if (caminhoUrl === '/api/simular' && req.method === 'POST') {
    if (!entradaMidi.simulado) {
      responderJson(res, { erro: 'a entrada MIDI e real, nada a simular' }, 409);
      return;
    }
    let corpo = '';
    req.on('data', (p) => {
      corpo += p;
      if (corpo.length > 8192) req.destroy();
    });
    req.on('end', () => {
      try {
        const { hex } = JSON.parse(corpo);
        const bytes = String(hex).trim().split(/[\s,]+/).map((b) => parseInt(b, 16));
        if (!bytes.length || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
          responderJson(res, { erro: 'hex invalido' }, 400);
          return;
        }
        aoReceberDaMesa(bytes);
        responderJson(res, { ok: true, bytes: bytes.length });
      } catch (erro) {
        responderJson(res, { erro: erro.message }, 400);
      }
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Metodo nao suportado');
    return;
  }

  if (caminhoUrl === '/api/controls') {
    responderJson(res, { controls: listaParaApp() });
    return;
  }
  if (caminhoUrl === '/api/status') {
    responderJson(res, {
      midi: {
        saida: saidaMidi.nome,
        entrada: entradaMidi.nome,
        simulado: saidaMidi.simulado,
        entradaSimulada: entradaMidi.simulado
      },
      clientes: wss ? wss.clients.size : 0,
      naoCalibrados
    });
    return;
  }

  if (caminhoUrl === '/') caminhoUrl = '/index.html';

  const destino = path.normalize(path.join(DIR_PUBLIC, caminhoUrl));
  if (destino !== DIR_PUBLIC && !destino.startsWith(DIR_PUBLIC + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acesso negado');
    return;
  }

  fs.stat(destino, (erro, info) => {
    if (erro || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Nao encontrado');
      return;
    }

    const tipo = TIPOS[path.extname(destino).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': tipo,
      'Content-Length': info.size,
      'Cache-Control': 'no-cache'
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const fluxo = fs.createReadStream(destino);
    fluxo.on('error', () => res.end());
    fluxo.pipe(res);
  });
});

// ---------------------------------------------------------------------------
// WebSocket (tempo real)
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: servidor });

function enviarPara(cliente, objeto) {
  if (cliente.readyState === cliente.OPEN) {
    cliente.send(JSON.stringify(objeto));
  }
}

/** Manda para todos, com a opcao de pular quem originou a mudanca. */
function transmitir(objeto, exceto = null) {
  const texto = JSON.stringify(objeto);
  for (const cliente of wss.clients) {
    if (cliente === exceto) continue;
    if (cliente.readyState === cliente.OPEN) cliente.send(texto);
  }
}

wss.on('connection', (cliente, req) => {
  const origem = (req.socket.remoteAddress || '?').replace('::ffff:', '');
  console.log('[ws] celular conectado: ' + origem + ' (total: ' + wss.clients.size + ')');

  cliente.vivo = true;
  cliente.on('pong', () => { cliente.vivo = true; });

  // Sequencia de boas vindas: lista de faders, situacao do MIDI e estado atual.
  enviarPara(cliente, { type: 'controls', controls: listaParaApp() });
  enviarPara(cliente, {
    type: 'status',
    midi: {
      simulado: saidaMidi.simulado,
      entradaSimulada: entradaMidi.simulado,
      saida: saidaMidi.nome,
      entrada: entradaMidi.nome,
      motivo: saidaMidi.motivo || null
    }
  });
  enviarPara(cliente, { type: 'state', values: estado.valores, mutes: estado.mutes });

  cliente.on('message', (dados) => {
    let msg;
    try {
      msg = JSON.parse(dados.toString());
    } catch {
      return; // mensagem invalida: ignora em silencio
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'set': {
        const controle = porId.get(msg.control);
        if (!controle) return;

        const valor = mesa.limitar01(msg.value);
        estado.valores[controle.id] = valor;

        // Mexer no fader tira o mudo: e o gesto natural de quem quer ouvir.
        if (estado.mutes[controle.id] && valor > 0) estado.mutes[controle.id] = false;

        agendarEnvio(controle.id);
        agendarSalvamento();

        transmitir(
          {
            type: 'state',
            values: { [controle.id]: valor },
            mutes: { [controle.id]: estado.mutes[controle.id] }
          },
          cliente
        );
        return;
      }

      case 'mute': {
        const controle = porId.get(msg.control);
        if (!controle) return;

        estado.mutes[controle.id] = msg.muted === true;
        agendarEnvio(controle.id);
        agendarSalvamento();

        transmitir(
          { type: 'state', values: {}, mutes: { [controle.id]: estado.mutes[controle.id] } },
          cliente
        );
        return;
      }

      case 'learn:iniciar':
        iniciarSessao(cliente, msg);
        return;

      case 'learn:capturar':
        capturarNaSessao(cliente, msg);
        return;

      case 'learn:salvar':
        salvarSessao(cliente);
        return;

      case 'learn:cancelar':
        sessoes.delete(cliente);
        return;

      case 'controle:remover': {
        if (!porId.has(msg.control)) return;
        try {
          gravarControles((lista) => lista.filter((c) => c.id !== msg.control));
          delete estado.valores[msg.control];
          delete estado.mutes[msg.control];
          anunciarControles();
        } catch (erro) {
          enviarPara(cliente, { type: 'learn:erro', message: erro.message });
        }
        return;
      }

      case 'ping':
        enviarPara(cliente, { type: 'pong' });
        return;
    }
  });

  cliente.on('close', () => {
    sessoes.delete(cliente);
    console.log('[ws] celular saiu: ' + origem + ' (total: ' + wss.clients.size + ')');
  });

  cliente.on('error', (erro) => {
    sessoes.delete(cliente);
    console.warn('[ws] erro no cliente ' + origem + ': ' + erro.message);
  });
});

// Celular que dormiu ou saiu do Wi-Fi nem sempre fecha a conexao direito.
// O ping periodico limpa esses fantasmas.
setInterval(() => {
  for (const cliente of wss.clients) {
    if (cliente.vivo === false) {
      cliente.terminate();
      continue;
    }
    cliente.vivo = false;
    try { cliente.ping(); } catch { /* ignora */ }
  }
}, 20000).unref();

// ---------------------------------------------------------------------------
// Persistencia do mix
// ---------------------------------------------------------------------------

let timerSalvar = null;
function agendarSalvamento() {
  if (timerSalvar) return;
  timerSalvar = setTimeout(() => {
    timerSalvar = null;
    configArquivo.salvarEstado(estado);
  }, 2000);
  timerSalvar.unref();
}

// ---------------------------------------------------------------------------
// Inicializacao
// ---------------------------------------------------------------------------

const porta = cfg.servidor.porta || 8080;
const host = cfg.servidor.host || '0.0.0.0';

servidor.on('error', (erro) => {
  if (erro.code === 'EADDRINUSE') {
    console.error('A porta ' + porta + ' ja esta em uso. Mude "servidor.porta" no config.json.');
  } else {
    console.error('Erro no servidor: ' + erro.message);
  }
  process.exit(1);
});

servidor.listen(porta, host, () => {
  console.log('');
  console.log('Monitor 01V96 no ar');
  console.log('  neste computador ... http://localhost:' + porta);
  for (const ip of enderecosLocais()) {
    console.log('  pelo celular ....... http://' + ip + ':' + porta);
  }
  console.log('  controles .......... ' + controles.length);
  if (naoCalibrados.length) {
    console.log('  falta calibrar ..... ' + naoCalibrados.length +
      ' (da para fazer pelo proprio celular, no botao de ajustes)');
  }
  if (!midiDisponivel()) {
    console.log('  midi ............... indisponivel (' + mensagemErroMidi() + ')');
  }
  console.log('');

  // Opcional: reenviar o mix salvo para a mesa ao ligar a maquina.
  if (cfg.aplicarEstadoAoIniciar) {
    for (const c of controles) if (mesa.estaCalibrado(c)) agendarEnvio(c.id);
    console.log('[midi] reaplicando o ultimo mix salvo na mesa');
  }
});

/** IPs da maquina, para voce saber o que digitar no celular. */
function enderecosLocais() {
  const os = require('os');
  const lista = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const rede of interfaces || []) {
      if (rede.family === 'IPv4' && !rede.internal) lista.push(rede.address);
    }
  }
  return lista;
}

function encerrar() {
  console.log('\nEncerrando...');
  despacharFila();
  configArquivo.salvarEstado(estado);
  try { saidaMidi.fechar(); } catch { /* ignora */ }
  try { entradaMidi.fechar(); } catch { /* ignora */ }
  for (const cliente of wss.clients) {
    try { cliente.close(1001, 'servidor encerrando'); } catch { /* ignora */ }
  }
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
