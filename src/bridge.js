'use strict';
/**
 * bridge.js
 * O programa que fica rodando na maquina ligada na mesa por USB (Raspberry Pi
 * ou um PC). Ele faz quatro coisas ao mesmo tempo:
 *
 *   1. serve o app (pasta public/) por HTTP, para o celular abrir no navegador
 *   2. mantem um WebSocket com cada celular conectado, para resposta imediata
 *   3. traduz cada movimento de fader em uma mensagem SysEx para a 01V96
 *   4. conduz a calibracao pedida pelo celular, sem precisar de terminal,
 *      e cria os outros canais a partir de um calibrado, conferindo cada um
 *      com a mesa
 *   5. percebe quando a equipe chama uma cena na mesa, mostra qual entrou e
 *      rele da mesa os controles calibrados (so leitura)
 *   6. testa por qual porta e com qual canal MIDI (o Rx CH da mesa) ela aceita
 *      o que o bridge manda, so com pedidos de leitura, e passa a escrever
 *      por essa rota
 *   7. modo mapa: le da mesa (so com pedidos de leitura) os sends dos 32
 *      canais para os 8 Aux, os masters e os nomes, usando o mapa de
 *      enderecos da 01V96 (src/mapa01v96.js, do kryops/remote-mixer, MIT),
 *      e deixa cada celular escolher o proprio fone sem calibrar nada
 *   8. dispara a atualizacao pedida pelo app (atualizar:agora)
 *
 * Seguranca de audio: o bridge so envia SysEx de controles marcados como
 * "calibrado": true no config.json, ou (modo mapa) de enderecos do mapa que
 * a mesa confirmou respondendo a um pedido de leitura, e so pela rota que o
 * teste da mesa conferiu. Endereco que nao respondeu nunca e escrito. Assim
 * nao tem risco de mandar um endereco chutado e baguncar a mixagem da
 * igreja. Ao criar canais e ao ler a mesa, o que vai para ela e so pedido de
 * leitura (Parameter request), que nao muda o som.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch {
  console.error('Falta instalar as dependencias. Rode: npm install');
  process.exit(1);
}

const configArquivo = require('./config');
const {
  abrirSaida, abrirEntrada, listarPortas, portasCandidatas, midiDisponivel, mensagemErroMidi
} = require('./midi-io');
const mesa = require('./yamaha01v96');
const mapa = require('./mapa01v96');

const DIR_PUBLIC = path.join(configArquivo.RAIZ, 'public');

/**
 * Versao instalada, gravada pelo instalador e pela atualizacao automatica em
 * atualizacao.json (na pasta de dados). Sem o arquivo, tudo vem nulo.
 */
function lerVersao() {
  try {
    const j = configArquivo.lerJson(path.join(configArquivo.DADOS, 'atualizacao.json'));
    const sha = typeof j.atual === 'string' && /^[0-9a-f]{40}$/.test(j.atual) ? j.atual.slice(0, 7) : null;
    return {
      sha,
      instaladaEm: typeof j.instaladaEm === 'string' ? j.instaladaEm.slice(0, 40) : null,
      ultimoResultado: typeof j.ultimoResultado === 'string' ? j.ultimoResultado.slice(0, 120) : null
    };
  } catch {
    return { sha: null, instaladaEm: null, ultimoResultado: null };
  }
}

/**
 * Ultimos avisos, guardados para o botao "copiar diagnostico" do app.
 * Quando algo dá errado no meio do culto, ninguem vai abrir terminal: da para
 * copiar isso pelo celular e mandar para quem for ajudar.
 */
const avisos = [];
for (const nivel of ['warn', 'error']) {
  const original = console[nivel].bind(console);
  console[nivel] = (...args) => {
    const hora = new Date().toTimeString().slice(0, 8);
    avisos.push(hora + ' ' + args.join(' '));
    if (avisos.length > 30) avisos.shift();
    original(...args);
  };
}

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

// Cenas: o app guarda no maximo 100 numeros ja vistos (a mesa tem 00 a 99).
const MAX_CENAS_VISTAS = 100;
const NOME_CENA_MAX = 30;

const estado = { valores: {}, mutes: {} };
const salvo = configArquivo.carregarEstado();

// Ultima cena que a mesa chamou e as que ja apareceram, vindas do estado.json:
// sobrevivem a reinicio do programa.
estado.cena = lerCenaSalva(salvo.cena);

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
// Rota: por qual saida e com qual n (device number) a mesa aceita o que o
// bridge manda. Quem descobre e o teste da mesa (veja "Teste da mesa").
// ---------------------------------------------------------------------------

/** Rota do config.json, conferida campo a campo; null se nao ha ou esta estragada. */
function lerRota(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.saida !== 'string' || !r.saida.trim()) return null;
  if (!Number.isInteger(r.dispositivo) || r.dispositivo < 0 || r.dispositivo > 15) return null;
  return {
    saida: r.saida.slice(0, 200),
    entrada: typeof r.entrada === 'string' && r.entrada.trim() ? r.entrada.slice(0, 200) : null,
    dispositivo: r.dispositivo,
    em: typeof r.em === 'string' ? r.em.slice(0, 40) : null,
    // false = o ultimo teste nao teve resposta: a rota continua valendo (e o
    // melhor caminho conhecido), mas o bridge testa de novo sozinho.
    reconfirmada: r.reconfirmada !== false
  };
}

let rota = lerRota(cfg.midi.rota);

/** A rota foi achada na saida que esta aberta agora? */
function rotaValeParaSaida() {
  return rota !== null && !saidaMidi.simulado && rota.saida === saidaMidi.nome;
}

/**
 * n com que o bridge escreve: o da rota, so quando ela vale para a saida
 * aberta. Em outra porta (trocada pelo app, ou o nome mudou), null: cada
 * molde usa o proprio n ate o teste achar a rota dessa porta.
 */
function dispositivoDaRota() {
  return rotaValeParaSaida() ? rota.dispositivo : null;
}

// ---------------------------------------------------------------------------
// MIDI
// ---------------------------------------------------------------------------

/** Entrada da mesa com SysEx e Program Change (que avisa a troca de cena). */
function abrirEntradaDaMesa(spec = cfg.midi.entrada) {
  return abrirEntrada(spec, aoReceberDaMesa, { programChange: true });
}

/**
 * Saida da mesa. A rota grava o nome exato da porta em midi.saida; se esse
 * nome nao existe mais mas a mesa esta no cabo com outro nome (o Linux
 * renumera as portas), volta para a procura automatica, e a mesa e testada
 * de novo nessa porta.
 */
function abrirSaidaDaMesa() {
  const saida = abrirSaida(cfg.midi.saida);
  if (saida.simulado && rota && cfg.midi.saida === rota.saida) {
    const automatica = abrirSaida(null);
    if (!automatica.simulado) {
      console.warn('[midi] a porta da rota ("' + rota.saida + '") nao apareceu; usando ' + automatica.nome);
      return automatica;
    }
  }
  return saida;
}

// As portas sao procuradas sozinhas quando o config.json nao diz qual usar.
let saidaMidi = abrirSaidaDaMesa();
let entradaMidi = abrirEntradaDaMesa();
// Segunda entrada, so quando o teste da mesa achou a resposta numa porta
// diferente da entrada principal (onde chegam calibracao e cena). No maximo duas.
let entradaResposta = null;
abrirEntradaDaResposta();

function fecharEntradaDaResposta() {
  if (!entradaResposta) return;
  try { entradaResposta.fechar(); } catch { /* ignora */ }
  entradaResposta = null;
}

// Avisa uma vez so quando a entrada das respostas nao abre (procurarMesa
// tenta de novo a cada volta e encheria o diagnostico).
let avisouEntradaResposta = false;

/** A rota diz que a resposta chega por outra entrada que nao a principal, e ela nao esta aberta? */
function faltaEntradaDaResposta() {
  return !!(rota && rota.entrada) && !entradaMidi.simulado && rota.entrada !== entradaMidi.nome &&
    !(entradaResposta && entradaResposta.nome === rota.entrada);
}

/** Abre a entrada em que a mesa responde, se a rota diz que e outra que nao a principal. */
function abrirEntradaDaResposta() {
  const nome = rota && rota.entrada;
  if (entradaResposta && entradaResposta.nome === nome) return;
  fecharEntradaDaResposta();
  if (!nome || entradaMidi.simulado || nome === entradaMidi.nome) return;
  const entrada = abrirEntradaDaMesa(nome);
  if (entrada.simulado) {
    if (!avisouEntradaResposta) {
      console.warn('[midi] nao abri a entrada das respostas ("' + nome + '"): ' + entrada.motivo);
      avisouEntradaResposta = true;
    }
    return;
  }
  avisouEntradaResposta = false;
  entradaResposta = entrada;
  console.log('[midi] entrada das respostas: ' + entrada.nome);
}

/** Fecha e abre de novo as portas da mesa (saida, entrada e a das respostas). */
function reabrirPortas() {
  try { saidaMidi.fechar(); } catch { /* ignora */ }
  try { entradaMidi.fechar(); } catch { /* ignora */ }
  fecharEntradaDaResposta();
  saidaMidi = abrirSaidaDaMesa();
  entradaMidi = abrirEntradaDaMesa();
  abrirEntradaDaResposta();
}

function contarMidi(inicial) {
  if (saidaMidi.simulado) {
    console.warn('[midi] sem mesa na saida: ' + saidaMidi.motivo);
    if (inicial) console.warn('[midi] o app funciona, mas nada chega na mesa ainda.');
  } else {
    console.log('[midi] saida: ' + saidaMidi.nome);
  }

  if (entradaMidi.simulado) {
    console.warn('[midi] sem mesa na entrada: ' + entradaMidi.motivo);
  } else {
    console.log('[midi] entrada: ' + entradaMidi.nome);
  }
  if (entradaResposta) console.log('[midi] entrada das respostas: ' + entradaResposta.nome);
}

contarMidi(true);

/**
 * A maquina costuma ligar antes da mesa, e o PC da mesa fica ligado direto
 * enquanto a mesa e desligada depois do culto. Em vez de exigir reiniciar o
 * programa, ele confere de dez em dez segundos: se a mesa sumiu, larga a porta
 * morta; se a mesa apareceu, conecta. E avisa os celulares nos dois casos.
 * Mesa que conecta sem rota confirmada para a saida e testada (veja
 * pedirDescoberta).
 */
function procurarMesa() {
  const respostaSumiu = entradaResposta !== null && entradaResposta.sumiu();
  if (saidaMidi.sumiu() || entradaMidi.sumiu() || respostaSumiu) {
    // Entradas e saida sao o mesmo cabo: se uma morreu, todas sao reabertas.
    console.warn('[midi] a mesa sumiu (desligada ou cabo solto), procurando de novo');
    interromperGeracao('a mesa sumiu no meio');
    interromperReleitura('a mesa sumiu no meio');
    interromperDescoberta('A mesa saiu do cabo no meio do teste. Nada foi gravado.');
    interromperSincronia('A mesa saiu do cabo no meio da leitura.');
    perderMapa('a mesa saiu do cabo');
    reabrirPortas();
    contarMidi(false);
    transmitirStatus();
    if (!saidaMidi.simulado) {
      reaplicarMix();
      pedirDescoberta('conexao');
      pedirSincronia('conexao');
    }
    return;
  }

  if (!saidaMidi.simulado && !entradaMidi.simulado) {
    // Mesa no ar: a entrada das respostas pode nao ter aberto antes (porta
    // presa ou ainda nao listada). Tenta de novo.
    if (faltaEntradaDaResposta()) abrirEntradaDaResposta();
    // Rota que ficou sem resposta no ultimo teste: tenta de novo, devagar.
    tentarReconfirmarRota();
    return;
  }

  let mudou = false;

  if (saidaMidi.simulado) {
    const nova = abrirSaidaDaMesa();
    if (!nova.simulado) {
      try { saidaMidi.fechar(); } catch { /* ignora */ }
      saidaMidi = nova;
      mudou = true;
    }
  }

  if (entradaMidi.simulado) {
    const nova = abrirEntradaDaMesa();
    if (!nova.simulado) {
      try { entradaMidi.fechar(); } catch { /* ignora */ }
      entradaMidi = nova;
      mudou = true;
    }
  }

  if (!mudou) return;

  abrirEntradaDaResposta();
  console.log('[midi] mesa encontrada');
  contarMidi(false);
  transmitirStatus();
  reaplicarMix();
  // Sem rota conferida nesta saida, testa a mesa (e le depois que achar);
  // com rota, le a mesa ja.
  pedirDescoberta('conexao');
  pedirSincronia('conexao');
}

/** Com a mesa de volta, o mix que esta na tela vale mais que o da mesa. */
function reaplicarMix() {
  if (!cfg.aplicarEstadoAoIniciar) return;
  for (const c of controles) if (mesa.estaCalibrado(c)) agendarEnvio(c.id);
}

setInterval(procurarMesa, cfg.midi.intervaloProcuraMs || 10000).unref();

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
  // Testando a mesa: os valores ficam na fila e saem logo depois, ja com o
  // canal MIDI que a mesa aceita. Durante o teste nao sai Parameter change.
  if (descoberta) return;
  const dispositivo = dispositivoDaRota();
  // Lendo a mesa (leitura do mapa, releitura de cena ou criacao de canais): o
  // que o celular mexeu no mapa espera na fila e sai logo depois, com o
  // ultimo valor. Assim uma resposta de leitura nunca cruza com o envio.
  const segurarMapa = Boolean(sincronia || releitura || geracao);
  // No maximo MAX_QUADROS_POR_CICLO por vez: o resto fica na fila (continua
  // juntando o ultimo valor de cada um) e sai no ciclo seguinte, sem enxurrada.
  let saidos = 0;
  for (const [id, valor] of pendentes) {
    if (saidos >= MAX_QUADROS_POR_CICLO) break;
    // Endereco do mapa (send, On ou master de um fone): mesma fila, mesmo lote.
    if (id.startsWith(PREFIXO_MAPA)) {
      if (segurarMapa) continue; // fica na fila
      pendentes.delete(id);
      if (enviarDoMapa(id.slice(PREFIXO_MAPA.length), valor)) saidos++;
      continue;
    }
    pendentes.delete(id);
    const controle = porId.get(id);
    if (!controle) continue;
    if (!mesa.estaCalibrado(controle)) continue; // protecao: nunca chutar bytes
    try {
      enviarMidi(saidaMidi, mesa.montarFrame(controle, valor, dispositivo));
      ultimoEnvio.set(id, Date.now());
      saidos++;
    } catch (erro) {
      console.error('[midi] falha ao montar quadro de "' + id + '": ' + erro.message);
    }
  }
}

