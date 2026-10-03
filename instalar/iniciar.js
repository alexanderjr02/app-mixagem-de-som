'use strict';
/**
 * Lancador do Monitor 01V96 (PC Windows da igreja).
 *
 * Fica na pasta de dados da instalacao (%LOCALAPPDATA%\Monitor01V96), ao lado
 * de config.json e estado.json. O codigo do programa mora em versoes\<sha>\ e
 * nunca e alterado depois de pronto; este arquivo so escolhe qual versao rodar:
 *
 *   node iniciar.js            liga o bridge (o que o Windows abre no logon)
 *   node iniciar.js atualizar  roda uma vez o atualizador (a Tarefa Agendada)
 *
 * Escolha da versao: "atual" do atualizacao.json; se a pasta nao existe,
 * "anterior"; se tambem nao, a versao valida mais nova. Assim uma troca
 * interrompida nunca deixa o programa sem rodar.
 *
 * Este arquivo e pequeno e estavel de proposito: o instalador o grava e o
 * atualizador so o troca por arquivo temporario + rename.
 */

const fs = require('fs');
const path = require('path');

const INST = __dirname;

// Sempre a pasta de dados desta instalacao, mesmo que o ambiente tenha outra.
process.env.MONITOR_DADOS = INST;

const SHA = /^[0-9a-f]{40}$/;

function lerJson(arquivo) {
  const texto = fs.readFileSync(arquivo, 'utf8');
  return JSON.parse(texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto);
}

function versaoValida(sha) {
  return typeof sha === 'string' && SHA.test(sha) &&
    fs.existsSync(path.join(INST, 'versoes', sha, 'src', 'bridge.js'));
}

function escolherVersao() {
  let estado = {};
  try { estado = lerJson(path.join(INST, 'atualizacao.json')); } catch { /* sem arquivo */ }
  for (const sha of [estado.atual, estado.anterior]) {
    if (versaoValida(sha)) return sha;
  }
  try {
    const pasta = path.join(INST, 'versoes');
    const nomes = fs.readdirSync(pasta).filter(versaoValida);
    nomes.sort((a, b) => fs.statSync(path.join(pasta, b)).mtimeMs - fs.statSync(path.join(pasta, a)).mtimeMs);
    return nomes[0] || null;
  } catch {
    return null;
  }
}

const sha = escolherVersao();
if (!sha) {
  console.error('Nao achei nenhuma versao do programa em ' + path.join(INST, 'versoes'));
  console.error('Rode o instalador de novo.');
  process.exit(1);
}

const raiz = path.join(INST, 'versoes', sha);

function registrar(texto) {
  try { fs.appendFileSync(path.join(INST, 'atualizacao.log'), new Date().toISOString() + ' ' + texto + '\n'); } catch { /* sem log */ }
}

if (process.argv[2] === 'atualizar') {
  process.env.MONITOR_INSTALACAO = INST;
  // O atualizador da versao atual; se ele nem carregar (arquivo quebrado), o da
  // anterior, para a instalacao nunca ficar sem conseguir se corrigir.
  let estado = {};
  try { estado = lerJson(path.join(INST, 'atualizacao.json')); } catch { /* sem arquivo */ }
  const candidatos = [sha, estado.atual, estado.anterior].filter((x, i, v) => versaoValida(x) && v.indexOf(x) === i);
  let modulo = null;
  for (const v of candidatos) {
    try {
      modulo = require(path.join(INST, 'versoes', v, 'src', 'atualizar.js'));
      if (v !== candidatos[0]) registrar('atualizador da versao ' + candidatos[0].slice(0, 7) + ' nao carregou; usei o da ' + v.slice(0, 7));
      break;
    } catch (erro) {
      registrar('atualizador da versao ' + v.slice(0, 7) + ' nao carregou: ' + String(erro && erro.message).split('\n')[0].slice(0, 120));
    }
  }
  if (modulo) modulo.main().then(() => { process.exitCode = 0; }, () => { process.exitCode = 0; });
} else {
  try { fs.writeFileSync(path.join(INST, 'bridge.pid'), String(process.pid)); } catch { /* so ajuda a atualizacao */ }
  require(path.join(raiz, 'src', 'bridge.js'));
}
