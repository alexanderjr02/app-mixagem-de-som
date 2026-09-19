'use strict';
/**
 * midi-io.js
 * Abertura das portas MIDI, com tres modos de funcionamento:
 *
 *   1. porta real   -> a 01V96 ligada por USB-MIDI ou interface MIDI
 *   2. porta virtual-> cria uma porta MIDI falsa no sistema (Linux e macOS),
 *                      util para testar com outro programa MIDI na mesma maquina
 *   3. simulado     -> nao toca em hardware nenhum, so imprime no terminal
 *
 * O modo simulado existe por dois motivos praticos: da para mexer na interface
 * do celular sem a mesa por perto, e o bridge nunca cai por causa de cabo solto.
 *
 * Obs: o pacote "midi" e nativo (precisa compilar). Se ele nao estiver
 * instalado, tudo aqui continua funcionando em modo simulado.
 */

const { paraHex } = require('./yamaha01v96');

/**
 * O pacote preferido e o @julusian/midi: e o mesmo RtMidi de sempre, mas ja
 * vem com o binario pronto para Windows, macOS, Linux e Raspberry Pi. Ou seja,
 * "npm install" funciona na maquina da mesa sem precisar de compilador.
 * O node-midi classico fica como alternativa, caso ja esteja instalado.
 */
let midi = null;
let erroMidi = null;
for (const pacote of ['@julusian/midi', 'midi']) {
  try {
    midi = require(pacote);
    erroMidi = null;
    break;
  } catch (erro) {
    erroMidi = erro;
  }
}

/** true se o pacote nativo esta disponivel nesta maquina. */
function midiDisponivel() {
  return midi !== null;
}

function mensagemErroMidi() {
  // So a primeira linha: o "Require stack" completo nao ajuda em nada no log.
  return erroMidi ? String(erroMidi.message).split('\n')[0] : null;
}

/** Lista as portas MIDI de entrada e de saida vistas pelo sistema. */
function listarPortas() {
  if (!midi) return { entradas: [], saidas: [] };

  const entrada = new midi.Input();
  const saida = new midi.Output();
  const entradas = [];
  const saidas = [];

  try {
    for (let i = 0; i < entrada.getPortCount(); i++) entradas.push(entrada.getPortName(i));
    for (let i = 0; i < saida.getPortCount(); i++) saidas.push(saida.getPortName(i));
  } finally {
    // Fechar mesmo sem abrir porta e seguro e libera o objeto nativo.
    try { entrada.closePort(); } catch { /* ignora */ }
    try { saida.closePort(); } catch { /* ignora */ }
  }

  return { entradas, saidas };
}

// Portas que nunca sao a mesa: eco interno do Linux e sintetizador do Windows.
const IGNORAR = [/midi through/i, /wavetable/i, /microsoft gs/i];

// Na duvida, esses nomes tem cara de 01V96.
const PREFERIDOS = [/01\s*v\s*96/i, /yamaha/i, /usb.*midi/i, /midi.*usb/i];

/**
 * Escolhe a porta sozinho, para nao ser preciso configurar nada na maquina da
 * mesa. Descarta as portas que nunca sao a mesa, prefere quem tem nome de
 * 01V96 e, se sobrar uma unica candidata, usa ela.
 */
function escolherAutomatica(nomes) {
  const candidatos = nomes
    .map((nome, indice) => ({ nome, indice }))
    .filter(({ nome }) => !IGNORAR.some((padrao) => padrao.test(nome)));

  for (const padrao of PREFERIDOS) {
    const achou = candidatos.find(({ nome }) => padrao.test(nome));
    if (achou) return achou.indice;
  }

  if (candidatos.length === 1) return candidatos[0].indice;
  return -1;
}

/**
 * Resolve o "spec" do config.json para um indice de porta.
 * Aceita numero (indice), texto (parte do nome, sem diferenciar maiuscula),
 * ou vazio, que significa "acha sozinho".
 * Devolve -1 se nao achou.
 */
function resolverIndice(spec, nomes) {
  if (typeof spec === 'number' && Number.isInteger(spec)) {
    return spec >= 0 && spec < nomes.length ? spec : -1;
  }
  if (typeof spec === 'string' && spec.trim() && spec !== 'auto') {
    const alvo = spec.trim().toLowerCase();
    const exato = nomes.findIndex((n) => n.toLowerCase() === alvo);
    if (exato >= 0) return exato;
    return nomes.findIndex((n) => n.toLowerCase().includes(alvo));
  }
  return escolherAutomatica(nomes);
}

/** true quando o config nao manda uma porta especifica. */
function ehAutomatico(spec) {
  return spec === null || spec === undefined || spec === '' || spec === 'auto';
}

