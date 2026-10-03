'use strict';
/**
 * yamaha01v96.js
 * Tudo que envolve o "formato" das mensagens SysEx da mesa.
 *
 * Ideia central: NAO existe tabela de enderecos chumbada aqui. Os enderecos de
 * parametro da 01V96 mudam conforme firmware e configuracao, entao o programa
 * aprende cada controle observando a propria mesa (veja src/learn.js):
 *
 *   1. captura um quadro SysEx com o controle no MINIMO
 *   2. captura outro com o controle no MAXIMO
 *   3. compara os dois, acha em qual(is) byte(s) mora o valor
 *   4. guarda o quadro inteiro como "template" mais o offset do valor
 *
 * Em tempo real, para mandar 0..1 para a mesa, o programa copia o template e
 * escreve no lugar do valor o numero interpolado entre rawMin e rawMax.
 *
 * Codificacao do valor: MIDI so permite bytes de dados de 0 a 127 (7 bits),
 * entao um valor grande e quebrado em varios bytes, do mais significativo para
 * o menos significativo (big-endian de 7 bits).
 */

const INICIO_SYSEX = 0xf0;
const FIM_SYSEX = 0xf7;

/** Limita entre 0 e 1. */
function limitar01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Quebra um numero inteiro em N bytes de 7 bits, mais significativo primeiro. */
function codificarValor(valor, tamanho) {
  const maximo = Math.pow(128, tamanho) - 1;
  let n = Math.round(valor);
  if (n < 0) n = 0;
  if (n > maximo) n = maximo;

  const bytes = new Array(tamanho);
  for (let i = tamanho - 1; i >= 0; i--) {
    bytes[i] = n & 0x7f;
    n = Math.floor(n / 128);
  }
  return bytes;
}

/** Remonta o inteiro a partir dos bytes de 7 bits. */
function decodificarValor(bytes) {
  let n = 0;
  for (const b of bytes) n = n * 128 + (b & 0x7f);
  return n;
}

/** Converte 0..1 no valor cru que a mesa entende. */
function escalarParaRaw(valor01, rawMin, rawMax) {
  return Math.round(rawMin + (rawMax - rawMin) * limitar01(valor01));
}

/** Converte o valor cru vindo da mesa de volta para 0..1. */
function escalarParaNormalizado(raw, rawMin, rawMax) {
  if (rawMax === rawMin) return 0;
  return limitar01((raw - rawMin) / (rawMax - rawMin));
}

/** "F0 43 10 3E 0D F7" a partir de um array de bytes. */
function paraHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

/** Diz se o controle tem template calibrado e utilizavel. */
function estaCalibrado(controle) {
  return !!(
    controle &&
    controle.calibrado === true &&
    Array.isArray(controle.template) &&
    controle.template.length >= 3 &&
    Number.isInteger(controle.valueOffset) &&
    Number.isInteger(controle.valueLength) &&
    controle.valueLength > 0 &&
    Number.isFinite(controle.rawMin) &&
    Number.isFinite(controle.rawMax)
  );
}

/** Valida um template calibrado e devolve a lista de problemas encontrados. */
function validarControle(controle) {
  const problemas = [];
  if (!estaCalibrado(controle)) {
    problemas.push('controle sem calibracao completa');
    return problemas;
  }

  const t = controle.template;
  if (t[0] !== INICIO_SYSEX) problemas.push('template nao comeca com F0');
  if (t[t.length - 1] !== FIM_SYSEX) problemas.push('template nao termina com F7');

  const ini = controle.valueOffset;
  const fim = controle.valueOffset + controle.valueLength - 1;
  if (ini < 1 || fim >= t.length - 1) {
    problemas.push('a janela do valor cai fora do corpo do SysEx');
  }
  for (let i = 1; i < t.length - 1; i++) {
    if (t[i] > 0x7f) problemas.push('byte de dados invalido (maior que 0x7F) na posicao ' + i);
  }
  if (controle.rawMin === controle.rawMax) {
    problemas.push('rawMin e rawMax sao iguais, o fader nao teria efeito');
  }
  return problemas;
}

/**
 * Monta o quadro SysEx pronto para enviar, a partir do template do controle
 * e de um valor 0..1 vindo do celular.
 */