const MAX_QUADROS_POR_CICLO = 32;

setInterval(despacharFila, Math.max(5, cfg.midi.intervaloEnvioMs || 25)).unref();

// Na fila, os enderecos do mapa levam este prefixo (id de controle calibrado
// so tem a-z, 0-9 e "-", entao nunca colide).
const PREFIXO_MAPA = 'mapa:';

/**
 * Manda um valor do mapa para a mesa. Confere tudo de novo na hora de sair:
 * rota conferida, endereco confirmado pela mesa e o valor dentro da escala
 * atual (255 em LOW, 1023 em HIGH). Qualquer duvida: nao manda. Devolve
 * true se o quadro saiu.
 */
function enviarDoMapa(chave, valor) {
  const item = mapa.ESPELHO_POR_CHAVE.get(chave);
  if (!item || !mapa.ehGravavel(item.campo)) return false;
  if (!podeEscreverNoMapa(chave)) {
    console.warn('[mapa] nao mandei ' + chave + ': rota ou endereco sem confirmacao da mesa');
    return false;
  }
  let dados;
  if (mapa.ehFader(item.campo)) {
    const maximo = maximoDaEscala();
    const raw = mapa.rawDoFader(valor, maximo);
    if (raw > maximo) return false; // protecao: nunca acima do maximo da escala atual
    dados = mapa.dadosDoFader(raw);
  } else {
    dados = mapa.dadosDoOn(valor === true);
  }
  try {
    enviarMidi(saidaMidi, mapa.montarMudanca(item.tipo, item.canal, dados, rota.dispositivo));
    ultimoEnvioMapa.set(chave, Date.now());
    return true;
  } catch (erro) {
    console.error('[mapa] falha ao montar quadro de ' + chave + ': ' + erro.message);
    return false;
  }
}

/** Escrever num endereco do mapa: mesa no cabo, rota conferida e endereco que respondeu na leitura. */
function podeEscreverNoMapa(chave) {
  return modoMapa() && !semMesa() && rotaVerificada() && espelho.confirmados.has(chave);
}

// ---------------------------------------------------------------------------
// Caixa preta MIDI: as ultimas mensagens que entraram e sairam, com a porta,
// para o "Copiar diagnostico". So SysEx e Program Change. Fluxo repetido do
// mesmo endereco na mesma porta (fader arrastado, meter) vira uma linha so,
// com a contagem em "vezes", em vez de empurrar o resto para fora.
// ---------------------------------------------------------------------------

const MAX_MIDI = 40;
const JANELA_MIDI_REPETIDO_MS = 1000;
const MAX_BYTES_HEX = 48;
const ultimosMidi = [];

/** direcao: 'entrada' (mesa -> bridge) ou 'saida' (bridge -> mesa). */
function registrarMidi(direcao, porta, bytes) {
  if (!Array.isArray(bytes) || bytes.length < 2) return;
  const ehSysex = bytes[0] === mesa.INICIO_SYSEX;
  const ehPrograma = bytes.length === 2 && bytes[0] >= 0xc0 && bytes[0] <= 0xcf;
  if (!ehSysex && !ehPrograma) return;

  const agora = Date.now();
  // Endereco no formato do manual: tudo ate o byte do canal (F0 43 1n 3E 0D tt ee pp cc).
  const endereco = ehSysex && bytes.length > 10 ? bytes.slice(0, 9) : bytes;
  const chave = direcao + '|' + porta + '|' + mesa.paraHex(endereco);
  const hex = mesa.paraHex(bytes.slice(0, MAX_BYTES_HEX)) + (bytes.length > MAX_BYTES_HEX ? ' ...' : '');

  const repetido = ultimosMidi.find((m) => m.chave === chave && agora - m.quando < JANELA_MIDI_REPETIDO_MS);
  if (repetido) {
    repetido.quando = agora;
    repetido.hex = hex;
    repetido.vezes++;
    return;
  }
  ultimosMidi.push({ chave, quando: agora, dir: direcao, porta: porta || '?', hex, vezes: 1 });
  if (ultimosMidi.length > MAX_MIDI) ultimosMidi.shift();
}

/** Todo envio para a mesa passa por aqui, para ficar na caixa preta. */
function enviarMidi(saida, bytes) {
  registrarMidi('saida', saida.nome, bytes);
  saida.enviar(bytes);
}

/**
 * Chegou mensagem da mesa (SysEx ou Program Change).
 *
 * Troca de cena vem antes de tudo e para ali: nunca vira quadro de
 * calibracao nem valor de controle. Depois, resposta a pedido de leitura
 * (teste da mesa, criacao de canais ou releitura da cena) e so de quem pediu.
 * Se alguem estiver calibrando pelo celular, o quadro vai para essa conversa.
 * Fora isso, se ele bater com o molde de algum controle ja calibrado, o
 * estado e atualizado e os celulares avisados: mexeu no send direto na mesa,
 * o app acompanha em vez de mostrar valor errado.
 *
 * "porta" e o nome da entrada por onde chegou (o bridge pode escutar duas, e
 * todas as candidatas durante o teste da mesa).
 */
function aoReceberDaMesa(bytes, porta) {
  const deOnde = porta || entradaMidi.nome;
  registrarMidi('entrada', deOnde, bytes);

  const cena = cenaDaMensagem(bytes);
  if (cena) {
    tratarCena(cena);
    return;
  }
  if (bytes[0] !== mesa.INICIO_SYSEX) {
    // Program Change sem cena na tabela de fabrica (#101 a #128): fica no
    // diagnostico, para quem for conferir a tabela Pgm Asgn da mesa.
    if (bytes[0] >= 0xc0 && bytes[0] <= 0xcf) {
      console.warn('[cena] Program Change sem cena na tabela de fabrica: ' + mesa.paraHex(bytes));
    }
    return;
  }
  if (mesa.pareceRecallDeCena(bytes)) {
    console.warn('[cena] SCENE RECALL fora do formato esperado: ' + mesa.paraHex(bytes));
    return;
  }

  // Resposta ao pedido de leitura (teste, criacao de canais ou releitura): e
  // so dela. O n do device nao conta: a mesa pode responder com o Rx CH ou
  // com o Tx CH (o manual diz os dois).
  for (const fluxo of [descoberta, geracao, releitura]) {
    const pendente = fluxo && fluxo.pendente;
    if (!pendente) continue;
    const raw = mesa.lerValorDoFrame(pendente.candidato, bytes);
    if (raw !== null) {
      pendente.responder(raw, deOnde);
      return;
    }
  }

  // Resposta a um pedido da leitura da mesa (modo mapa), casada pelo endereco.
  if (sincronia && tomarRespostaDaSincronia(sincronia, bytes)) return;

  // Resposta que chegou depois do tempo de espera: nunca cai na calibracao
  // nem no pedido seguinte. Se for de um controle, vale como o valor dele.
  if (tirarAtrasada(bytes)) {
    acompanharMesa(bytes);
    acompanharMapa(bytes, true);
    return;
  }

  if (sessoes.size) {
    for (const [cliente, sessao] of sessoes) alimentarSessao(cliente, sessao, bytes);
    // Quem calibra mexe de verdade na mesa: o espelho do mapa acompanha.
    acompanharMapa(bytes);
    return;
  }

  acompanharMesa(bytes);
  acompanharMapa(bytes);
}

