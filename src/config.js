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
const CAMINHO_CONFIG = path.join(RAIZ, 'config.json');
const CAMINHO_EXEMPLO = path.join(RAIZ, 'config.example.json');
const CAMINHO_ESTADO = path.join(RAIZ, 'estado.json');

// Valores usados quando a chave nao existe no arquivo.
const PADRAO = {
  servidor: { porta: 8080, host: '0.0.0.0' },
  midi: { entrada: null, saida: null, intervaloEnvioMs: 25, janelaEcoMs: 400 },
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
      throw new Error('Nao achei config.json nem config.example.json em ' + RAIZ);
    }
    fs.copyFileSync(CAMINHO_EXEMPLO, CAMINHO_CONFIG);
    console.log('[config] config.json criado a partir do config.example.json');
  }

  let bruto;
  try {
    bruto = JSON.parse(fs.readFileSync(CAMINHO_CONFIG, 'utf8'));
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
  fs.writeFileSync(CAMINHO_CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** Le o ultimo mix salvo. Nunca quebra: se der erro, volta vazio. */
function carregarEstado() {
  try {
    const dados = JSON.parse(fs.readFileSync(CAMINHO_ESTADO, 'utf8'));
    return {
      valores: dados.valores && typeof dados.valores === 'object' ? dados.valores : {},
      mutes: dados.mutes && typeof dados.mutes === 'object' ? dados.mutes : {}
    };
  } catch {
    return { valores: {}, mutes: {} };
  }
}

/** Grava o mix atual. Erro aqui nao pode derrubar o bridge. */
function salvarEstado(estado) {
  try {
    fs.writeFileSync(CAMINHO_ESTADO, JSON.stringify(estado, null, 2) + '\n', 'utf8');
  } catch (erro) {
    console.warn('[config] nao consegui salvar estado.json:', erro.message);
  }
}

module.exports = {
  RAIZ,
  CAMINHO_CONFIG,
  CAMINHO_ESTADO,
  carregar,
  salvar,
  carregarEstado,
  salvarEstado
};