function montarFrame(controle, valor01) {
  if (!estaCalibrado(controle)) {
    throw new Error('Controle "' + controle.id + '" ainda nao foi calibrado');
  }
  const frame = controle.template.slice();
  const raw = escalarParaRaw(valor01, controle.rawMin, controle.rawMax);
  const bytes = codificarValor(raw, controle.valueLength);
  for (let i = 0; i < controle.valueLength; i++) {
    frame[controle.valueOffset + i] = bytes[i];
  }
  return frame;
}

/**
 * Se o quadro recebido da mesa pertence a este controle (mesmo endereco, so
 * o valor diferente), devolve o valor cru. Senao, devolve null.
 * Serve para o app acompanhar quando alguem mexe direto na mesa.
 */
function lerValorDoFrame(controle, frame) {
  if (!estaCalibrado(controle)) return null;
  const t = controle.template;
  if (frame.length !== t.length) return null;

  const ini = controle.valueOffset;
  const fim = ini + controle.valueLength;
  for (let i = 0; i < t.length; i++) {
    if (i >= ini && i < fim) continue; // posicao do valor: pode diferir
    if (frame[i] !== t[i]) return null; // endereco diferente: nao e este controle
  }
  return decodificarValor(frame.slice(ini, fim));
}

/**
 * Compara o quadro do MINIMO com o do MAXIMO e descobre onde mora o valor.
 * Devolve valueOffset, valueLength e os valores crus dos dois extremos.
 */
function compararFrames(frameMin, frameMax) {
  if (!Array.isArray(frameMin) || !Array.isArray(frameMax)) {
    throw new Error('Quadros invalidos para comparacao');
  }
  if (frameMin.length !== frameMax.length) {
    throw new Error(
      'Os dois quadros tem tamanhos diferentes (' +
        frameMin.length +
        ' e ' +
        frameMax.length +
        '). Provavelmente voce mexeu em controles diferentes na mesa.'
    );
  }

  const diferentes = [];
  for (let i = 0; i < frameMin.length; i++) {
    if (frameMin[i] !== frameMax[i]) diferentes.push(i);
  }

  if (diferentes.length === 0) {
    throw new Error(
      'Os dois quadros sao identicos. O controle nao chegou a mudar de valor entre as duas capturas.'
    );
  }

  const inicio = diferentes[0];
  const fim = diferentes[diferentes.length - 1];
  const tamanho = fim - inicio + 1;

  const avisos = [];
  if (tamanho !== diferentes.length) {
    avisos.push(
      'Os bytes que mudaram nao sao vizinhos. Assumi o bloco do offset ' +
        inicio +
        ' ao ' +
        fim +
        '. Se o fader ficar estranho, recalibre movendo so esse controle.'
    );
  }
  if (inicio === 0 || fim === frameMin.length - 1) {
    avisos.push('A mudanca encostou no F0 ou no F7, o que nao deveria acontecer.');
  }
  if (tamanho > 4) {
    avisos.push('Bloco de valor grande (' + tamanho + ' bytes). Confira se moveu so um controle.');
  }

  const rawMin = decodificarValor(frameMin.slice(inicio, fim + 1));
  const rawMax = decodificarValor(frameMax.slice(inicio, fim + 1));

  if (Math.abs(rawMax - rawMin) < 4) {
    avisos.push(
      'A diferenca entre minimo (' +
        rawMin +
        ') e maximo (' +
        rawMax +
        ') ficou bem pequena. Leve o controle ate os extremos de verdade.'
    );
  }

  return { valueOffset: inicio, valueLength: tamanho, rawMin, rawMax, avisos };
}

// ---------------------------------------------------------------------------
// Formato do manual (01V96 V2, Appendix C, p.313-314)
//
//   Parameter change:  F0 43 1n 3E 0D|7F tt ee pp cc dd.. F7
//   Parameter request: F0 43 3n 3E 0D|7F tt ee pp cc F7
//
// n = device number, cc = numero do canal. O manual NAO traz a tabela de
// enderecos (tt ee pp), entao eles continuam vindo da calibracao. Daqui so se
// usa o que o manual garante: onde fica o byte do canal e como pedir o valor
// atual de um endereco sem mudar nada na mesa.
// Suposicao a conferir na mesa: canal 1 = cc 0x00, ate o canal 32 = 0x1F.
// ---------------------------------------------------------------------------

const TOTAL_CANAIS = 32;
const POSICAO_CANAL = 8;