/** Alguem mexeu num controle calibrado direto na mesa: o app acompanha. */
function acompanharMesa(bytes) {
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
  // Nao calibra enquanto cria canais (veja iniciarGeracao). "etapa" faz o app
  // voltar o assistente para o nome em vez de ficar esperando captura.
  if (geracao) {
    enviarPara(cliente, {
      type: 'learn:erro',
      message: 'Estou criando canais agora. Espere terminar para calibrar.',
      etapa: 'nome'
    });
    return;
  }
  // Nem enquanto rele a mesa depois de uma troca de cena (veja comecarReleitura).
  if (releitura) {
    enviarPara(cliente, {
      type: 'learn:erro',
      message: 'Estou relendo a mesa depois da troca de cena. Espere uns segundos para calibrar.',
      etapa: 'nome'
    });
    return;
  }
  // Nem enquanto testa a mesa: a resposta do teste cairia na calibracao.
  if (descoberta) {
    enviarPara(cliente, {
      type: 'learn:erro',
      message: 'Estou testando a mesa agora (pode levar ate uns 20 segundos). Espere terminar para calibrar.',
      etapa: 'nome'
    });
    return;
  }
  // Nem enquanto le a mesa (modo mapa): as respostas cairiam na calibracao.
  if (sincronia) {
    enviarPara(cliente, {
      type: 'learn:erro',
      message: 'Estou lendo a mesa agora. Espere uns segundos para calibrar.',
      etapa: 'nome'
    });
    return;
  }
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

/** Fecha a calibracao desse celular; se um teste ou uma releitura esperava, roda agora. */
function encerrarSessao(cliente) {
  if (sessoes.delete(cliente)) tentarPendentes();
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

  encerrarSessao(cliente);
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

  // Sem rota confirmada nesta saida (nenhuma ainda, de outra porta, ou sem
  // resposta no ultimo teste): testa a mesa ja, para o fader obedecer (a mesa
  // pode ter Rx CH diferente do Tx CH). Com rota confirmada, nao testa.
  pedirDescoberta('calibracao');
}

function anunciarControles() {
  transmitir({ type: 'controls', controls: listaParaApp() });
  transmitir({ type: 'state', values: estado.valores, mutes: estado.mutes });
}

function statusAtual() {
  return {
    type: 'status',
    devolverMix: cfg.aplicarEstadoAoIniciar === true,
    midi: {
      simulado: saidaMidi.simulado,
      entradaSimulada: entradaMidi.simulado,
      saida: saidaMidi.nome,
      entrada: entradaMidi.nome,
      motivo: saidaMidi.motivo || null
    },
    // A ultima rota que a mesa confirmou (vale para a saida em rota.saida).
    // reconfirmada false: o ultimo teste nao teve resposta, mas ela continua.
    rota: rota
      ? { saida: rota.saida, canalMidi: rota.dispositivo + 1, em: rota.em, reconfirmada: rota.reconfirmada }
      : null
  };
}

function transmitirStatus() {
  transmitir(statusAtual());
  // "pronta" depende da mesa no cabo e da rota conferida, que mudam junto.
  transmitirResumo();
}

// ---------------------------------------------------------------------------
// Criar os outros canais a partir de um canal calibrado
// ---------------------------------------------------------------------------

/**
 * Pelo formato do manual, o send do canal 5 tem o mesmo molde do canal 1, so
 * com outro byte de canal. Mas o programa nao confia nisso as cegas: para cada
 * canal ele manda um Parameter request (pedido de leitura, que nao mexe no
 * som) e so cria o controle se a mesa responder naquele endereco. O valor que
 * ela responde vira o valor inicial do fader. Uma geracao por vez, um pedido
 * por vez.
 */
let geracao = null;

function esperaResposta() {
  const ms = Number(cfg.midi.esperaRespostaMs);
  return Number.isFinite(ms) && ms > 0 ? Math.min(5000, Math.max(20, ms)) : 300;
}

/** A mesa em que a geracao comecou saiu do ar (porta trocada, simulada ou morta)? */
function mesaSaiuDoAr(g) {
  return (
    saidaMidi !== g.saida ||
    entradaMidi !== g.entrada ||
    saidaMidi.simulado ||
    entradaMidi.simulado ||
    saidaMidi.sumiu() ||
    entradaMidi.sumiu() ||
    (entradaResposta !== null && entradaResposta.sumiu())
  );
}

function interromperGeracao(motivo) {
  if (!geracao || geracao.interrompido) return;
  geracao.interrompido = true;
  console.warn('[gerar] interrompido: ' + motivo);
  if (geracao.pendente) geracao.pendente.responder(null);
}

/** Algum controle da lista ja aponta para o endereco desse candidato? */
function enderecoJaExiste(lista, candidato) {
  const canal = mesa.canalDoControle(candidato);
  return lista.some(
    (c) =>
      mesa.mesmoEndereco(c, candidato) ||
      // Calibrado a mao com a janela do valor um pouco diferente: pelo manual,
      // mesmo cabecalho (F0 43 1n 3E 0D tt ee pp) e mesmo canal e o mesmo parametro.
      (canal !== null &&
        mesa.canalDoControle(c) === canal &&
        mesa.mesmoCabecalho(c.template, candidato.template))
  );
}

/**
 * Espera a mesa responder o pedido. Registrada antes do envio: a resposta pode
 * ser rapida. Serve o teste da mesa, a criacao de canais e a releitura de
 * cena (g e o fluxo); a entrada por onde a resposta chegou fica em
 * g.portaDaResposta. Sem resposta a tempo (ou interrompido), o pedido ja
 * saiu: se a mesa responder depois, a resposta fica de quarentena (veja
 * lembrarAtrasada).
 */
function esperarResposta(g, candidato, ms = esperaResposta()) {
  return new Promise((ok) => {
    const timer = setTimeout(() => terminar(null), ms);
    function terminar(raw, porta) {
      clearTimeout(timer);
      if (g.pendente === pendente) g.pendente = null;
      if (raw === null) lembrarAtrasada(candidato);
      else g.portaDaResposta = porta || null;
      ok(raw);
    }
    const pendente = { candidato, responder: terminar };
    g.pendente = pendente;
  });
}

function recusarGeracao(cliente, message) {
  enviarPara(cliente, { type: 'gerar:erro', message });
}

/**
 * jaTestou: a geracao que disparou o teste da mesa volta aqui depois que ele
 * achou a rota, e nao testa de novo.
 */
function iniciarGeracao(cliente, msg, jaTestou = false) {
  if (geracao) {
    return recusarGeracao(cliente, 'Ja estou criando canais agora. Espere terminar e tente de novo.');
  }
  // O teste da mesa usa a mesma entrada para as respostas: uma coisa por vez.
  if (descoberta) {
    return recusarGeracao(cliente, 'Estou testando a mesa agora (pode levar ate uns 20 segundos). Espere terminar e tente de novo.');
  }
  // Releitura da cena usa a mesma entrada para as respostas: uma coisa por vez.
  if (releitura) {
    return recusarGeracao(cliente, 'Estou relendo a mesa depois da troca de cena. Espere uns segundos e tente de novo.');
  }
  // A leitura da mesa (modo mapa) tambem.
  if (sincronia) {
    return recusarGeracao(cliente, 'Estou lendo a mesa agora. Espere uns segundos e tente de novo.');
  }
  // Calibrar e criar canais nunca rodam juntos: uma resposta atrasada da mesa
  // cairia na calibracao e o controle ficaria com o endereco de outro canal.
  if (sessoes.size) {
    return recusarGeracao(cliente, 'Alguem esta calibrando um controle agora. Espere terminar e tente de novo.');
  }

  const original = porId.get(msg.base);
  if (!original) {
    return recusarGeracao(cliente, 'Nao achei esse controle. Atualize a tela e escolha de novo.');
  }
  if (!mesa.estaCalibrado(original)) {
    return recusarGeracao(cliente, 'Calibre este canal antes: ele e o modelo para os outros.');
  }
  if ((original.tipo || 'canal') !== 'canal') {
    return recusarGeracao(cliente, 'So da para criar canais a partir de um canal, nao de reverb nem do volume geral.');
  }
  const canalBase = mesa.canalDoControle(original);
  if (canalBase === null) {
    return recusarGeracao(cliente, 'Este controle nao esta no formato do manual da 01V96, calibre os canais um a um.');
  }
  if (saidaMidi.simulado || entradaMidi.simulado) {
    return recusarGeracao(cliente, 'Ligue a mesa no cabo USB: preciso que ela responda para conferir cada canal.');
  }

  const pedidos = msg.canais;
  if (
    !Array.isArray(pedidos) ||
    pedidos.length > mesa.TOTAL_CANAIS ||
    pedidos.some((n) => !Number.isInteger(n) || n < 1 || n > mesa.TOTAL_CANAIS)
  ) {
    return recusarGeracao(cliente, 'Escolha canais de 1 a ' + mesa.TOTAL_CANAIS + '.');
  }
  const canais = [...new Set(pedidos)].sort((a, b) => a - b);
  if (!canais.length) return recusarGeracao(cliente, 'Marque pelo menos um canal.');

  // Sem rota confirmada nesta saida, a mesa pode ignorar todos os pedidos
  // (Rx CH diferente do Tx CH, ou outra porta): testa antes e so cria depois
  // de achar. Durante o teste, outro pedido de criar canais e recusado.
  if (!jaTestou && !rotaVerificada()) {
    console.log('[gerar] sem rota confirmada em "' + saidaMidi.nome + '": testo a mesa antes de criar');
    iniciarDescoberta('gerar', (achou, motivo) => {
      if (achou) iniciarGeracao(cliente, msg, true);
      else recusarGeracao(cliente, 'A mesa nao respondeu ao teste, entao nao criei nenhum canal. ' + motivo);
    });
    return;
  }

  const base = { ...original, template: original.template.slice() };
  const jaExistiam = [];
  const fila = [];
  for (const canal of canais) {
    if (canal === canalBase || enderecoJaExiste(controles, mesa.controleParaCanal(base, canal))) {
      jaExistiam.push(canal);
    } else {
      fila.push(canal);
    }
  }

  const g = {
    cliente,
    base,
    fila,
    jaExistiam,
    confirmados: [],
    semResposta: [],
    feitos: 0,
    interrompido: false,
    concluida: false,
    pendente: null,
    saida: saidaMidi,
    entrada: entradaMidi
  };
  geracao = g;
  console.log('[gerar] a partir de "' + (base.rotulo || base.id) + '" (canal ' + canalBase + '): ' +
    fila.length + ' canal(is) para conferir com a mesa, ' + jaExistiam.length + ' ja existiam');

  rodarGeracao(g).catch((erro) => {
    // Erro no meio: salva o que a mesa ja confirmou, como numa interrupcao.
    console.error('[gerar] erro inesperado: ' + erro.message);
    g.interrompido = true;
    if (g.pendente) g.pendente.responder(null);
    try {
      if (g.concluida) throw erro; // o erro foi no proprio fim: nao grava duas vezes
      concluirGeracao(g);
    } catch (erroNoFim) {
      console.error('[gerar] nao consegui terminar: ' + erroNoFim.message);
      enviarPara(g.cliente, { type: 'gerar:erro', message: 'Algo deu errado ao criar os canais: ' + erroNoFim.message });
    }
  }).finally(() => {
    if (geracao === g) geracao = null;
    // Trocaram de cena (ou a mesa reconectou) enquanto os canais eram criados: roda agora.
    tentarPendentes();
  });
}

async function rodarGeracao(g) {
  for (const canal of g.fila) {
    if (g.interrompido) break;
    if (mesaSaiuDoAr(g)) {
      interromperGeracao('a mesa saiu do ar');
      break;
    }

    const candidato = mesa.controleParaCanal(g.base, canal);
    const resposta = esperarResposta(g, candidato);
    // Protecao: daqui so sai pedido de leitura (byte 2 = 3n), nunca Parameter change.
    enviarMidi(g.saida, mesa.montarPedido(g.base, canal, dispositivoDaRota()));
    const raw = await resposta;

    if (g.interrompido) break;
    if (raw === null && mesaSaiuDoAr(g)) {
      interromperGeracao('a mesa saiu do ar');
      break;
    }

    if (raw === null) g.semResposta.push(canal);
    else g.confirmados.push({ canal, candidato, raw });
    g.feitos++;

    enviarPara(g.cliente, {
      type: 'gerar:progresso',
      canal,
      feitos: g.feitos,
      total: g.fila.length,
      confirmado: raw !== null
    });
  }

  concluirGeracao(g);
}

/** Grava o que a mesa confirmou, mesmo se parou no meio. */
function concluirGeracao(g) {
  g.concluida = true;
  geracao = null;

  const novos = [];
  const jaNaLista = [];
  if (g.confirmados.length) {
    try {
      gravarControles((lista) => {
        for (const { canal, candidato, raw } of g.confirmados) {
          // Alguem pode ter calibrado esse canal enquanto a mesa respondia.
          if (enderecoJaExiste(lista, candidato)) {
            jaNaLista.push(canal);
            continue;
          }
          const rotulo = 'Canal ' + canal;
          const controle = {
            id: configArquivo.idUnico(rotulo, lista),
            rotulo,
            tipo: 'canal',
            valorInicial: typeof g.base.valorInicial === 'number' ? g.base.valorInicial : 0.5,
            ...candidato,
            geradoDe: g.base.id
          };
          lista.push(controle);
          novos.push({ controle, canal, raw });
        }
        return lista;
      });
    } catch (erro) {
      console.error('[gerar] nao consegui salvar: ' + erro.message);
      enviarPara(g.cliente, { type: 'gerar:erro', message: 'Nao consegui salvar os canais: ' + erro.message });
      return;
    }
  }

  // O app so espelha a mesa: o valor que ela respondeu vira o do fader, e
  // nada e mandado de volta para ela.
  const criados = [];
  for (const { controle, canal, raw } of novos) {
    estado.valores[controle.id] = mesa.escalarParaNormalizado(raw, controle.rawMin, controle.rawMax);
    estado.mutes[controle.id] = false;
    criados.push({ id: controle.id, label: controle.rotulo, canal });
  }
  if (criados.length) agendarSalvamento();

  const jaExistiam = g.jaExistiam.concat(jaNaLista).sort((a, b) => a - b);
  console.log('[gerar] ' + criados.length + ' criado(s), ' + g.semResposta.length + ' sem resposta, ' +
    jaExistiam.length + ' ja existiam' + (g.interrompido ? ', interrompido' : ''));
  if (!g.confirmados.length && g.semResposta.length) {
    console.warn('[gerar] a mesa nao respondeu nenhum pedido: toque em "Testar a mesa" no app e confira PARAMETER CHANGE Rx ON em MIDI | Setup');
  }

  enviarPara(g.cliente, {
    type: 'gerar:fim',
    criados,
    semResposta: g.semResposta.slice(),
    jaExistiam,
    interrompido: g.interrompido
  });
  anunciarControles();
}

// ---------------------------------------------------------------------------
// Respostas atrasadas
// ---------------------------------------------------------------------------

/**
 * Pedido sem resposta a tempo ja saiu para a mesa, e ela ainda pode responder
 * depois. Essa resposta nao pode cair no pedido seguinte nem numa calibracao
 * aberta logo em seguida (os tres fluxos leem a mesma entrada). Ela fica
 * reconhecida aqui por um tempo e, se for de um controle, vale so como o
 * valor atual dele.
 */
const atrasadas = [];

function prazoDaQuarentena() {
  return Date.now() + Math.max(2000, 4 * esperaResposta());
}

function lembrarAtrasada(candidato) {
  atrasadas.push({ candidato, ate: prazoDaQuarentena() });
  if (atrasadas.length > 64) atrasadas.shift();
}

// Enderecos do mapa que ficaram sem resposta na leitura: podem ser ate mais
// de mil, entao ficam num mapa proprio (chave -> { ate, vezes }), sem limite
// de 64. "vezes" e quantos pedidos sairam (com a segunda tentativa, ate 2
// respostas atrasadas do mesmo endereco).
const atrasadasDoMapa = new Map();

function lembrarAtrasadaDoMapa(chave, vezes = 1) {
  atrasadasDoMapa.set(chave, { ate: prazoDaQuarentena(), vezes: Math.max(1, vezes) });
}

/** true se o quadro e resposta atrasada de algum pedido (e tira da lista). */
function tirarAtrasada(bytes) {
  const agora = Date.now();
  for (let i = atrasadas.length - 1; i >= 0; i--) {
    if (atrasadas[i].ate < agora) atrasadas.splice(i, 1);
  }
  if (atrasadasDoMapa.size) {
    const id = mapa.identificar(bytes);
    const chave = id && !id.pedido ? mapa.chave(id.tipo, id.canal) : null;
    const espera = chave !== null ? atrasadasDoMapa.get(chave) : undefined;
    if (espera !== undefined && espera.ate >= agora) {
      if (--espera.vezes <= 0) atrasadasDoMapa.delete(chave);
      console.log('[midi] resposta atrasada da mesa: ' + mesa.paraHex(bytes));
      return true;
    }
    for (const [c, e] of atrasadasDoMapa) if (e.ate < agora) atrasadasDoMapa.delete(c);
  }
  const i = atrasadas.findIndex((a) => mesa.lerValorDoFrame(a.candidato, bytes) !== null);
  if (i < 0) return false;
  atrasadas.splice(i, 1);
  console.log('[midi] resposta atrasada da mesa: ' + mesa.paraHex(bytes));
  return true;
}

// ---------------------------------------------------------------------------
// Cena da mesa
// ---------------------------------------------------------------------------

/**
 * A equipe de som chama cenas na mesa, e a cena tambem muda os sends dos fones
 * (a nao ser com Recall Safe nos AUX). O app mostra qual cena entrou, com o
 * nome dado pelo app, e logo depois rele da mesa os controles calibrados, so
 * com pedidos de leitura (Parameter request), para os faders da tela ficarem
 * iguais aos da mesa. A releitura nunca manda Parameter change.
 */

// O mesmo recall pode chegar duas vezes (Program Change e SysEx de funcao).
const JANELA_CENA_REPETIDA_MS = 1000;

let ultimaCenaRecebida = null; // { numero, quando }
let releitura = null; // a releitura rodando agora
let timerReleitura = null; // espera a mesa assentar depois da ultima troca
let releituraPendente = null; // numero da cena esperando calibracao/criacao acabar

function ehNumeroDeCena(n) {
  return Number.isInteger(n) && n >= 0 && n < mesa.TOTAL_CENAS;
}

function ordenarVistas(lista) {
  return [...new Set(lista)].sort((a, b) => a - b).slice(0, MAX_CENAS_VISTAS);
}

/** Cena salva no estado.json, conferida campo a campo (o arquivo pode estar velho ou estragado). */
function lerCenaSalva(salva) {
  const cena = { atual: null, vistas: [] };
  if (!salva || typeof salva !== 'object') return cena;
  const a = salva.atual;
  if (a && typeof a === 'object' && ehNumeroDeCena(a.numero)) {
    cena.atual = {
      numero: a.numero,
      em: typeof a.em === 'string' ? a.em.slice(0, 40) : null,
      origem: a.origem === 'programa' || a.origem === 'funcao' ? a.origem : null,
      bruto: typeof a.bruto === 'string' ? a.bruto.slice(0, 120) : null
    };
  }
  if (Array.isArray(salva.vistas)) cena.vistas = ordenarVistas(salva.vistas.filter(ehNumeroDeCena));
  return cena;
}

/** Tira caracteres de controle, espacos das pontas e corta em 30 letras. */
function limparNomeDeCena(nome) {
  const texto = String(nome).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return Array.from(texto).slice(0, NOME_CENA_MAX).join('').trim();
}

/** Nomes das cenas do config.json ({ "3": "Pedro" }), so os validos. */
function nomesDasCenas(origem = cfg.cenas) {
  const nomes = {};
  if (!origem || typeof origem !== 'object' || Array.isArray(origem)) return nomes;
  for (const [chave, nome] of Object.entries(origem)) {
    if (!/^\d{1,2}$/.test(chave) || typeof nome !== 'string') continue;
    const limpo = limparNomeDeCena(nome);
    if (limpo) nomes[String(Number(chave))] = limpo;
  }
  return nomes;
}

function mensagemCena() {
  const nomes = nomesDasCenas();
  const a = estado.cena.atual;
  return {
    type: 'cena',
    atual: a
      ? { numero: a.numero, nome: nomes[a.numero] || null, em: a.em, origem: a.origem, bruto: a.bruto }
      : null,
    nomes,
    vistas: estado.cena.vistas.slice()
  };
}

/** { numero, origem, bruto } se a mensagem da mesa e troca de cena, senao null. */
function cenaDaMensagem(bytes) {
  const pc = mesa.cenaDoProgramChange(bytes);
  if (pc) return { numero: pc.numero, origem: 'programa', bruto: pc.bruto };
  const numero = mesa.cenaDoSysex(bytes);
  if (numero !== null) return { numero, origem: 'funcao', bruto: mesa.paraHex(bytes) };
  return null;
}

function tratarCena({ numero, origem, bruto }) {
  const agora = Date.now();
  const ultima = ultimaCenaRecebida;
  if (ultima && ultima.numero === numero && agora - ultima.quando < JANELA_CENA_REPETIDA_MS) {
    console.log('[cena] ' + numero + ' de novo (' + origem + ': ' + bruto + '): mesma troca, contei uma vez');
    // A releitura ainda nao comecou: conta a espera a partir desta mensagem.
    if (timerReleitura) armarReleitura(numero);
    return;
  }
  ultimaCenaRecebida = { numero, quando: agora };

  estado.cena.atual = { numero, em: new Date(agora).toISOString(), origem, bruto };
  estado.cena.vistas = ordenarVistas([...estado.cena.vistas, numero]);
  console.log('[cena] entrou a cena ' + numero + ' (' + origem + ': ' + bruto + ')');

  transmitir(mensagemCena());
  agendarSalvamento();
  agendarReleitura(numero);
}

function semMesa() {
  return saidaMidi.simulado || entradaMidi.simulado;
}

function esperaCena() {
  const ms = Number(cfg.midi.esperaCenaMs);
  return Number.isFinite(ms) && ms >= 0 ? Math.min(10000, ms) : 400;
}

function agendarReleitura(numero) {
  if (semMesa()) {
    console.log('[cena] sem mesa no cabo: so registrei a cena, nada para reler');
    return;
  }
  // Troca nova no meio da releitura (ou da leitura do mapa): o que ela leu ja
  // nao e a cena atual.
  interromperReleitura('a mesa trocou de cena de novo');
  interromperSincronia(null);
  armarReleitura(numero);
}

/** A mesa leva um instante para assentar a cena: rele um pouco depois da ultima troca. */
function armarReleitura(numero) {
  clearTimeout(timerReleitura);
  timerReleitura = setTimeout(() => {
    timerReleitura = null;
    lerDepoisDaCena(numero);
  }, esperaCena());
  timerReleitura.unref();
}

/**
 * Modo mapa com rota conferida: a leitura da mesa inteira (que tambem rele
 * os controles calibrados) substitui a releitura. Sem isso, a releitura de
 * sempre, so dos calibrados.
 */
function lerDepoisDaCena(numero) {
  if (modoMapa() && rotaVerificada()) {
    releituraPendente = null;
    pedirSincronia('cena', numero);
    return;
  }
  comecarReleitura(numero);
}

function interromperReleitura(motivo) {
  if (!releitura || releitura.cancelada) return;
  releitura.cancelada = true;
  console.log('[cena] releitura interrompida: ' + motivo);
  if (releitura.pendente) releitura.pendente.responder(null);
}

/** Calibracao, criacao de canais ou teste acabou: se alguma cena esperava releitura, vai agora. */
function tentarReleituraPendente() {
  if (releituraPendente === null || timerReleitura) return;
  if (geracao || sessoes.size || releitura || descoberta || sincronia) return;
  lerDepoisDaCena(releituraPendente);
}

function comecarReleitura(numero) {
  releituraPendente = null;
  if (semMesa()) {
    console.log('[cena] a mesa saiu do cabo antes de reler a cena ' + numero);
    return;
  }
  // Releitura, teste da mesa, criacao de canais, leitura do mapa e
  // calibracao nunca rodam juntos: todos leem as mesmas entradas, e uma
  // resposta atrasada cairia no fluxo errado.
  if (geracao || sessoes.size || releitura || descoberta || sincronia) {
    releituraPendente = numero;
    const quem = descoberta ? 'o teste da mesa' : geracao ? 'a criacao de canais'
      : sessoes.size ? 'a calibracao' : sincronia ? 'a leitura da mesa' : 'a releitura anterior';
    console.log('[cena] a releitura da cena ' + numero + ' espera ' + quem + ' terminar');
    return;
  }

  const fila = [];
  const dispositivo = dispositivoDaRota();
  for (const c of controles) {
    const pedido = mesa.montarPedidoDoControle(c, dispositivo);
    if (pedido) fila.push({ id: c.id, controle: { ...c, template: c.template.slice() }, pedido });
  }
  if (!fila.length) {
    console.log('[cena] nenhum controle no formato do manual para reler');
    return;
  }

  const r = {
    numero,
    fila,
    lidos: [],
    semResposta: [],
    cancelada: false,
    pendente: null,
    saida: saidaMidi,
    entrada: entradaMidi
  };
  releitura = r;
  rodarReleitura(r)
    .catch((erro) => console.error('[cena] erro na releitura: ' + erro.message))
    .finally(() => {
      if (releitura === r) releitura = null;
      tentarPendentes();
    });
}

/** Um pedido por vez; cada resposta casada com o molde do proprio controle. */
async function rodarReleitura(r) {
  console.log('[cena] relendo ' + r.fila.length + ' controle(s) da mesa (cena ' + r.numero + ')');

  for (const item of r.fila) {
    if (r.cancelada) break;
    if (mesaSaiuDoAr(r)) {
      interromperReleitura('a mesa saiu do ar');
      break;
    }
    // Removido ou recalibrado enquanto relia: ja nao e o mesmo endereco.
    if (!mesa.mesmoEndereco(porId.get(item.id), item.controle)) continue;

    const pedidoEm = Date.now();
    const resposta = esperarResposta(r, item.controle);
    // Protecao: daqui so sai pedido de leitura (byte 2 = 3n), nunca Parameter change.
    enviarMidi(r.saida, item.pedido);
    const raw = await resposta;

    if (raw === null) {
      if (!r.cancelada) r.semResposta.push(item.id);
      continue;
    }
    r.lidos.push(item.id);
    aplicarReleitura(item.id, raw, pedidoEm);
  }

  // Os valores vao pelo "state" de sempre, antes do aviso de fim.
  const values = {};
  const mutes = {};
  for (const id of r.lidos) {
    if (!porId.has(id)) continue;
    values[id] = estado.valores[id];
    mutes[id] = estado.mutes[id];
  }
  if (Object.keys(values).length) {
    transmitir({ type: 'state', values, mutes });
    agendarSalvamento();
  }

  console.log('[cena] releitura da cena ' + r.numero + ': ' + r.lidos.length + ' lido(s), ' +
    r.semResposta.length + ' sem resposta' + (r.cancelada ? ', interrompida' : ''));
  if (r.cancelada) return; // a releitura da cena nova manda o aviso dela

  transmitir({
    type: 'cena:relida',
    numero: r.numero,
    lidos: r.lidos.slice(),
    semResposta: r.semResposta.slice()
  });
}

/**
 * O valor lido vira o do fader, e o mudo sai se a mesa tem som ali (como
 * quando alguem mexe direto na mesa). Nada e mandado de volta para ela.
 */
function aplicarReleitura(id, raw, pedidoEm) {
  const controle = porId.get(id);
  if (!controle) return;
  // O celular mexeu nesse controle depois do pedido: o valor dele ja esta indo
  // (ou foi) para a mesa e vale mais que a leitura.
  if (pendentes.has(id) || (ultimoEnvio.get(id) || 0) >= pedidoEm) return;

  const valor = mesa.escalarParaNormalizado(raw, controle.rawMin, controle.rawMax);
  estado.valores[id] = valor;
  if (valor > 0) estado.mutes[id] = false;
}

/** Nome dado pelo app a uma cena (vazio apaga). Fica no config.json. */
function nomearCena(cliente, msg) {
  if (!ehNumeroDeCena(msg.numero)) {
    enviarPara(cliente, { type: 'controle:erro', message: 'Cena invalida: o numero vai de 0 a 99.' });
    return;
  }
  if (msg.nome !== undefined && msg.nome !== null && typeof msg.nome !== 'string') {
    enviarPara(cliente, { type: 'controle:erro', message: 'O nome da cena precisa ser um texto.' });
    return;
  }
  const numero = msg.numero;
  const nome = limparNomeDeCena(msg.nome || '');

  try {
    const atual = configArquivo.carregar();
    const nomes = nomesDasCenas(atual.cenas);
    if (nome) nomes[numero] = nome;
    else delete nomes[numero];
    atual.cenas = nomes;
    configArquivo.salvar(atual);
    cfg.cenas = nomes;
  } catch (erro) {
    enviarPara(cliente, { type: 'controle:erro', message: 'Nao consegui salvar: ' + erro.message });
    return;
  }

  console.log('[cena] nome da cena ' + numero + (nome ? ' salvo' : ' apagado'));
  transmitir(mensagemCena());
}

// ---------------------------------------------------------------------------
// Teste da mesa (descoberta da rota)
// ---------------------------------------------------------------------------

/**
 * A 01V96 so aceita Parameter change e Parameter request quando o n (device
 * number) bate com o Rx CH dela e quando chegam pela porta do GENERAL Rx PORT
 * (01V96 V2, p.215-218 e p.313). O molde calibrado traz o Tx CH, que e outro
 * ajuste e pode ser diferente. Entao o bridge testa: manda um Parameter
 * request (pedido de leitura, nunca muda o som) do endereco de um controle
 * calibrado por cada saida candidata, com cada n, um por vez, e espera a mesa
 * responder em qualquer entrada candidata. O par que responde, responde de
 * novo na confirmacao e fica calado com outro n (contra-prova) vira a rota.
 * Daqui nunca sai Parameter change.
 *
 * Teste sem resposta nao apaga uma rota ja confirmada: ela continua valendo
 * (e o melhor caminho conhecido), marcada como nao reconfirmada, e o bridge
 * testa de novo sozinho (veja tentarReconfirmarRota).
 *
 * Exclusivo com calibracao, criacao de canais e releitura de cena (todos leem
 * as mesmas entradas), com a mesma quarentena de resposta atrasada.
 */
let descoberta = null;
let descobertaPendente = null; // origem do teste que espera a vez
let fimDoUltimoTeste = 0; // para a nova tentativa sozinha nao passar de 1 por minuto

// Texto puro (sem HTML): o app destaca as palavras em maiusculas, Rx/Tx e o
// que esta entre aspas.
const CONFERIR_NA_MESA = [
  'MIDI | SETUP: PARAMETER CHANGE com Rx ON.',
  'MIDI | SETUP, linha CHANNEL: anote os canais Tx e Rx (o app testa o Rx sozinho, de 1 a 16).',
  'DIO/SETUP | MIDI/HOST: GENERAL Rx PORT e Tx PORT em USB (a mesma USB do cabo).',
  'Feche o "AirFader" (ou o "Studio Manager") neste PC: aberto, ele pode prender a porta da mesa.'
];

function esperaTeste() {
  const ms = Number(cfg.midi.esperaTesteMs);
  return Number.isFinite(ms) && ms > 0 ? Math.min(2000, Math.max(20, ms)) : 150;
}

/**
 * Molde do teste: o primeiro controle que da para pedir no formato do
 * manual. Sem nenhum (modo mapa), o send do canal 1 para o Aux 1, pelo mapa:
 * o teste da mesa funciona sem calibrar nada.
 */
function acharMolde() {
  const c = controles.find((x) => mesa.montarPedidoDoControle(x) !== null);
  if (c) return { ...c, template: c.template.slice() };
  return modoMapa() ? mapa.moldeDoTipo(mapa.TESTE_DE_ROTA.tipo, mapa.TESTE_DE_ROTA.canal) : null;
}

/** A rota vale para a saida aberta e respondeu no ultimo teste? Senao, falta testar. */
function rotaVerificada() {
  return rotaValeParaSaida() && rota.reconfirmada;
}

/** Intervalo minimo entre as novas tentativas sozinhas (padrao 1 minuto). */
function intervaloReconfirmar() {
  const ms = Number(cfg.midi.retestarRotaMs);
  return Number.isFinite(ms) && ms > 0 ? Math.max(1000, ms) : 60000;
}

/**
 * Rota que ficou sem resposta no ultimo teste: com a mesa no ar e nada mais
 * rodando, testa de novo, no maximo uma vez por intervalo. So leitura.
 * Chamada a cada volta do procurarMesa.
 */
function tentarReconfirmarRota() {
  if (!rota || rota.reconfirmada || !rotaValeParaSaida()) return;
  if (descoberta || geracao || releitura || sincronia || sessoes.size || timerReleitura) return;
  if (Date.now() - fimDoUltimoTeste < intervaloReconfirmar()) return;
  pedirDescoberta('reconfirmar');
}

/** A rota como vai para o app: sem o n cru, com o canal MIDI. */
function rotaParaApp(r) {
  return r ? { saida: r.saida, entrada: r.entrada, canalMidi: r.dispositivo + 1, reconfirmada: r.reconfirmada } : null;
}

/** Ordem dos n: o da rota (se houver), o do molde, e depois 0 a 15. */
function ordemDosDispositivos(molde) {
  const ordem = [];
  if (rota) ordem.push(rota.dispositivo);
  ordem.push(mesa.dispositivoDoControle(molde));
  for (let n = 0; n <= 15; n++) ordem.push(n);
  return [...new Set(ordem.filter(Number.isInteger))];
}

/** Saida atual primeiro, depois as outras com cara de mesa. */
function ordemDasSaidas(nomes) {
  const ordem = saidaMidi.simulado ? [] : [saidaMidi.nome];
  for (const nome of portasCandidatas(nomes)) if (!ordem.includes(nome)) ordem.push(nome);
  return ordem;
}

function mensagemTeste(fase, d, extra = {}) {
  return {
    type: 'mesa:teste',
    fase,
    rota: null,
    testados: d ? d.testados : 0,
    motivo: null,
    conferir: [],
    ...extra
  };
}

/**
 * Teste automatico (mesa conectou, primeira calibracao): so quando falta rota
 * confirmada para a saida atual e ja existe molde. Se outra coisa exclusiva
 * estiver rodando, espera a vez (tentarPendentes).
 */
function pedirDescoberta(origem) {
  if (semMesa() || rotaVerificada() || !acharMolde()) return;
  if (descoberta || geracao || releitura || sincronia || sessoes.size) {
    descobertaPendente = origem;
    return;
  }
  iniciarDescoberta(origem);
}

/**
 * Algo exclusivo terminou: roda o que esperava a vez, primeiro o teste da
 * mesa, depois a releitura da cena e por fim a leitura do mapa.
 */
function tentarPendentes() {
  if (descobertaPendente !== null && !descoberta && !geracao && !releitura && !sincronia && !sessoes.size) {
    const origem = descobertaPendente;
    descobertaPendente = null;
    pedirDescoberta(origem);
  }
  tentarReleituraPendente();
  tentarSincroniaPendente();
}

/** Botao "Testar a mesa" do app. */
function testarMesaPeloApp(cliente) {
  let motivo = null;
  if (semMesa()) motivo = 'Ligue a mesa no cabo USB: o teste precisa que ela responda.';
  else if (!acharMolde()) motivo = 'Calibre um controle primeiro (o send de um canal, por exemplo): o teste usa o endereco dele.';
  else if (descoberta) motivo = 'Ja estou testando a mesa (leva ate uns 20 segundos); espere terminar.';
  else if (geracao) motivo = 'Estou criando canais agora; teste de novo quando terminar.';
  else if (releitura) motivo = 'Estou relendo a mesa depois da troca de cena; teste de novo em alguns segundos.';
  else if (sincronia) motivo = 'Estou lendo a mesa agora; teste de novo em alguns segundos.';
  else if (sessoes.size) motivo = 'Alguem esta calibrando um controle agora; teste de novo quando terminar.';
  if (motivo) {
    enviarPara(cliente, { type: 'controle:erro', message: motivo });
    return;
  }
  iniciarDescoberta('app');
}

/**
 * depois(achou, motivo) roda no fim, ja sem a trava (a criacao de canais usa).
 * origem 'reconfirmar' (a nova tentativa sozinha) e rapida: so pergunta pelo
 * caminho guardado (a porta e o n da rota), sem varrer as outras.
 */
function iniciarDescoberta(origem, depois = null) {
  descobertaPendente = null;
  const d = {
    origem,
    rapido: origem === 'reconfirmar' && rotaValeParaSaida(),
    molde: acharMolde(),
    depois,
    cancelada: false,
    motivoCancelamento: null,
    pendente: null,
    portaDaResposta: null,
    testados: 0,
    soltas: 0,
    achado: null,
    saida: saidaMidi,
    entrada: entradaMidi,
    temporarias: { entradas: [], saidas: [] }
  };
  descoberta = d;
  console.log('[mesa] teste da mesa comecou (' + origem + ')');
  transmitir(mensagemTeste('testando', d));

  let resultado = { achou: false, motivo: 'O teste da mesa parou no meio.' };
  rodarDescoberta(d)
    .catch((erro) => {
      console.error('[mesa] erro no teste da mesa: ' + erro.message);
      d.cancelada = true;
      d.motivoCancelamento = 'Algo deu errado no teste da mesa: ' + erro.message;
    })
    .then(() => {
      resultado = concluirDescoberta(d);
    })
    .catch((erro) => console.error('[mesa] nao consegui terminar o teste: ' + erro.message))
    .finally(() => {
      fecharTemporarias(d);
      if (descoberta === d) descoberta = null;
      fimDoUltimoTeste = Date.now();
      if (d.depois) {
        try {
          d.depois(resultado.achou, resultado.motivo);
        } catch (erro) {
          console.error('[mesa] erro depois do teste: ' + erro.message);
        }
      }
      // Rota conferida: le a mesa (modo mapa). Se algo pegou a vez (a
      // criacao de canais que pediu o teste), a leitura espera ela acabar.
      if (resultado.achou) pedirSincronia('rota');
      tentarPendentes();
    });
}

/** A mesa em que o teste comecou saiu do ar (porta trocada, simulada ou morta)? */
function descobertaSaiuDoAr(d) {
  return saidaMidi !== d.saida || entradaMidi !== d.entrada || semMesa() ||
    saidaMidi.sumiu() || entradaMidi.sumiu();
}

async function rodarDescoberta(d) {
  if (!d.molde) return;
  const portas = d.rapido ? { entradas: [], saidas: [] } : listarPortas();

  // Todas as entradas com cara de mesa ficam ouvindo durante o teste: a porta
  // em que a resposta sai nao e documentada. As que ja estao abertas ficam.
  // (Na nova tentativa rapida, a resposta vem pela entrada que a rota ja abriu.)
  const jaAbertas = [entradaMidi.nome, entradaResposta && entradaResposta.nome];
  for (const nome of portasCandidatas(portas.entradas)) {
    if (jaAbertas.includes(nome)) continue;
    const entrada = abrirEntradaDaMesa(nome);
    if (entrada.simulado) {
      console.log('[mesa] pulei a entrada "' + nome + '" no teste: ' + entrada.motivo);
      continue;
    }
    d.temporarias.entradas.push(entrada);
  }

  const dispositivos = d.rapido ? [rota.dispositivo] : ordemDosDispositivos(d.molde);
  const saidas = d.rapido ? [saidaMidi.nome] : ordemDasSaidas(portas.saidas);
  for (const nome of saidas) {
    if (d.cancelada) return;
    if (descobertaSaiuDoAr(d)) {
      interromperDescoberta('A mesa saiu do ar no meio do teste. Nada foi gravado.');
      return;
    }
    const atual = nome === saidaMidi.nome;
    const saida = atual ? saidaMidi : abrirSaida(nome);
    if (saida.simulado) {
      console.log('[mesa] pulei a saida "' + nome + '" no teste: ' + saida.motivo);
      continue;
    }
    if (!atual) d.temporarias.saidas.push(saida);
    if (d.testados) transmitir(mensagemTeste('testando', d));

    for (const n of dispositivos) {
      if (d.cancelada) return;
      if (descobertaSaiuDoAr(d)) {
        interromperDescoberta('A mesa saiu do ar no meio do teste. Nada foi gravado.');
        return;
      }
      if (!atual && saida.sumiu()) break;

      d.testados++;
      const entrada = await pedirNoTeste(d, saida, n, esperaTeste());
      if (entrada === null) continue;
      // Confirma com o mesmo pedido: uma resposta atrasada do n anterior nao
      // vira rota.
      const confirmada = await pedirNoTeste(d, saida, n, 3 * esperaTeste());
      if (confirmada === null) {
        d.soltas++;
        console.log('[mesa] resposta sem confirmacao em "' + nome + '" no canal MIDI ' + (n + 1) + ': sigo testando');
        continue;
      }
      // Contra-prova: com outro n a mesa tem que ficar calada. Se "responde",
      // eram quadros de alguem mexendo nesse send na mesa, nao resposta.
      if (d.cancelada) return;
      const outroN = (n + 1) % 16;
      const intrusa = await pedirNoTeste(d, saida, outroN, 3 * esperaTeste());
      if (intrusa !== null) {
        d.soltas++;
        console.log('[mesa] chegou "resposta" tambem no canal MIDI ' + (outroN + 1) + ' em "' + nome +
          '": alguem mexendo nesse send na mesa? Descartei e sigo testando');
        continue;
      }
      if (d.cancelada) return;
      d.achado = { saida, dispositivo: n, entrada: confirmada };
      return;
    }
  }
}

/** Um pedido de leitura do molde com esse n; devolve a entrada que respondeu, ou null. */
async function pedirNoTeste(d, saida, n, ms) {
  if (d.cancelada) return null;
  const resposta = esperarResposta(d, d.molde, ms);
  // Protecao: daqui so sai pedido de leitura (byte 2 = 3n), nunca Parameter change.
  enviarMidi(saida, mesa.montarPedidoDoControle(d.molde, n));
  const raw = await resposta;
  if (raw === null || d.cancelada) return null;
  return d.portaDaResposta || entradaMidi.nome;
}

/** Mesa sumiu ou porta trocada: para o teste sem gravar nada. */
function interromperDescoberta(motivo) {
  const d = descoberta;
  if (!d || d.cancelada) return;
  d.cancelada = true;
  d.motivoCancelamento = motivo;
  console.warn('[mesa] teste da mesa interrompido: ' + motivo);
  if (d.pendente) d.pendente.responder(null);
  fecharTemporarias(d);
}

/** Fecha as portas abertas so para o teste (as que viraram rota ja sairam da lista). */
function fecharTemporarias(d) {
  for (const porta of [...d.temporarias.entradas, ...d.temporarias.saidas]) {
    try { porta.fechar(); } catch { /* ignora */ }
  }
  d.temporarias.entradas = [];
  d.temporarias.saidas = [];
}

function tirarDaLista(lista, item) {
  const i = lista.indexOf(item);
  if (i >= 0) lista.splice(i, 1);
}

/**
 * Grava a rota no config.json, sem perder o resto do arquivo. trocarSaida:
 * a rota foi achada agora, e midi.saida passa a ser a porta dela.
 */
function gravarRota(nova, trocarSaida = false) {
  cfg.midi.rota = nova;
  if (nova && trocarSaida) cfg.midi.saida = nova.saida;
  try {
    const atual = configArquivo.carregar();
    if (JSON.stringify(atual.midi.rota || null) === JSON.stringify(nova) &&
      !(nova && trocarSaida && atual.midi.saida !== nova.saida)) return; // nada mudou
    atual.midi.rota = nova;
    if (nova && trocarSaida) atual.midi.saida = nova.saida;
    configArquivo.salvar(atual);
  } catch (erro) {
    console.error('[mesa] nao consegui gravar a rota no config.json: ' + erro.message);
  }
}

/** Fim do teste: grava a rota, troca a saida se precisar e avisa todos os celulares. */
function concluirDescoberta(d) {
  if (d.cancelada) {
    // Nada gravado: a rota (se havia) continua como estava.
    console.log('[mesa] fim do teste da mesa: falhou (interrompido)');
    transmitir(mensagemTeste('falhou', d, { motivo: d.motivoCancelamento, rota: rotaParaApp(rota) }));
    return { achou: false, motivo: d.motivoCancelamento };
  }

  if (d.achado) {
    const { saida, dispositivo } = d.achado;
    const nova = {
      saida: saida.nome,
      entrada: d.achado.entrada || entradaMidi.nome,
      dispositivo,
      em: new Date().toISOString(),
      reconfirmada: true
    };

    // A saida que respondeu passa a ser a da mesa.
    tirarDaLista(d.temporarias.saidas, saida);
    if (saida !== saidaMidi) {
      try { saidaMidi.fechar(); } catch { /* ignora */ }
      saidaMidi = saida;
    }
    // A entrada que trouxe a resposta, se foi aberta so para o teste, fica.
    const temporaria = d.temporarias.entradas.find((e) => e.nome === nova.entrada);
    if (temporaria) {
      tirarDaLista(d.temporarias.entradas, temporaria);
      fecharEntradaDaResposta();
      entradaResposta = temporaria;
    }
    rota = nova;
    abrirEntradaDaResposta(); // fecha a antiga se a resposta agora vem pela principal
    gravarRota(nova, true);

    console.log('[mesa] a mesa respondeu: saida "' + nova.saida + '", canal MIDI ' + (dispositivo + 1) +
      ', resposta por "' + nova.entrada + '" (' + d.testados + ' teste(s))');
    console.log('[mesa] fim do teste da mesa: ok');
    transmitir(mensagemTeste('ok', d, { rota: rotaParaApp(nova) }));
    transmitirStatus();
    return { achou: true, motivo: null };
  }

  let motivo;
  if (!d.molde) motivo = 'Nenhum controle calibrado serve de molde para o teste.';
  else if (!d.testados) motivo = 'Nao achei nenhuma porta da mesa para testar (presa por outro programa?).';
  else if (d.rapido) motivo = 'A mesa nao respondeu no caminho guardado (' + rota.saida + ', canal MIDI ' + (rota.dispositivo + 1) + ').';
  else motivo = 'A mesa nao respondeu em nenhuma porta nem canal MIDI (' + d.testados + ' teste(s)).';
  if (d.soltas) motivo += ' Chegou resposta que nao se confirmou: teste de novo.';

  // Nenhuma porta testada (ex.: presa pelo AirFader): nada muda na rota.
  // Testou e ninguem respondeu: a rota ja confirmada continua (e o melhor
  // caminho conhecido, os envios seguem com o n dela), marcada como nao
  // reconfirmada. Sem rota, continua sem.
  if (d.testados && rota && rota.reconfirmada) {
    rota = { ...rota, reconfirmada: false };
    gravarRota(rota);
  }
  console.warn('[mesa] a mesa nao respondeu ao teste' + (rota ? ' (a rota guardada continua)' : '') +
    '. Confira na mesa: ' + CONFERIR_NA_MESA.join(' | '));
  console.log('[mesa] fim do teste da mesa: falhou');
  transmitir(mensagemTeste('falhou', d, { motivo, conferir: CONFERIR_NA_MESA.slice(), rota: rotaParaApp(rota) }));
  transmitirStatus();
  return { achou: false, motivo };
}

// ---------------------------------------------------------------------------
// Modo mapa: espelho da mesa e leitura (sincronia)
// ---------------------------------------------------------------------------

/**
 * O bridge guarda um espelho da mesa: o valor cru de cada endereco do mapa
 * que interessa aos fones (mapa.ESPELHO), quais a mesa confirmou respondendo
 * a um pedido de leitura e a resolucao do fader. Quem manda e a mesa: o
 * espelho vem da leitura e de quem mexe nela; o celular so escreve num
 * endereco confirmado, pela rota conferida.
 */
const espelho = {
  valores: new Map(), // chave -> inteiro cru (fader, 0/1, codigo do caractere)
  confirmados: new Set(), // chaves que responderam na ultima leitura
  pronta: false,
  resolucao: null, // 'baixa' | 'alta' | null (nunca leu)
  resolucaoCrua: null,
  motivoResolucao: null,
  lidos: 0,
  total: 0,
  semResposta: [],
  sincronizadaEm: null
};
const ultimoEnvioMapa = new Map(); // chave -> quando saiu (para ignorar eco)
const mexidoNoMapa = new Map(); // chave -> quando um celular mexeu (vale mais que leitura velha)

let sincronia = null;
let sincroniaPendente = null; // { motivo, numero } esperando a vez

function modoMapa() {
  return cfg.midi.mapa !== false;
}

function maximoDaEscala() {
  return espelho.resolucao === 'alta' ? mapa.FADER_MAX : 255;
}

/**
 * HIGH (1023) se algum fader lido passou de 255 (impossivel em LOW) ou se a
 * leitura de Fader Resolution bate com o valor cru que alguem conferiu na
 * mesa (midi.resolucaoAltaCrua; nenhum manual documenta, entao por padrao
 * nao ha). Fora isso, LOW: mandar valor de HIGH para uma mesa em LOW pode
 * levar o fone ao maximo.
 */
function decidirResolucao(crua, acima255) {
  if (acima255) return { resolucao: 'alta', motivo: 'valor lido acima de 255' };
  const alta = cfg.midi.resolucaoAltaCrua;
  if (Number.isInteger(alta) && crua === alta) return { resolucao: 'alta', motivo: 'leitura da mesa (Fader Resolution = ' + crua + ')' };
  return { resolucao: 'baixa', motivo: 'nenhum valor acima de 255' + (crua === null ? '' : ' (Fader Resolution cru = ' + crua + ')') };
}

/** Valor cru do fader -> 0..1 na escala atual. */
function normalizado(raw) {
  if (!Number.isInteger(raw)) return null;
  return Math.min(1, Math.max(0, raw / maximoDaEscala()));
}

function valorDoEspelho(chave) {
  const v = espelho.valores.get(chave);
  return Number.isInteger(v) ? v : null;
}

function nomeDoEspelho(campo, numero, fallback) {
  const letras = [];
  let algum = false;
  for (let l = 1; l <= mapa.LETRAS_DO_NOME; l++) {
    const tipo = campo === 'nomeAux' ? mapa.TIPO.nomeAux(l) : mapa.TIPO.nomeCanal(l);
    const v = valorDoEspelho(mapa.chave(tipo, numero));
    if (v !== null) algum = true;
    letras.push(mapa.caractereDoCodigo(v));
  }
  const nome = algum ? letras.join('').trim() : '';
  return nome || fallback;
}

const nomeDoAux = (aux) => nomeDoEspelho('nomeAux', aux, 'Aux ' + aux);
const nomeDoCanal = (canal) => nomeDoEspelho('nomeCanal', canal, 'Canal ' + canal);

function mensagemResumo() {
  const auxes = [];
  for (let aux = 1; aux <= mapa.TOTAL_AUX; aux++) auxes.push({ aux, nome: nomeDoAux(aux) });
  return {
    type: 'mesa:resumo',
    pronta: modoMapa() && espelho.pronta && !semMesa() && rotaVerificada(),
    auxes,
    resolucao: espelho.resolucao,
    sincronizadaEm: espelho.sincronizadaEm
  };
}

function transmitirResumo() {
  transmitir(mensagemResumo());
}

function chaveDe(campo, aux, canal) {
  if (campo === 'valor') return mapa.chave(mapa.TIPO.send(aux), canal);
  if (campo === 'on') return mapa.chave(mapa.TIPO.sendOn(aux), canal);
  if (campo === 'master') return mapa.chave(mapa.TIPO.master, aux);
  return mapa.chave(mapa.TIPO.masterOn, aux);
}

function onDoEspelho(chave) {
  const v = valorDoEspelho(chave);
  return v === null ? null : v !== 0;
}

function mensagemEstadoDoFone(aux) {
  const canais = [];
  for (let canal = 1; canal <= mapa.TOTAL_CANAIS; canal++) {
    const kValor = chaveDe('valor', aux, canal);
    const kOn = chaveDe('on', aux, canal);
    canais.push({
      canal,
      nome: nomeDoCanal(canal),
      valor: normalizado(valorDoEspelho(kValor)),
      on: onDoEspelho(kOn),
      confirmado: espelho.confirmados.has(kValor) && espelho.confirmados.has(kOn)
    });
  }
  return {
    type: 'fone:estado',
    aux,
    nome: nomeDoAux(aux),
    master: {
      valor: normalizado(valorDoEspelho(chaveDe('master', aux))),
      on: onDoEspelho(chaveDe('masterOn', aux))
    },
    canais
  };
}

/** Manda so para os celulares que escolheram esse Aux. */
function transmitirParaAux(aux, objeto, exceto = null) {
  const texto = JSON.stringify(objeto);
  for (const cliente of wss.clients) {
    if (cliente === exceto || cliente.aux !== aux) continue;
    if (cliente.readyState === cliente.OPEN) cliente.send(texto);
  }
}

function transmitirEstadosDosFones() {
  const escolhidos = new Set();
  for (const cliente of wss.clients) if (cliente.aux) escolhidos.add(cliente.aux);
  for (const aux of escolhidos) transmitirParaAux(aux, mensagemEstadoDoFone(aux));
}

/** A mesa saiu (cabo, porta trocada): nada do espelho vale para escrever ate ler de novo. */
function perderMapa(motivo) {
  if (!espelho.pronta && !espelho.confirmados.size) return;
  espelho.pronta = false;
  espelho.confirmados.clear();
  console.log('[mapa] espelho da mesa sem confirmacao: ' + motivo);
  transmitirResumo();
}

// Nomes chegam da mesa uma letra por mensagem: junta tudo antes de avisar.
const nomesMudados = new Set();
let timerNomes = null;

function avisarNomes() {
  timerNomes = null;
  let auxMudou = false;
  for (const k of nomesMudados) {
    const [campo, numero] = k.split(':');
    const n = Number(numero);
    if (campo === 'nomeCanal') {
      // O nome do canal vale para todos os fones: cada celular recebe com o
      // Aux que escolheu (null se ainda nao escolheu).
      const nome = nomeDoCanal(n);
      for (const cliente of wss.clients) {
        enviarPara(cliente, { type: 'fone:mudou', aux: cliente.aux || null, canal: n, campo: 'nome', valor: nome });
      }
    } else {
      auxMudou = true;
      transmitirParaAux(n, { type: 'fone:mudou', aux: n, canal: null, campo: 'nome', valor: nomeDoAux(n) });
    }
  }
  nomesMudados.clear();
  if (auxMudou) transmitirResumo();
}

/**
 * Guarda no espelho um valor que veio da mesa. avisar: alguem mexeu na mesa
 * (os celulares sao avisados agora); sem avisar: e a leitura, que avisa
 * tudo de uma vez no fim.
 */
function guardarNoEspelho(item, n, avisar) {
  const antes = espelho.valores.get(item.chave);
  espelho.valores.set(item.chave, n);

  if (item.campo === 'resolucao') {
    espelho.resolucaoCrua = n;
    // Lendo a mesa: a escala e decidida no fim, so com o que veio nela.
    if (sincronia) {
      sincronia.resolucaoCrua = n;
      return;
    }
    if (!avisar) return;
    // Alguem mexeu no ajuste na mesa: decide so com o que se sabe agora (na
    // duvida, LOW) e le a mesa de novo para juntar prova.
    const d = decidirResolucao(n, false);
    if (d.resolucao !== espelho.resolucao) mudarResolucao(d);
    pedirSincronia('resolucao');
    return;
  }

  // Valor acima de 255 so existe em HIGH: muda a escala na hora.
  if (mapa.ehFader(item.campo) && n > 255 && espelho.resolucao !== 'alta') {
    if (sincronia) sincronia.acima255 = true;
    if (avisar) mudarResolucao({ resolucao: 'alta', motivo: 'valor lido acima de 255' });
    return;
  }
  if (!avisar || antes === n) return;

  if (item.campo === 'nomeCanal' || item.campo === 'nomeAux') {
    nomesMudados.add(item.campo + ':' + (item.campo === 'nomeAux' ? item.aux : item.canalDoFone));
    if (!timerNomes) {
      timerNomes = setTimeout(avisarNomes, 150);
      timerNomes.unref();
    }
    return;
  }
  const canal = item.campo === 'valor' || item.campo === 'on' ? item.canalDoFone : null;
  const valor = mapa.ehFader(item.campo) ? normalizado(n) : n !== 0;
  transmitirParaAux(item.aux, { type: 'fone:mudou', aux: item.aux, canal, campo: item.campo, valor });
}

function mudarResolucao(d) {
  const antes = espelho.resolucao;
  espelho.resolucao = d.resolucao;
  espelho.motivoResolucao = d.motivo;
  console.log('[mapa] escala do fader: ' + (d.resolucao === 'alta' ? 'HIGH (1023)' : 'LOW (255)') + ', ' + d.motivo);
  if (antes !== d.resolucao) {
    transmitirResumo();
    transmitirEstadosDosFones();
  }
}

/**
 * Alguem mexeu na mesa (ou chegou resposta atrasada) num endereco do
 * espelho: atualiza e avisa os celulares daquele Aux. Eco do que o proprio
 * bridge acabou de mandar e ignorado. true se o quadro era do espelho.
 */
function acompanharMapa(bytes, atrasada = false) {
  if (!modoMapa()) return false;
  const id = mapa.identificar(bytes);
  if (!id || id.pedido) return false;
  const chave = mapa.chave(id.tipo, id.canal);
  const item = mapa.ESPELHO_POR_CHAVE.get(chave);
  if (!item) return false;
  const n = mapa.inteiroDosDados(id.dados);
  if (n === null || !mapa.valorPlausivel(item.campo, n)) return false;
  if (Date.now() - (ultimoEnvioMapa.get(chave) || 0) < (cfg.midi.janelaEcoMs || 400)) return true;
  // Resposta atrasada de Fader Resolution e so a leitura velha, nao alguem
  // mexendo no ajuste: guarda o numero e nao decide nada.
  if (atrasada && item.campo === 'resolucao') {
    espelho.resolucaoCrua = n;
    return true;
  }
  // Resposta atrasada acima de 255 e de uma leitura velha (a mesa pode ter
  // passado para LOW desde entao): nunca sobe a escala. So movimento AO VIVO
  // prova HIGH. Ignorada, sem guardar.
  if (atrasada && mapa.ehFader(item.campo) && n > 255 && espelho.resolucao !== 'alta') return true;
  guardarNoEspelho(item, n, true);
  return true;
}

// --- a leitura -------------------------------------------------------------

function loteSincronia() {
  const n = Number(cfg.midi.loteSincronia);
  return Number.isInteger(n) && n > 0 ? Math.min(64, n) : 16;
}

function pausaSincronia() {
  const ms = Number(cfg.midi.pausaSincroniaMs);
  return Number.isFinite(ms) && ms >= 0 ? Math.min(1000, ms) : 20;
}

function mensagemSincronia(fase, s, motivo = null) {
  return { type: 'mesa:sincronia', fase, lidos: s ? s.lidos : 0, total: s ? s.total : 0, motivo };
}

/**
 * Pede a leitura (modo mapa). So com a mesa no cabo e rota conferida; se
 * algo exclusivo estiver rodando, espera a vez (tentarPendentes).
 * numero: a cena que disparou (para avisar "cena:relida" dos calibrados).
 */
function pedirSincronia(motivo, numero = null) {
  if (!modoMapa() || semMesa() || !rotaVerificada()) return false;
  // Com troca de cena a caminho (timerReleitura), outro pedido espera: a da
  // cena le logo depois e leva o numero dela.
  if (sincronia || descoberta || geracao || releitura || sessoes.size || (timerReleitura && motivo !== 'cena')) {
    // Pedido de cena vale mais que outro: ele leva o numero para o fim.
    if (!sincroniaPendente || motivo === 'cena') sincroniaPendente = { motivo, numero };
    return true;
  }
  comecarSincronia(motivo, numero);
  return true;
}

function tentarSincroniaPendente() {
  if (!sincroniaPendente || timerReleitura) return;
  if (sincronia || descoberta || geracao || releitura || sessoes.size) return;
  const { motivo, numero } = sincroniaPendente;
  sincroniaPendente = null;
  pedirSincronia(motivo, numero);
}

/** Para a leitura. motivo null = troca de cena (a leitura nova avisa por ela). */
function interromperSincronia(motivo) {
  const s = sincronia;
  if (!s || s.cancelada) return;
  s.cancelada = true;
  s.motivoCancelamento = motivo;
  console.log('[mapa] leitura interrompida: ' + (motivo || 'a mesa trocou de cena de novo'));
  if (s.despertar) s.despertar();
}

function comecarSincronia(motivo, numero) {
  sincroniaPendente = null;
  const n = rota.dispositivo;
  const itens = mapa.ESPELHO.map((item) => ({ ...item, pedido: mapa.montarPedido(item.tipo, item.canal, n), pedidoEm: 0 }));
  // Os controles calibrados tambem sao relidos (a leitura substitui a releitura).
  const calibrados = [];
  for (const c of controles) {
    const pedido = mesa.montarPedidoDoControle(c, n);
    if (pedido) calibrados.push({ id: c.id, controle: { ...c, template: c.template.slice() }, pedido, pedidoEm: 0 });
  }
  const s = {
    motivo,
    numero,
    itens,
    calibrados,
    faltam: new Map(itens.map((i) => [i.chave, i])),
    calibradosFaltam: new Map(calibrados.map((c) => [c.id, c])),
    temCalibrados: calibrados.length > 0,
    lidosCalibrados: [],
    respondidos: new Set(),
    lidos: 0,
    total: itens.length + calibrados.length,
    acima255: false, // algum fader lido NESTA leitura passou de 255
    resolucaoCrua: null, // Fader Resolution lido NESTA leitura
    cancelada: false,
    motivoCancelamento: null,
    despertar: null,
    ateAcabar: false,
    ultimoAviso: 0,
    saida: saidaMidi,
    entrada: entradaMidi
  };
  sincronia = s;
  console.log('[mapa] lendo a mesa (' + motivo + (numero !== null ? ', cena ' + numero : '') + '): ' +
    s.total + ' endereco(s), em lotes de ' + loteSincronia());
  transmitir(mensagemSincronia('lendo', s));

  rodarSincronia(s)
    .catch((erro) => {
      console.error('[mapa] erro na leitura: ' + erro.message);
      s.cancelada = true;
      s.motivoCancelamento = 'Algo deu errado na leitura da mesa.';
    })
    .then(() => concluirSincronia(s))
    .catch((erro) => console.error('[mapa] nao consegui terminar a leitura: ' + erro.message))
    .finally(() => {
      if (sincronia === s) sincronia = null;
      tentarPendentes();
    });
}

function faltamNaSincronia(s) {
  return s.faltam.size + s.calibradosFaltam.size;
}

/** Espera ms (ou ate faltar nada, com ateAcabar), acordando se a leitura parar. */
function esperarNaSincronia(s, ms, ateAcabar = false) {
  return new Promise((ok) => {
    const timer = setTimeout(fim, ms);
    function fim() {
      clearTimeout(timer);
      if (s.despertar === fim) {
        s.despertar = null;
        s.ateAcabar = false;
      }
      ok();
    }
    s.despertar = fim;
    s.ateAcabar = ateAcabar;
  });
}

/**
 * Pede tudo em lotes pequenos, com pausa entre eles (a mesa perde respostas
 * se recebe tudo de uma vez), e casa cada resposta pelo endereco. O que nao
 * respondeu e pedido mais uma vez. Daqui so sai Parameter request.
 */
async function rodarSincronia(s) {
  const lote = loteSincronia();
  const pausa = pausaSincronia();
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const fila = [...s.faltam.values(), ...s.calibradosFaltam.values()];
    if (!fila.length) return;
    if (tentativa === 2) console.log('[mapa] ' + fila.length + ' endereco(s) sem resposta: pergunto de novo, uma vez');
    const enviados = new Set();
    for (let i = 0; i < fila.length; i += lote) {
      if (s.cancelada) return;
      if (mesaSaiuDoAr(s)) {
        interromperSincronia('A mesa saiu do ar no meio da leitura.');
        return;
      }
      for (const item of fila.slice(i, i + lote)) {
        if (item.chave ? !s.faltam.has(item.chave) : !s.calibradosFaltam.has(item.id)) continue;
        item.pedidoEm = Date.now();
        const hex = item.pedido.join(',');
        if (enviados.has(hex)) continue; // calibrado no mesmo endereco de um item do mapa
        enviados.add(hex);
        item.enviados = (item.enviados || 0) + 1;
        // Protecao: daqui so sai pedido de leitura (byte 2 = 3n), nunca Parameter change.
        if ((item.pedido[2] & 0xf0) !== 0x30) throw new Error('pedido de leitura sem 3n');
        enviarMidi(s.saida, item.pedido);
      }
      await esperarNaSincronia(s, pausa);
      if (Date.now() - s.ultimoAviso >= 250) {
        s.ultimoAviso = Date.now();
        transmitir(mensagemSincronia('lendo', s));
      }
    }
    if (s.cancelada) return;
    if (faltamNaSincronia(s)) await esperarNaSincronia(s, esperaResposta(), true);
  }
}

