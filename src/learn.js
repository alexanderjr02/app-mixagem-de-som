'use strict';
/**
 * learn.js
 * "npm run learn": calibracao guiada.
 *
 * Por que isso existe: os enderecos SysEx de parametro da 01V96 mudam conforme
 * a versao de firmware. Em vez de chutar bytes (e correr o risco de mexer no
 * parametro errado da mesa), o programa aprende observando.
 *
 * Para cada controle voce faz isto, uma vez na vida:
 *   1. da um nome (ex: Bumbo)
 *   2. leva o controle da MESA ate o minimo e aperta Enter
 *   3. leva ate o maximo e aperta Enter
 *
 * O programa compara os dois quadros SysEx, descobre onde fica o byte do valor
 * e salva o molde no config.json. Dai em diante o celular manda esse molde com
 * o valor trocado.
 *
 * IMPORTANTE: o controle que voce move na mesa e o SEND daquele canal para o
 * Aux do seu fone (ex: Aux 1), nao o fader do canal. Segure a tecla AUX 1 e
 * mexa no fader do canal, ou entre na pagina Aux Send do display.
 */

const readline = require('readline');
const configArquivo = require('./config');
const { listarPortas, abrirEntrada, midiDisponivel, mensagemErroMidi } = require('./midi-io');
const mesa = require('./yamaha01v96');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function pergunta(texto) {
  return new Promise((resolve) => rl.question(texto, (r) => resolve(r.trim())));
}

/** Transforma "Voz Principal" em "voz-principal", para virar id. */
function gerarId(rotulo) {
  return rotulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'controle';
}

// Guarda o ultimo SysEx recebido. A mesa manda um por passo do fader, entao o
// ultimo antes do Enter e o valor em que o controle parou.
const coletor = { ultimo: null, contagem: 0 };

function zerarColetor() {
  coletor.ultimo = null;
  coletor.contagem = 0;
}

function aoReceber(bytes) {
  coletor.ultimo = bytes;
  coletor.contagem++;
}

function linha() {
  console.log('-'.repeat(64));
}

/** Passo de captura: espera o Enter e devolve o quadro capturado. */
async function capturar(instrucao) {
  while (true) {
    zerarColetor();
    await pergunta(instrucao + '\n  (depois aperte Enter) ');

    if (!coletor.ultimo) {
      console.log('');
      console.log('  Nenhuma mensagem SysEx chegou. Verifique na 01V96:');
      console.log('   - MIDI / Setup: Parameter Change TX ligado');
      console.log('   - porta MIDI definida como USB (ou MIDI, conforme sua ligacao)');
      console.log('   - Device ID (ou Ch) anotado, sempre o mesmo');
      console.log('  E confirme que voce moveu mesmo o controle na mesa.');
      const tentar = await pergunta('  Tentar de novo? (S/n) ');
      if (tentar.toLowerCase() === 'n') return null;
      continue;
    }

    console.log('  capturado: ' + mesa.paraHex(coletor.ultimo) + '  (' + coletor.contagem + ' mensagens)');
    return coletor.ultimo;
  }
}

/** Calibra um controle e devolve o objeto pronto para o config.json. */
async function calibrarControle(rotuloSugerido, idSugerido, tipoSugerido, valorInicial) {
  const rotulo = (await pergunta('Rotulo que aparece no celular' +
    (rotuloSugerido ? ' (Enter = "' + rotuloSugerido + '")' : '') + ': ')) || rotuloSugerido;
  if (!rotulo) {
    console.log('Rotulo vazio, cancelando este controle.');
    return null;
  }

  const idPadrao = idSugerido || gerarId(rotulo);
  const id = (await pergunta('Id interno (Enter = "' + idPadrao + '"): ')) || idPadrao;

  const tipoPadrao = tipoSugerido || 'canal';
  const tipoDigitado = await pergunta(
    'Tipo: canal, reverb ou master (Enter = "' + tipoPadrao + '"): '
  );
  const tipo = ['canal', 'reverb', 'master'].includes(tipoDigitado) ? tipoDigitado : tipoPadrao;

  console.log('');
  console.log('Agora mexa na MESA, no controle "' + rotulo + '".');
  console.log('Lembre: e o SEND desse canal para o Aux do seu fone, nao o fader do PA.');
  console.log('');

  const frameMin = await capturar('  1) Leve o controle ate o MINIMO (tudo embaixo).');
  if (!frameMin) return null;

  const frameMax = await capturar('  2) Agora leve ate o MAXIMO (tudo em cima).');
  if (!frameMax) return null;

  let resultado;
  try {
    resultado = mesa.criarControle({
      id,
      rotulo,
      tipo,
      valorInicial: typeof valorInicial === 'number' ? valorInicial : 0.5,
      frameMin,
      frameMax
    });
  } catch (erro) {
    console.log('');
    console.log('  Nao consegui aprender: ' + erro.message);
    return null;
  }

  const c = resultado.controle;
  console.log('');
  console.log('  Aprendido:');
  console.log('    molde ......... ' + mesa.paraHex(c.template));
  console.log('    valor no byte . offset ' + c.valueOffset + ', ' + c.valueLength + ' byte(s)');
  console.log('    faixa ......... ' + c.rawMin + ' ate ' + c.rawMax);
  for (const aviso of resultado.avisos) console.log('    atencao ....... ' + aviso);
  console.log('');

  const ok = await pergunta('  Guardar este controle? (S/n) ');
  if (ok.toLowerCase() === 'n') return null;
  return c;
}