/**
 * O molde e um Parameter change no formato do manual (F0 43 1n 3E 0D|7F tt ee
 * pp cc dd.. F7), com o valor morando depois do byte cc? So assim da para
 * montar outro quadro do mesmo endereco sem chutar byte nenhum.
 */
function noFormatoDoManual(controle) {
  if (!estaCalibrado(controle)) return false;
  const t = controle.template;
  if (t.length < 11) return false;
  if (t[0] !== INICIO_SYSEX || t[t.length - 1] !== FIM_SYSEX) return false;
  if (t[1] !== 0x43 || (t[2] & 0xf0) !== 0x10 || t[3] !== 0x3e) return false;
  if (t[4] !== 0x0d && t[4] !== 0x7f) return false;
  for (let i = 5; i <= POSICAO_CANAL; i++) {
    if (!Number.isInteger(t[i]) || t[i] < 0 || t[i] > 0x7f) return false;
  }
  if (controle.valueOffset <= POSICAO_CANAL) return false;
  if (controle.valueOffset + controle.valueLength > t.length - 1) return false;
  return true;
}

/**
 * Canal (1 a 32) de um controle calibrado no formato do manual. Devolve null
 * se o molde nao tem esse formato, ou se o valor nao mora depois do byte do
 * canal: nesses casos nao da para trocar so o canal com seguranca.
 */
function canalDoControle(controle) {
  if (!noFormatoDoManual(controle)) return null;
  const t = controle.template;
  if (t[POSICAO_CANAL] > TOTAL_CANAIS - 1) return null;
  return t[POSICAO_CANAL] + 1;
}

function exigirCanal(controle, canal) {
  if (canalDoControle(controle) === null) {
    throw new Error('Controle "' + (controle && controle.id) + '" nao esta no formato do manual da 01V96');
  }
  if (!Number.isInteger(canal) || canal < 1 || canal > TOTAL_CANAIS) {
    throw new Error('Canal fora de 1 a ' + TOTAL_CANAIS + ': ' + canal);
  }
}

/**
 * O mesmo controle, mas em outro canal: copia a calibracao e troca so o byte
 * do canal. Leva apenas os campos de calibracao (id, rotulo e tipo sao de
 * quem chama).
 */
function controleParaCanal(controle, canal) {
  exigirCanal(controle, canal);
  const template = controle.template.slice();
  template[POSICAO_CANAL] = canal - 1;
  return {
    calibrado: true,
    template,
    valueOffset: controle.valueOffset,
    valueLength: controle.valueLength,
    rawMin: controle.rawMin,
    rawMax: controle.rawMax
  };
}

/**
 * Parameter request do endereco do controle naquele canal. A mesa responde
 * com um Parameter change do mesmo endereco trazendo o valor atual; pedir
 * nunca muda nada no som.
 */
function montarPedido(controle, canal) {
  exigirCanal(controle, canal);
  const t = controle.template;
  return [INICIO_SYSEX, 0x43, 0x30 | (t[2] & 0x0f), t[3], t[4], t[5], t[6], t[7], canal - 1, FIM_SYSEX];
}

/**
 * Parameter request do PROPRIO endereco do controle (qualquer tipo: canal,
 * reverb ou volume geral), para reler o valor atual sem mudar nada no som.
 * Devolve null se o molde nao esta no formato do manual: ai nao ha como
 * pedir com seguranca, e o controle simplesmente nao e relido.
 */
function montarPedidoDoControle(controle) {
  if (!noFormatoDoManual(controle)) return null;
  const t = controle.template;
  return [INICIO_SYSEX, 0x43, 0x30 | (t[2] & 0x0f), t[3], t[4], t[5], t[6], t[7], t[POSICAO_CANAL], FIM_SYSEX];
}

// ---------------------------------------------------------------------------
// Cenas (01V96 V2: p.209, p.219-220, p.289, p.307, p.314-315)
//
// Ao chamar uma cena, com PROGRAM CHANGE Tx ON, a mesa manda Program Change
// "Cn pp" no Tx CH. Tabela de fabrica: programa #1 a #99 = cenas 01 a 99 e
// #100 = cena 00. O byte pp vai de 0 a 127; aqui se supoe byte = # - 1
// (HIPOTESE, conferir na mesa pelo "bruto" no diagnostico do app).
//
// Quando o Program Change nao vale para a cena, a mesa manda o SysEx de funcao
// SCENE RECALL: F0 43 1n 3E 7F 10 01 mh ml ch cl F7, cena = mh*128 + ml.
// ---------------------------------------------------------------------------

