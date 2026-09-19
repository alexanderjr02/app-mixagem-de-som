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

let midi = null;
let erroMidi = null;
try {
  midi = require('midi');
} catch (erro) {
  erroMidi = erro;
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

/**
 * Resolve o "spec" do config.json para um indice de porta.
 * Aceita numero (indice) ou texto (parte do nome, sem diferenciar maiuscula).
 * Devolve -1 se nao achou.
 */
function resolverIndice(spec, nomes) {
  if (typeof spec === 'number' && Number.isInteger(spec)) {
    return spec >= 0 && spec < nomes.length ? spec : -1;
  }
  if (typeof spec === 'string' && spec.trim()) {
    const alvo = spec.trim().toLowerCase();
    const exato = nomes.findIndex((n) => n.toLowerCase() === alvo);
    if (exato >= 0) return exato;
    return nomes.findIndex((n) => n.toLowerCase().includes(alvo));
  }
  return -1;
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
    return saidaSimulada('pacote "midi" nao instalado: ' + mensagemErroMidi());
  }
  if (spec === 'simulado' || spec === null || spec === undefined || spec === '') {
    return saidaSimulada('nenhuma porta de saida configurada em config.json (midi.saida)');
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
      return saidaSimulada(
        'porta de saida "' + spec + '" nao encontrada. Disponiveis: ' +
          (nomes.length ? nomes.map((n, i) => i + '=' + n).join(', ') : 'nenhuma')
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

  if (!midi) return vazia('pacote "midi" nao instalado: ' + mensagemErroMidi());
  if (spec === 'simulado' || spec === null || spec === undefined || spec === '') {
    return vazia('nenhuma porta de entrada configurada em config.json (midi.entrada)');
  }

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
      return vazia(
        'porta de entrada "' + spec + '" nao encontrada. Disponiveis: ' +
          (nomes.length ? nomes.map((n, i) => i + '=' + n).join(', ') : 'nenhuma')
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
  abrirSaida,
  abrirEntrada
};