async function main() {
  console.log('');
  linha();
  console.log('Calibracao guiada do monitor pessoal 01V96');
  linha();

  if (!midiDisponivel()) {
    console.log('');
    console.log('O pacote nativo "midi" nao esta disponivel: ' + mensagemErroMidi());
    console.log('No Raspberry Pi:');
    console.log('  sudo apt install -y build-essential libasound2-dev');
    console.log('  npm install');
    rl.close();
    process.exit(1);
  }

  const cfg = configArquivo.carregar();
  const { entradas, saidas } = listarPortas();

  if (!entradas.length) {
    console.log('');
    console.log('Nenhuma entrada MIDI encontrada. A mesa esta ligada e o cabo USB conectado?');
    rl.close();
    process.exit(1);
  }

  console.log('');
  console.log('Entradas MIDI (mesa -> Pi):');
  entradas.forEach((nome, i) => console.log('  [' + i + '] ' + nome));

  const sugeridaIn = cfg.midi.entrada;
  const respostaIn = await pergunta(
    '\nQual entrada?' + (sugeridaIn != null ? ' (Enter = "' + sugeridaIn + '")' : '') + ' '
  );
  const escolhaIn = !respostaIn && sugeridaIn != null
    ? sugeridaIn
    : (/^\d+$/.test(respostaIn) ? Number(respostaIn) : respostaIn);

  const entrada = abrirEntrada(escolhaIn, aoReceber);
  if (entrada.simulado) {
    console.log('Nao consegui abrir a entrada: ' + entrada.motivo);
    rl.close();
    process.exit(1);
  }
  console.log('Escutando "' + entrada.nome + '".');

  // A saida nao e usada na calibracao, mas ja aproveitamos para gravar no config.
  if (saidas.length) {
    console.log('');
    console.log('Saidas MIDI (Pi -> mesa):');
    saidas.forEach((nome, i) => console.log('  [' + i + '] ' + nome));
    const sugeridaOut = cfg.midi.saida;
    const respostaOut = await pergunta(
      '\nQual saida?' + (sugeridaOut != null ? ' (Enter = "' + sugeridaOut + '")' : '') + ' '
    );
    if (respostaOut || sugeridaOut != null) {
      const escolhaOut = !respostaOut && sugeridaOut != null
        ? sugeridaOut
        : (/^\d+$/.test(respostaOut) ? saidas[Number(respostaOut)] : respostaOut);
      cfg.midi.saida = escolhaOut;
    }
  }

  cfg.midi.entrada = typeof escolhaIn === 'number' ? entradas[escolhaIn] : escolhaIn;

  // ---- menu principal -----------------------------------------------------
  let sair = false;
  while (!sair) {
    console.log('');
    linha();
    console.log('Controles no config.json:');
    if (!cfg.controles.length) console.log('  (nenhum)');
    cfg.controles.forEach((c, i) => {
      const marca = mesa.estaCalibrado(c) ? 'calibrado' : 'sem calibrar';
      console.log('  [' + i + '] ' + (c.rotulo || c.id).padEnd(18) + tipoCurto(c) + '  ' + marca);
    });
    linha();
    console.log('  1  calibrar o proximo controle sem calibracao');
    console.log('  2  calibrar / recalibrar um controle pelo numero');
    console.log('  3  adicionar um controle novo');
    console.log('  4  remover um controle');
    console.log('  5  salvar e sair');
    console.log('  6  sair sem salvar');

    const opcao = await pergunta('\nOpcao: ');

    if (opcao === '1') {
      const alvo = cfg.controles.find((c) => !mesa.estaCalibrado(c));
      if (!alvo) {
        console.log('Todos os controles ja estao calibrados.');
        continue;
      }
      const novo = await calibrarControle(alvo.rotulo, alvo.id, alvo.tipo, alvo.valorInicial);
      if (novo) substituir(cfg, novo);
    } else if (opcao === '2') {
      const n = Number(await pergunta('Numero do controle: '));
      const alvo = cfg.controles[n];
      if (!alvo) {
        console.log('Numero invalido.');
        continue;
      }
      const novo = await calibrarControle(alvo.rotulo, alvo.id, alvo.tipo, alvo.valorInicial);
      if (novo) substituir(cfg, novo);
    } else if (opcao === '3') {
      const novo = await calibrarControle('', '', 'canal', 0.5);
      if (novo) substituir(cfg, novo);
    } else if (opcao === '4') {
      const n = Number(await pergunta('Numero do controle a remover: '));
      if (cfg.controles[n]) {
        const [fora] = cfg.controles.splice(n, 1);
        console.log('Removido: ' + (fora.rotulo || fora.id));
      } else {
        console.log('Numero invalido.');
      }
    } else if (opcao === '5') {
      configArquivo.salvar(cfg);
      console.log('');
      console.log('config.json salvo (copia do anterior em config.json.bak).');
      console.log('Agora rode: npm start');
      sair = true;
    } else if (opcao === '6') {
      const certeza = await pergunta('Sair sem salvar? (s/N) ');
      if (certeza.toLowerCase() === 's') sair = true;
    }
  }

  entrada.fechar();
  rl.close();
  process.exit(0);
}

function tipoCurto(c) {
  const t = c.tipo || 'canal';
  return t === 'master' ? '(volume geral)' : t === 'reverb' ? '(reverb)      ' : '(canal)       ';
}

/** Coloca o controle no lugar do antigo de mesmo id, ou adiciona no fim. */
function substituir(cfg, controle) {
  const i = cfg.controles.findIndex((c) => c.id === controle.id);
  if (i >= 0) cfg.controles[i] = controle;
  else cfg.controles.push(controle);
  console.log('Controle "' + controle.rotulo + '" pronto.');
}

main().catch((erro) => {
  console.error('\nErro: ' + erro.message);
  rl.close();
  process.exit(1);
});