const TOTAL_CENAS = 100; // 00 a 99

/** { numero, bruto } da cena chamada, pela tabela de fabrica, ou null. */
function cenaDoProgramChange(bytes) {
  if (!bytes || bytes.length !== 2) return null;
  const status = bytes[0];
  const programa = bytes[1];
  if (!Number.isInteger(status) || status < 0xc0 || status > 0xcf) return null;
  if (!Number.isInteger(programa) || programa < 0 || programa > 0x7f) return null;

  let numero;
  if (programa <= 98) numero = programa + 1; // #1..#99 = cenas 01..99
  else if (programa === 99) numero = 0; // #100 = cena 00
  else return null; // #101..#128 nao tem cena na tabela de fabrica
  return { numero, bruto: paraHex(bytes) };
}

// F0 43 1n 3E 7F 10 01: o byte 2 (1n) leva o device number e e conferido a parte.
const CABECALHO_RECALL = [INICIO_SYSEX, 0x43, null, 0x3e, 0x7f, 0x10, 0x01];
const TAMANHO_RECALL = 12;

/** Comeca como o SysEx de funcao SCENE RECALL (tamanho e numero nao conferidos). */
function pareceRecallDeCena(bytes) {
  if (!bytes || bytes.length < CABECALHO_RECALL.length) return false;
  if (!Number.isInteger(bytes[2]) || bytes[2] < 0x10 || bytes[2] > 0x1f) return false;
  return CABECALHO_RECALL.every((b, i) => b === null || bytes[i] === b);
}

/** Numero (0 a 99) da cena do SysEx de funcao SCENE RECALL, ou null. */
function cenaDoSysex(bytes) {
  if (!pareceRecallDeCena(bytes) || bytes.length !== TAMANHO_RECALL) return null;
  if (bytes[TAMANHO_RECALL - 1] !== FIM_SYSEX) return null;
  for (let i = CABECALHO_RECALL.length; i < TAMANHO_RECALL - 1; i++) {
    if (!Number.isInteger(bytes[i]) || bytes[i] < 0 || bytes[i] > 0x7f) return null;
  }
  const numero = bytes[7] * 128 + bytes[8];
  return numero < TOTAL_CENAS ? numero : null;
}

/** true se os dois controles apontam para o mesmo endereco (so o valor pode mudar). */
function mesmoEndereco(a, b) {
  if (!estaCalibrado(a) || !estaCalibrado(b)) return false;
  if (a.template.length !== b.template.length) return false;
  if (a.valueOffset !== b.valueOffset || a.valueLength !== b.valueLength) return false;

  const ini = a.valueOffset;
  const fim = ini + a.valueLength;
  for (let i = 0; i < a.template.length; i++) {
    if (i >= ini && i < fim) continue;
    if (a.template[i] !== b.template[i]) return false;
  }
  return true;
}

/** Monta o objeto de controle calibrado que vai para o config.json. */
function criarControle({ id, rotulo, tipo, valorInicial, frameMin, frameMax }) {
  const diff = compararFrames(frameMin, frameMax);

  // O template guarda o quadro do minimo inteiro. Em tempo real so os bytes
  // da janela do valor sao reescritos, o resto (endereco) vai igualzinho.
  const controle = {
    id,
    rotulo,
    tipo: tipo || 'canal',
    valorInicial: typeof valorInicial === 'number' ? valorInicial : 0.5,
    calibrado: true,
    template: frameMin.slice(),
    valueOffset: diff.valueOffset,
    valueLength: diff.valueLength,
    rawMin: diff.rawMin,
    rawMax: diff.rawMax
  };

  return { controle, avisos: diff.avisos };
}

module.exports = {
  INICIO_SYSEX,
  FIM_SYSEX,
  limitar01,
  codificarValor,
  decodificarValor,
  escalarParaRaw,
  escalarParaNormalizado,
  paraHex,
  estaCalibrado,
  validarControle,
  montarFrame,
  lerValorDoFrame,
  compararFrames,
  criarControle,
  TOTAL_CANAIS,
  canalDoControle,
  controleParaCanal,
  montarPedido,
  montarPedidoDoControle,
  mesmoEndereco,
  TOTAL_CENAS,
  cenaDoProgramChange,
  pareceRecallDeCena,
  cenaDoSysex
};