/** Resposta a um pedido da leitura? Guarda o valor e confirma o endereco. */
function tomarRespostaDaSincronia(s, bytes) {
  // Leitura parada (cena nova, mesa saiu): nada mais e dela.
  if (s.cancelada) return false;
  let tomou = false;
  const id = mapa.identificar(bytes);
  if (id && !id.pedido) {
    const chave = mapa.chave(id.tipo, id.canal);
    const item = s.faltam.get(chave);
    const n = item ? mapa.inteiroDosDados(id.dados) : null;
    // So confirma valor que faz sentido para o campo (On: 0 ou 1, fader: ate 1023...).
    if (item && n !== null && mapa.valorPlausivel(item.campo, n)) {
      s.faltam.delete(chave);
      s.respondidos.add(chave);
      espelho.confirmados.add(chave);
      s.lidos++;
      if (mapa.ehFader(item.campo) && n > 255) s.acima255 = true;
      // O celular mexeu (ou o bridge mandou) depois do pedido: esse valor ja
      // vale mais que a leitura, que e de antes.
      const mexido = mexidoNoMapa.get(chave) || 0;
      const enviado = ultimoEnvioMapa.get(chave) || 0;
      if (!pendentes.has(PREFIXO_MAPA + chave) && mexido < item.pedidoEm && enviado < item.pedidoEm) {
        guardarNoEspelho(item, n, false);
      }
      tomou = true;
    }
  }
  for (const [cid, item] of s.calibradosFaltam) {
    const raw = mesa.lerValorDoFrame(item.controle, bytes);
    if (raw === null) continue;
    s.calibradosFaltam.delete(cid);
    s.lidosCalibrados.push(cid);
    s.lidos++;
    aplicarReleitura(cid, raw, item.pedidoEm);
    tomou = true;
  }
  if (tomou && s.ateAcabar && !faltamNaSincronia(s) && s.despertar) s.despertar();
  return tomou;
}

