'use strict';
/**
 * config.js
 * Leitura e gravacao do config.json (portas, lista de controles calibrados)
 * e do estado.json (ultimos valores de cada fader).
 *
 * Na primeira execucao, se nao existir config.json, ele e criado a partir do
 * config.example.json. Assim da para abrir a interface e testar antes mesmo
 * de plugar na mesa.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');

// Onde ficam a calibracao e o ultimo mix. Normalmente e a pasta do programa.
// MONITOR_DADOS existe para os testes: sem ele, rodar "npm test" no Pi
// sobrescreveria a calibracao de verdade.
const DADOS = process.env.MONITOR_DADOS ? path.resolve(process.env.MONITOR_DADOS) : RAIZ;
const CAMINHO_CONFIG = path.join(DADOS, 'config.json');
const CAMINHO_EXEMPLO = path.join(RAIZ, 'config.example.json');
const CAMINHO_ESTADO = path.join(DADOS, 'estado.json');

/** Le um JSON do disco. Tira o BOM (U+FEFF) que o PowerShell 5 costuma gravar. */
function lerJson(arquivo) {
  const texto = fs.readFileSync(arquivo, 'utf8');
  return JSON.parse(texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto);
}

/**
 * Grava por arquivo temporario + rename: um kill no meio (queda de luz,
 * atualizacao) nunca deixa o arquivo pela metade.
 */
function gravarAtomico(arquivo, texto) {
  const tmp = arquivo + '.tmp';
  fs.writeFileSync(tmp, texto, 'utf8');
  fs.renameSync(tmp, arquivo);
}

// Valores usados quando a chave nao existe no arquivo.
const PADRAO = {
  servidor: { porta: 8080, host: '0.0.0.0' },
  midi: {
    entrada: null,
    saida: null,
    intervaloEnvioMs: 25,
    janelaEcoMs: 400,
    intervaloProcuraMs: 10000,
    // Quanto tempo esperar a mesa responder cada Parameter request ao criar canais.
    esperaRespostaMs: 300
  },
  aplicarEstadoAoIniciar: false,
  controles: []
};

/** Junta o objeto lido com os padroes, sem perder o que o usuario escreveu. */
function comPadroes(cfg) {
  return {
    ...PADRAO,
    ...cfg,
    servidor: { ...PADRAO.servidor, ...(cfg.servidor || {}) },
    midi: { ...PADRAO.midi, ...(cfg.midi || {}) },
    controles: Array.isArray(cfg.controles) ? cfg.controles : []
  };
}

/** Le config.json (criando a partir do exemplo se preciso). */
function carregar() {
  if (!fs.existsSync(CAMINHO_CONFIG)) {
    if (!fs.existsSync(CAMINHO_EXEMPLO)) {
      throw new Error('Nao achei config.json em ' + DADOS + ' nem config.example.json em ' + RAIZ);
    }
    fs.copyFileSync(CAMINHO_EXEMPLO, CAMINHO_CONFIG);
    console.log('[config] config.json criado a partir do config.example.json');
  }

  let bruto;
  try {
    bruto = lerJson(CAMINHO_CONFIG);
  } catch (erro) {
    throw new Error('config.json tem erro de sintaxe JSON: ' + erro.message);
  }

  const cfg = comPadroes(bruto);

  // Checagem basica de ids duplicados, que bagunçaria o estado e a interface.
  const vistos = new Set();
  for (const c of cfg.controles) {
    if (!c || typeof c.id !== 'string' || !c.id.trim()) {
      throw new Error('Existe controle sem "id" no config.json');
    }
    if (vistos.has(c.id)) {
      throw new Error('Id de controle repetido no config.json: ' + c.id);
    }
    vistos.add(c.id);
  }

  return cfg;
}

/** Grava config.json formatado, guardando uma copia do anterior em .bak */
function salvar(cfg) {
  if (fs.existsSync(CAMINHO_CONFIG)) {
    fs.copyFileSync(CAMINHO_CONFIG, CAMINHO_CONFIG + '.bak');
  }
  gravarAtomico(CAMINHO_CONFIG, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Le o ultimo mix salvo (e a ultima cena vista, se houver; quem usa confere
 * o conteudo). Nunca quebra: se der erro, volta vazio.
 */
function carregarEstado() {
  try {
    const dados = lerJson(CAMINHO_ESTADO);
    const estado = {
      valores: dados.valores && typeof dados.valores === 'object' ? dados.valores : {},
      mutes: dados.mutes && typeof dados.mutes === 'object' ? dados.mutes : {}
    };
    if (dados.cena && typeof dados.cena === 'object') estado.cena = dados.cena;
    return estado;
  } catch {
    return { valores: {}, mutes: {} };
  }
}

/** Grava o mix atual. Erro aqui nao pode derrubar o bridge. */
function salvarEstado(estado) {
  try {
    gravarAtomico(CAMINHO_ESTADO, JSON.stringify(estado, null, 2) + '\n');
  } catch (erro) {
    console.warn('[config] nao consegui salvar estado.json:', erro.message);
  }
}

/** Transforma "Voz Principal" em "voz-principal", para virar id de controle. */
function gerarId(rotulo) {
  return (
    String(rotulo || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'controle'
  );
}

/** Garante um id unico dentro da lista (bumbo, bumbo-2, bumbo-3...). */
function idUnico(rotulo, controles, idAtual) {
  const base = gerarId(rotulo);
  let id = base;
  let n = 2;
  while (controles.some((c) => c.id === id && c.id !== idAtual)) {
    id = base + '-' + n++;
  }
  return id;
}

module.exports = {
  RAIZ,
  DADOS,
  lerJson,
  CAMINHO_CONFIG,
  gerarId,
  idUnico,
  CAMINHO_ESTADO,
  carregar,
  salvar,
  carregarEstado,
  salvarEstado
};