/** Objeto de saida que so escreve no terminal, usado no modo simulado. */
function saidaSimulada(motivo) {
  let ultimo = 0;
  return {
    nome: 'simulado',
    simulado: true,
    motivo,
    enviar(bytes) {
      // Sem isso, arrastar um fader enche o terminal de linhas iguais.
      const agora = Date.now();
      if (agora - ultimo < 200) return;
      ultimo = agora;
      console.log('[midi simulado] ' + paraHex(bytes));
    },
    fechar() {}
  };
}

/**
 * Abre a porta de saida (o caminho celular -> mesa).
 * Nunca lanca excecao: se algo der errado, cai para o modo simulado e avisa.
 */
function abrirSaida(spec) {
  if (!midi) {
    return saidaSimulada('pacote MIDI nao instalado: ' + mensagemErroMidi());
  }
  if (spec === 'simulado') {
    return saidaSimulada('modo simulado pedido no config.json');
  }

  const porta = new midi.Output();

  try {
    if (spec === 'virtual') {
      porta.openVirtualPort('Monitor 01V96');
      return portaSaidaReal(porta, 'virtual: Monitor 01V96');
    }

    const nomes = [];
    for (let i = 0; i < porta.getPortCount(); i++) nomes.push(porta.getPortName(i));

    const indice = resolverIndice(spec, nomes);
    if (indice < 0) {
      try { porta.closePort(); } catch { /* ignora */ }
      const lista = nomes.length ? nomes.map((n, i) => i + '=' + n).join(', ') : 'nenhuma';
      return saidaSimulada(
        ehAutomatico(spec)
          ? 'nao achei a mesa nas portas MIDI. Disponiveis: ' + lista
          : 'porta de saida "' + spec + '" nao encontrada. Disponiveis: ' + lista
      );
    }

    porta.openPort(indice);
    return portaSaidaReal(porta, nomes[indice]);
  } catch (erro) {
    try { porta.closePort(); } catch { /* ignora */ }
    return saidaSimulada('falha ao abrir a saida MIDI: ' + erro.message);
  }
}

function portaSaidaReal(porta, nome) {
  return {
    nome,
    simulado: false,
    motivo: null,
    enviar(bytes) {
      try {
        porta.sendMessage(bytes);
      } catch (erro) {
        console.error('[midi] erro ao enviar:', erro.message);
      }
    },
    fechar() {
      try { porta.closePort(); } catch { /* ignora */ }
    }
  };
}

/**
 * Abre a porta de entrada (o caminho mesa -> bridge), usada para calibrar e
 * para acompanhar quando alguem mexe nos controles direto na mesa.
 * aoReceber recebe um array de bytes de cada mensagem SysEx.
 */
function abrirEntrada(spec, aoReceber) {
  const vazia = (motivo) => ({ nome: 'simulado', simulado: true, motivo, fechar() {} });

  if (!midi) return vazia('pacote MIDI nao instalado: ' + mensagemErroMidi());
  if (spec === 'simulado') return vazia('modo simulado pedido no config.json');

  const porta = new midi.Input();

  try {
    porta.on('message', (_deltaTime, mensagem) => {
      // So interessa SysEx (F0 ... F7). Relogio e note on nao servem aqui.
      if (mensagem.length > 2 && mensagem[0] === 0xf0) {
        try {
          aoReceber(Array.from(mensagem));
        } catch (erro) {
          console.error('[midi] erro tratando SysEx recebido:', erro.message);
        }
      }
    });

    if (spec === 'virtual') {
      porta.openVirtualPort('Monitor 01V96 IN');
      porta.ignoreTypes(false, true, true); // false = NAO ignorar SysEx
      return portaEntradaReal(porta, 'virtual: Monitor 01V96 IN');
    }

    const nomes = [];
    for (let i = 0; i < porta.getPortCount(); i++) nomes.push(porta.getPortName(i));

    const indice = resolverIndice(spec, nomes);
    if (indice < 0) {
      try { porta.closePort(); } catch { /* ignora */ }
      const lista = nomes.length ? nomes.map((n, i) => i + '=' + n).join(', ') : 'nenhuma';
      return vazia(
        ehAutomatico(spec)
          ? 'nao achei a mesa nas portas MIDI. Disponiveis: ' + lista
          : 'porta de entrada "' + spec + '" nao encontrada. Disponiveis: ' + lista
      );
    }

    porta.openPort(indice);
    porta.ignoreTypes(false, true, true);
    return portaEntradaReal(porta, nomes[indice]);
  } catch (erro) {
    try { porta.closePort(); } catch { /* ignora */ }
    return vazia('falha ao abrir a entrada MIDI: ' + erro.message);
  }
}

function portaEntradaReal(porta, nome) {
  return {
    nome,
    simulado: false,
    motivo: null,
    fechar() {
      try { porta.closePort(); } catch { /* ignora */ }
    }
  };
}

module.exports = {
  midiDisponivel,
  mensagemErroMidi,
  listarPortas,
  escolherAutomatica,
  abrirSaida,
  abrirEntrada
};