function concluirSincronia(s) {
  // O que ficou sem resposta pode responder depois: de quarentena, para nunca
  // cair na calibracao nem em outro fluxo.
  // Conta cada pedido ainda em aberto: o endereco que so respondeu na segunda
  // tentativa ainda pode mandar a resposta da primeira.
  for (const item of s.itens) {
    const abertos = (item.enviados || 0) - (s.respondidos.has(item.chave) ? 1 : 0);
    if (abertos > 0) lembrarAtrasadaDoMapa(item.chave, abertos);
  }
  for (const item of s.calibrados) {
    const abertos = (item.enviados || 0) - (s.lidosCalibrados.includes(item.id) ? 1 : 0);
    for (let i = 0; i < abertos; i++) lembrarAtrasada(item.controle);
  }

  // Os calibrados relidos vao pelo "state" de sempre.
  const values = {};
  const mutes = {};
  for (const id of s.lidosCalibrados) {
    if (!porId.has(id)) continue;
    values[id] = estado.valores[id];
    mutes[id] = estado.mutes[id];
  }
  if (Object.keys(values).length) {
    transmitir({ type: 'state', values, mutes });
    agendarSalvamento();
  }

  const semResposta = [...s.faltam.keys(), ...[...s.calibradosFaltam.keys()].map((id) => 'controle:' + id)];
  console.log('[mapa] leitura: ' + s.lidos + ' de ' + s.total + ' lido(s), ' + semResposta.length + ' sem resposta' +
    (s.cancelada ? ', interrompida' : ''));

  if (s.cancelada) {
    if (s.motivoCancelamento) {
      espelho.pronta = false;
      transmitir(mensagemSincronia('falhou', s, s.motivoCancelamento));
      transmitirResumo();
    }
    return; // troca de cena: a leitura nova avisa por ela
  }

  espelho.confirmados = new Set(s.respondidos);
  espelho.lidos = s.lidos;
  espelho.total = s.total;
  espelho.semResposta = semResposta;
  // Escala so com o que ESTA leitura trouxe: um fader velho acima de 255, de
  // um endereco que agora nao respondeu, nunca segura HIGH numa mesa que
  // passou para LOW. Na duvida, LOW.
  espelho.resolucaoCrua = s.resolucaoCrua;
  const d = decidirResolucao(s.resolucaoCrua, s.acima255);
  espelho.resolucao = d.resolucao;
  espelho.motivoResolucao = d.motivo;
  console.log('[mapa] escala do fader: ' + (d.resolucao === 'alta' ? 'HIGH (1023)' : 'LOW (255)') + ', ' + d.motivo);
  // O que nao respondeu agora deixa de valer no espelho: fica desconhecido.
  for (const chave of s.faltam.keys()) espelho.valores.delete(chave);

  let motivo = null;
  if (!s.lidos) {
    espelho.pronta = false;
    motivo = 'A mesa nao respondeu a nenhum pedido de leitura. Toque em "Testar a mesa" e confira MIDI | SETUP na mesa.';
    console.warn('[mapa] a mesa nao respondeu a leitura');
  } else {
    espelho.pronta = true;
    espelho.sincronizadaEm = new Date().toISOString();
    // So conta o que o app mexe (send, On, master e calibrados), nao letra de nome.
    const gravaveis = s.itens.filter((i) => mapa.ehGravavel(i.campo)).length + s.calibrados.length;
    const gravaveisSemResposta = [...s.faltam.values()].filter((i) => mapa.ehGravavel(i.campo)).length +
      s.calibradosFaltam.size;
    if (gravaveisSemResposta) {
      motivo = gravaveisSemResposta + ' de ' + gravaveis + ' controle(s) sem resposta: esses nao sao mexidos pelo app.';
    }
  }

  transmitirResumo();
  transmitirEstadosDosFones();
  transmitir(mensagemSincronia(s.lidos ? 'pronta' : 'falhou', s, motivo));
  if (s.numero !== null && s.temCalibrados) {
    transmitir({
      type: 'cena:relida',
      numero: s.numero,
      lidos: s.lidosCalibrados.slice(),
      semResposta: [...s.calibradosFaltam.keys()]
    });
  }
}

