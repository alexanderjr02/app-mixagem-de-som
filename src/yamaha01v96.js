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
  criarControle
};