// --- o que o celular pede ---------------------------------------------------

function ehAux(n) {
  return Number.isInteger(n) && n >= 1 && n <= mapa.TOTAL_AUX;
}

function erroDoMapa(cliente, message) {
  enviarPara(cliente, { type: 'controle:erro', message });
}

const MAPA_DESLIGADO = 'O modo mapa esta desligado neste PC ("mapa": false em midi, no config.json).';

/** fone:escolher: o celular passa a acompanhar esse Aux e recebe o estado dele. */
function escolherFone(cliente, msg) {
  if (!modoMapa()) return erroDoMapa(cliente, MAPA_DESLIGADO);
  if (!ehAux(msg.aux)) return erroDoMapa(cliente, 'Escolha um fone de Aux 1 a Aux 8.');
  cliente.aux = msg.aux;
  enviarPara(cliente, mensagemEstadoDoFone(msg.aux));
}

/**
 * fone:send / fone:sendOn / fone:master / fone:masterOn. So vai para a mesa
 * se podeEscreverNoMapa deixar (rota conferida e endereco confirmado); o
 * resto do motivo e so para explicar a recusa.
 */
function mexerNoFone(cliente, msg, campo) {
  if (!modoMapa()) return erroDoMapa(cliente, MAPA_DESLIGADO);
  if (!ehAux(msg.aux)) return erroDoMapa(cliente, 'Escolha um fone de Aux 1 a Aux 8.');
  const comCanal = campo === 'valor' || campo === 'on';
  if (comCanal && !(Number.isInteger(msg.canal) && msg.canal >= 1 && msg.canal <= mapa.TOTAL_CANAIS)) {
    return erroDoMapa(cliente, 'Canal invalido: vai de 1 a ' + mapa.TOTAL_CANAIS + '.');
  }
  let valor;
  if (mapa.ehFader(campo)) {
    if (typeof msg.valor !== 'number' || !Number.isFinite(msg.valor)) return erroDoMapa(cliente, 'Valor invalido: mande um numero de 0 a 1.');
    valor = mesa.limitar01(msg.valor);
  } else {
    if (typeof msg.on !== 'boolean') return erroDoMapa(cliente, 'Mande "on" como true ou false.');
    valor = msg.on;
  }

  const chave = chaveDe(campo, msg.aux, msg.canal);
  if (!podeEscreverNoMapa(chave)) {
    let motivo;
    if (semMesa()) motivo = 'Ligue a mesa no cabo USB: nada foi mandado.';
    else if (!rotaVerificada()) motivo = 'A mesa ainda nao confirmou o caminho (toque em "Testar a mesa"): nada foi mandado.';
    else motivo = 'A mesa nao confirmou esse controle na ultima leitura: nada foi mandado.';
    return erroDoMapa(cliente, motivo);
  }

  const raw = mapa.ehFader(campo) ? mapa.rawDoFader(valor, maximoDaEscala()) : (valor ? 1 : 0);
  espelho.valores.set(chave, raw);
  mexidoNoMapa.set(chave, Date.now());
  pendentes.set(PREFIXO_MAPA + chave, valor);
  transmitirParaAux(msg.aux, {
    type: 'fone:mudou',
    aux: msg.aux,
    canal: comCanal ? msg.canal : null,
    campo,
    valor: mapa.ehFader(campo) ? normalizado(raw) : valor
  }, cliente);
}

/** mesa:sincronizar: le a mesa de novo agora. */
function sincronizarPeloApp(cliente) {
  let motivo = null;
  if (!modoMapa()) motivo = MAPA_DESLIGADO;
  else if (semMesa()) motivo = 'Ligue a mesa no cabo USB: a leitura precisa que ela responda.';
  else if (!rotaVerificada()) motivo = 'Ainda nao sei por qual caminho a mesa responde: toque em "Testar a mesa".';
  else if (sincronia) motivo = 'Ja estou lendo a mesa; espere terminar.';
  else if (descoberta) motivo = 'Estou testando a mesa agora; tente de novo em alguns segundos.';
  else if (geracao) motivo = 'Estou criando canais agora; tente de novo quando terminar.';
  else if (releitura) motivo = 'Estou relendo a mesa depois da troca de cena; tente de novo em alguns segundos.';
  else if (sessoes.size) motivo = 'Alguem esta calibrando um controle agora; tente de novo quando terminar.';
  if (motivo) return erroDoMapa(cliente, motivo);
  pedirSincronia('app');
}

// ---------------------------------------------------------------------------
// Atualizar agora (pedido pelo app)
// ---------------------------------------------------------------------------

/**
 * O app pede e confirma: o bridge abre o atualizador (`iniciar.js atualizar
 * --agora <id>`) fora da sua arvore de processos, do mesmo jeito que a
 * vigia liga o bridge (o atualizador para este bridge no meio da troca). O
 * atualizador conta como vai em atualizacao-agora.json; o bridge le e avisa
 * todos os celulares (atualizar:estado). Depois da troca, o bridge novo le o
 * mesmo arquivo ao subir e avisa como terminou.
 */
const ARQUIVO_AGORA = path.join(configArquivo.DADOS, 'atualizacao-agora.json');
const FASES_ATUALIZAR = new Set(['verificando', 'baixando', 'testando', 'trocando', 'em-dia', 'falhou']);
const FASES_FINAIS = new Set(['em-dia', 'falhou']);
const PRAZO_ATUALIZAR_MS = 20 * 60 * 1000;
// O atualizador grava a primeira fase em segundos. Sem nenhum sinal dele em
// 2 min, ele nem abriu: o app fica sabendo, em vez de 20 min "verificando".
const SINAL_ATUALIZAR_MS = 2 * 60 * 1000;
let atualizacaoAgora = null; // { id, desde, timer, viuSinal }
let ultimoAtualizar = null; // { fase, mensagem, em }

/** O bridge roda de uma instalacao (INST\versoes\<sha>, com INST\iniciar.js)? */
function naInstalacao() {
  const inst = configArquivo.DADOS;
  if (!fs.existsSync(path.join(inst, 'iniciar.js'))) return false;
  const rel = path.relative(path.join(inst, 'versoes'), configArquivo.RAIZ);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

function avisarAtualizar(fase, mensagem) {
  ultimoAtualizar = { fase, mensagem, em: Date.now() };
  console.log('[atualizar] ' + fase + ': ' + mensagem);
  transmitir({ type: 'atualizar:estado', fase, mensagem });
}

/** O que o atualizador gravou, conferido campo a campo; null se nao ha. */
function lerProgressoDaAtualizacao() {
  try {
    const j = configArquivo.lerJson(ARQUIVO_AGORA);
    if (!j || typeof j !== 'object' || !FASES_ATUALIZAR.has(j.fase)) return null;
    const em = Date.parse(j.em);
    if (!Number.isFinite(em)) return null;
    return {
      id: typeof j.id === 'string' && /^[0-9a-f]{16}$/.test(j.id) ? j.id : null,
      fase: j.fase,
      mensagem: typeof j.mensagem === 'string' ? j.mensagem.slice(0, 200) : '',
      em
    };
  } catch {
    return null;
  }
}

function pararDeAcompanharAtualizacao() {
  if (atualizacaoAgora && atualizacaoAgora.timer) clearInterval(atualizacaoAgora.timer);
  atualizacaoAgora = null;
}

function acompanharAtualizacao() {
  const a = atualizacaoAgora;
  if (!a) return;
  const p = lerProgressoDaAtualizacao();
  if (p && p.id === a.id && p.em >= a.desde - 1000) {
    a.viuSinal = true;
    if (!ultimoAtualizar || ultimoAtualizar.fase !== p.fase || ultimoAtualizar.mensagem !== p.mensagem) {
      avisarAtualizar(p.fase, p.mensagem);
    }
    if (FASES_FINAIS.has(p.fase)) {
      pararDeAcompanharAtualizacao();
      return;
    }
  }
  if (!a.viuSinal && Date.now() - a.desde > SINAL_ATUALIZAR_MS) {
    pararDeAcompanharAtualizacao();
    avisarAtualizar('falhou', 'O atualizador nao abriu (nenhum sinal em 2 minutos). Tente de novo; se repetir, veja o atualizacao.log no PC da mesa.');
    return;
  }
  if (Date.now() - a.desde > PRAZO_ATUALIZAR_MS) {
    pararDeAcompanharAtualizacao();
    avisarAtualizar('falhou', 'O atualizador nao deu noticia. Veja o diagnostico (atualizacao.log no PC da mesa).');
  }
}

function acompanharAtualizacaoDe(id, desde, viuSinal = false) {
  pararDeAcompanharAtualizacao();
  const timer = setInterval(acompanharAtualizacao, 500);
  timer.unref();
  atualizacaoAgora = { id, desde, timer, viuSinal };
}

/** Ao subir: uma atualizacao pedida pelo app ainda em andamento (ou que acabou de terminar). */
function retomarAtualizacao() {
  const p = lerProgressoDaAtualizacao();
  if (!p || Date.now() - p.em > PRAZO_ATUALIZAR_MS) return;
  ultimoAtualizar = { fase: p.fase, mensagem: p.mensagem, em: p.em };
  // O proprio arquivo ja e sinal de vida do atualizador.
  if (!FASES_FINAIS.has(p.fase)) acompanharAtualizacaoDe(p.id, p.em, true);
}

/** atualizar:agora */
function atualizarAgora(cliente) {
  // Acabou de terminar (menos de 10 min): devolve como terminou e nao abre
  // outra. Toque repetido ou celular que reconectou nao dispara de novo.
  if (!atualizacaoAgora && ultimoAtualizar && FASES_FINAIS.has(ultimoAtualizar.fase) &&
    Date.now() - ultimoAtualizar.em < 10 * 60 * 1000) {
    enviarPara(cliente, { type: 'atualizar:estado', fase: ultimoAtualizar.fase, mensagem: ultimoAtualizar.mensagem });
    return;
  }
  if (!naInstalacao()) {
    return erroDoMapa(cliente, 'Atualizar pelo app so funciona no PC da mesa, com o programa instalado pelo instalador do Windows.');
  }
  if (atualizacaoAgora) {
    if (ultimoAtualizar) enviarPara(cliente, { type: 'atualizar:estado', fase: ultimoAtualizar.fase, mensagem: ultimoAtualizar.mensagem });
    return erroDoMapa(cliente, 'Ja estou atualizando; acompanhe por aqui.');
  }
  let atualizador;
  try {
    atualizador = require('./atualizar');
  } catch (erro) {
    // O detalhe (caminho, pilha) fica so no log; o celular recebe texto fixo.
    console.error('[atualizar] nao carreguei o atualizador: ' + String(erro.message).split('\n')[0].slice(0, 200));
    return erroDoMapa(cliente, 'Nao consegui abrir o atualizador.');
  }
  const id = crypto.randomBytes(8).toString('hex');
  acompanharAtualizacaoDe(id, Date.now());
  console.log('[atualizar] pedido pelo app: abrindo o atualizador (--agora ' + id + ')');
  avisarAtualizar('verificando', 'Procurando versao nova.');
  Promise.resolve()
    .then(() => atualizador.lancarAgora(configArquivo.DADOS, id))
    .then((abriu) => {
      if (!abriu && atualizacaoAgora && atualizacaoAgora.id === id) {
        pararDeAcompanharAtualizacao();
        avisarAtualizar('falhou', 'Nao consegui abrir o atualizador.');
      }
    })
    .catch((erro) => {
      console.error('[atualizar] erro ao abrir o atualizador: ' + erro.message);
      if (atualizacaoAgora && atualizacaoAgora.id === id) {
        pararDeAcompanharAtualizacao();
        avisarAtualizar('falhou', 'Nao consegui abrir o atualizador.');
      }
    });
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
  '.woff2': 'font/woff2',
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
  return controles.map((c) => {
    const item = {
      id: c.id,
      label: c.rotulo || c.id,
      type: c.tipo || 'canal',
      calibrated: mesa.estaCalibrado(c)
    };
    // "canal" so aparece quando da para criar os outros a partir deste.
    const canal = item.type === 'canal' ? mesa.canalDoControle(c) : null;
    if (canal !== null) item.canal = canal;
    return item;
  });
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
    const portas = listarPortas();
    responderJson(res, {
      versao: lerVersao(),
      midi: {
        saida: saidaMidi.nome,
        entrada: entradaMidi.nome,
        entradaResposta: entradaResposta ? entradaResposta.nome : null,
        simulado: saidaMidi.simulado,
        entradaSimulada: entradaMidi.simulado,
        motivo: saidaMidi.motivo || null,
        portasVistas: portas.saidas,
        entradasVistas: portas.entradas
      },
      // Caixa preta para quem for ajudar de longe: por onde e com qual canal
      // MIDI o bridge escreve, o que entrou e saiu por ultimo e os moldes.
      rota: rota
        ? { saida: rota.saida, entrada: rota.entrada, dispositivo: rota.dispositivo,
            canalMidi: rota.dispositivo + 1, em: rota.em, reconfirmada: rota.reconfirmada,
            valeParaSaidaAberta: rotaValeParaSaida() }
        : null,
      // "em" e a ultima vez (a linha pode juntar "vezes" mensagens iguais seguidas).
      ultimosMidi: ultimosMidi.map(({ quando, dir, porta, hex, vezes }) =>
        ({ em: new Date(quando).toISOString(), dir, porta, hex, vezes })),
      controlesHex: controles.filter(mesa.estaCalibrado).map((c) => ({
        id: c.id,
        rotulo: c.rotulo || c.id,
        hex: mesa.paraHex(c.template),
        offset: c.valueOffset,
        length: c.valueLength,
        rawMin: c.rawMin,
        rawMax: c.rawMax,
        // O comeco que sai de verdade (com o n da rota, se ela vale para esta
        // saida): o "hex" acima e o molde, com o n do Tx da mesa.
        enviaCom: mesa.paraHex(mesa.montarFrame(c, 0, dispositivoDaRota()).slice(0, 3))
      })),
      maquina: {
        sistema: process.platform,
        node: process.version,
        ligadoHa: Math.round(process.uptime()) + 's'
      },
      // Modo mapa: o que a ultima leitura achou. resolucaoCrua e o valor de
      // Fader Resolution como a mesa mandou (a codificacao nao e documentada:
      // confira com a tela MIDI | SETUP da mesa). semResposta: os enderecos
      // que a mesa nao confirmou (no maximo 60 aqui; o total vem a parte).
      mapa: {
        ativo: modoMapa(),
        pronta: mensagemResumo().pronta,
        resolucao: espelho.resolucao,
        resolucaoCrua: espelho.resolucaoCrua,
        motivoResolucao: espelho.motivoResolucao,
        lidos: espelho.lidos,
        total: espelho.total,
        semResposta: espelho.semResposta.slice(0, 60),
        semRespostaTotal: espelho.semResposta.length,
        sincronizadaEm: espelho.sincronizadaEm,
        lendo: sincronia ? { lidos: sincronia.lidos, total: sincronia.total } : null,
        auxes: mensagemResumo().auxes
      },
      controles: controles.length,
      naoCalibrados,
      clientes: wss ? wss.clients.size : 0,
      // Na igreja, confere se o numero bate com o display (hipotese byte = programa - 1).
      cena: estado.cena.atual
        ? {
            numero: estado.cena.atual.numero,
            origem: estado.cena.atual.origem,
            bruto: estado.cena.atual.bruto,
            em: estado.cena.atual.em
          }
        : null,
      avisos
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

// Mensagem do app e sempre pequena; 64 KiB e folga de sobra e corta abuso.
const wss = new WebSocketServer({ server: servidor, maxPayload: 64 * 1024 });

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

  // Sequencia de boas vindas: lista de faders, situacao do MIDI, estado atual
  // e a cena em que a mesa esta (com os nomes dados pelo app).
  enviarPara(cliente, { type: 'controls', controls: listaParaApp() });
  enviarPara(cliente, statusAtual());
  enviarPara(cliente, { type: 'state', values: estado.valores, mutes: estado.mutes });
  enviarPara(cliente, mensagemCena());
  // Modo mapa: os fones (Aux) que existem e se a leitura da mesa esta pronta.
  enviarPara(cliente, mensagemResumo());
  // Chegou no meio de um teste da mesa: fica sabendo que ele esta rodando.
  if (descoberta) enviarPara(cliente, mensagemTeste('testando', descoberta));
  if (sincronia) enviarPara(cliente, mensagemSincronia('lendo', sincronia));
  // Reconectou depois de uma atualizacao pedida pelo app: ve como ela acabou.
  if (ultimoAtualizar && Date.now() - ultimoAtualizar.em < PRAZO_ATUALIZAR_MS) {
    enviarPara(cliente, { type: 'atualizar:estado', fase: ultimoAtualizar.fase, mensagem: ultimoAtualizar.mensagem });
  }

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
        encerrarSessao(cliente);
        return;

      case 'controle:remover': {
        if (!porId.has(msg.control)) return;
        try {
          gravarControles((lista) => lista.filter((c) => c.id !== msg.control));
          delete estado.valores[msg.control];
          delete estado.mutes[msg.control];
          anunciarControles();
        } catch (erro) {
          // controle:erro aparece na tela; learn:erro so dentro do assistente.
          enviarPara(cliente, { type: 'controle:erro', message: 'Nao consegui salvar: ' + erro.message });
        }
        return;
      }

      // So o nome muda: id, calibracao e o valor no fone continuam iguais.
      case 'controle:renomear': {
        const rotulo = typeof msg.label === 'string' ? msg.label.trim().slice(0, 40).trim() : '';
        if (!porId.has(msg.control)) {
          enviarPara(cliente, { type: 'controle:erro', message: 'Nao achei esse controle. Atualize a tela.' });
          return;
        }
        if (!rotulo) {
          enviarPara(cliente, { type: 'controle:erro', message: 'Escreva um nome para o controle.' });
          return;
        }
        try {
          gravarControles((lista) => lista.map((c) => (c.id === msg.control ? { ...c, rotulo } : c)));
        } catch (erro) {
          enviarPara(cliente, { type: 'controle:erro', message: 'Nao consegui salvar: ' + erro.message });
          return;
        }
        anunciarControles();
        return;
      }

      case 'gerar:canais':
        iniciarGeracao(cliente, msg);
        return;

      // Botao "Testar a mesa": descobre por qual porta e canal MIDI a mesa obedece.
      case 'mesa:testar':
        testarMesaPeloApp(cliente);
        return;

      case 'cena:nomear':
        nomearCena(cliente, msg);
        return;

      // Modo mapa: o celular escolhe o proprio fone (Aux 1 a 8) e mexe nele.
      case 'fone:escolher':
        escolherFone(cliente, msg);
        return;

      case 'fone:send':
        mexerNoFone(cliente, msg, 'valor');
        return;

      case 'fone:sendOn':
        mexerNoFone(cliente, msg, 'on');
        return;

      case 'fone:master':
        mexerNoFone(cliente, msg, 'master');
        return;

      case 'fone:masterOn':
        mexerNoFone(cliente, msg, 'masterOn');
        return;

      case 'mesa:sincronizar':
        sincronizarPeloApp(cliente);
        return;

      case 'atualizar:agora':
        atualizarAgora(cliente);
        return;

      // Escolher a porta da mesa pelo celular, para nunca precisar editar
      // arquivo na maquina do rack.
      case 'midi:portas': {
        const portas = listarPortas();
        enviarPara(cliente, {
          type: 'midi:portas',
          entradas: portas.entradas,
          saidas: portas.saidas,
          escolhida: cfg.midi.saida || null
        });
        return;
      }

      case 'midi:usar': {
        const escolha = typeof msg.porta === 'string' && msg.porta.trim() ? msg.porta.trim() : null;
        // No Windows a entrada e a saida podem ter nomes diferentes ("YAMAHA USB
        // IN 0-1" e "YAMAHA USB OUT 0-1"): se nenhuma entrada tem o nome
        // escolhido, a entrada volta para a procura automatica.
        const alvo = escolha ? escolha.toLowerCase() : null;
        const entrada = alvo && listarPortas().entradas.some((n) => n.toLowerCase().includes(alvo)) ? escolha : null;
        try {
          const atual = configArquivo.carregar();
          atual.midi.saida = escolha;
          atual.midi.entrada = entrada;
          configArquivo.salvar(atual);
        } catch (erro) {
          enviarPara(cliente, { type: 'learn:erro', message: 'Nao consegui salvar: ' + erro.message });
          return;
        }

        cfg.midi.saida = escolha;
        cfg.midi.entrada = entrada;

        interromperGeracao('a porta da mesa foi trocada');
        interromperReleitura('a porta da mesa foi trocada');
        interromperDescoberta('A porta da mesa foi trocada no meio do teste. Nada foi gravado.');
        interromperSincronia('A porta da mesa foi trocada no meio da leitura.');
        perderMapa('a porta da mesa foi trocada');
        reabrirPortas();

        console.log('[midi] porta escolhida pelo celular: ' + (escolha || 'automatica'));
        contarMidi(false);
        transmitirStatus();
        // Porta nova sem rota confirmada: testa a mesa nela (e le depois).
        pedirDescoberta('conexao');
        pedirSincronia('conexao');
        return;
      }

      // Devolver o mix quando a mesa liga, escolhido pelo celular, para
      // ninguem precisar editar o config.json no PC da mesa.
      case 'config:devolverMix': {
        const ligado = msg.ligado === true;
        try {
          const atual = configArquivo.carregar();
          atual.aplicarEstadoAoIniciar = ligado;
          configArquivo.salvar(atual);
        } catch (erro) {
          enviarPara(cliente, { type: 'learn:erro', message: 'Nao consegui salvar: ' + erro.message });
          return;
        }
        cfg.aplicarEstadoAoIniciar = ligado;
        transmitirStatus();
        return;
      }

      case 'ping':
        enviarPara(cliente, { type: 'pong' });
        return;
    }
  });

  cliente.on('close', () => {
    encerrarSessao(cliente);
    if (geracao && geracao.cliente === cliente) {
      console.log('[gerar] o celular que pediu saiu; termino e salvo o que a mesa confirmar');
    }
    console.log('[ws] celular saiu: ' + origem + ' (total: ' + wss.clients.size + ')');
  });

  cliente.on('error', (erro) => {
    encerrarSessao(cliente);
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

  // Mesa no cabo sem rota confirmada nesta saida: testa (o mix acima espera o
  // teste). Com rota conferida, le a mesa ja (modo mapa).
  pedirDescoberta('conexao');
  pedirSincronia('conexao');

  // Subiu no meio (ou no fim) de uma atualizacao pedida pelo app.
  retomarAtualizacao();
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
  if (descoberta) fecharTemporarias(descoberta);
  try { saidaMidi.fechar(); } catch { /* ignora */ }
  try { entradaMidi.fechar(); } catch { /* ignora */ }
  fecharEntradaDaResposta();
  for (const cliente of wss.clients) {
    try { cliente.close(1001, 'servidor encerrando'); } catch { /* ignora */ }
  }
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
