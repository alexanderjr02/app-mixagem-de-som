'use strict';
/**
 * Atualizacao automatica do Monitor 01V96 (PC Windows da igreja).
 *
 * Roda UMA vez e sai. Quem chama e a Tarefa Agendada "Monitor 01V96", criada
 * pelo instalador, por `node iniciar.js atualizar`.
 *
 * Layout da instalacao (INST = %LOCALAPPDATA%\Monitor01V96 = pasta de DADOS):
 *   config.json, config.json.bak, estado.json   calibracao e mix (nunca tocados)
 *   atualizacao.json / .log / .lock, bridge.pid  estado desta atualizacao
 *   iniciar.js                                   lancador pequeno e estavel
 *   versoes\<sha>\                               codigo + node_modules, IMUTAVEL
 *
 * Versoes imutaveis + ponteiro: trocar de versao e so mudar `atual` no
 * atualizacao.json (por arquivo temporario + rename). A versao antiga continua
 * inteira em `anterior`, entao voltar e mudar o ponteiro de volta. Uma queda
 * no meio da troca deixa `emTroca` no arquivo e a proxima execucao se recupera.
 *
 * A cada execucao:
 *   1. trava (so uma por vez);
 *   2. vigia: se o bridge esta FORA do ar (conexao recusada 2 vezes seguidas),
 *      liga. Timeout ou resposta estranha = incerto: nao mexe;
 *   3. consulta o ramo `igreja` no GitHub (no maximo a cada 6 h; falhas de
 *      rede esperam cada vez mais);
 *   4. SO quando e seguro (mesa desligada e 0 celulares, ou bridge fora):
 *      baixa, extrai, instala dependencias e roda os testes em
 *      versoes\<sha>.preparando; so depois renomeia para versoes\<sha>;
 *   5. troca (tambem so quando e seguro), espera o bridge novo responder e,
 *      se nao subir, volta o ponteiro.
 *
 * Nada de segredo. So fala com api.github.com e codeload.github.com, por
 * HTTPS, sem seguir redirecionamento.
 *
 * Variaveis de ambiente que so valem com MONITOR_TESTE=1:
 *   MONITOR_ATUALIZAR_API / MONITOR_ATUALIZAR_ZIP  bases no lugar do GitHub
 *   MONITOR_ATUALIZAR_ESPERA_MS                    espera do bridge novo (45000)
 *   MONITOR_ATUALIZAR_PAUSA_MS                     pausa entre as 2 sondagens (2000)
 *   MONITOR_ATUALIZAR_UPTIME_S                     segundos desde que o PC ligou (os.uptime())
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = 'alexanderjr02/app-mixagem-de-som';
const RAMO = 'igreja';
const API_PADRAO = 'https://api.github.com/repos/' + REPO;
const ZIP_PADRAO = 'https://codeload.github.com/' + REPO;
const HOSTS_PERMITIDOS = new Set(['api.github.com', 'codeload.github.com']);

const HORA = 60 * 60 * 1000;
const INTERVALO_CONSULTA_MS = 6 * HORA;
const LOCK_VELHO_MS = 30 * 60 * 1000;
const LIMITE_DOWNLOAD = 50 * 1024 * 1024;
const LIMITE_LOG_LINHAS = 300;
const MAX_RECUSADAS = 50;
const MAX_TENTATIVAS = 3;
const TESTES_TETO_MS = 10 * 60 * 1000;
const PC_ACABOU_DE_LIGAR_S = 10 * 60;

const TESTE = process.env.MONITOR_TESTE === '1';

/** Texto curto e fixo que vai para o status (nunca mensagem de erro nem caminho). */
const RESULTADO = {
  emDia: 'em dia',
  semRede: 'sem rede, tento depois',
  limiteApi: 'limite da API, tento depois',
  esperando: 'versao nova pronta, esperando a mesa desligar',
  esperandoSeguro: 'versao nova achada, esperando a mesa desligar',
  recusada: 'versao nova recusada',
  falhaPreparo: 'falha ao preparar, tento de novo',
  voltou: 'versao nova nao subiu, voltei a anterior',
  soWindows: 'atualizacao automatica so no Windows'
};

/** Arquivos de dados da instalacao: o atualizador nunca os copia, troca ou apaga. */
const DADOS_PROTEGIDOS = new Set([
  'config.json', 'config.json.bak', 'estado.json',
  'atualizacao.json', 'atualizacao.log', 'atualizacao.lock', 'bridge.pid'
]);

/* ---- funcoes puras (testadas) ---------------------------------------- */

function shaValido(texto) {
  return typeof texto === 'string' && /^[0-9a-f]{40}$/.test(texto);
}

/** Passou tempo suficiente desde a ultima consulta? */
function deveConsultar(ultimaConsulta, agora = Date.now(), intervalo = INTERVALO_CONSULTA_MS) {
  if (!ultimaConsulta) return true;
  const t = typeof ultimaConsulta === 'number' ? ultimaConsulta : Date.parse(ultimaConsulta);
  if (!Number.isFinite(t)) return true;
  if (t > agora) return true; // relogio voltou: nao fica sem consultar para sempre
  return agora - t >= intervalo;
}

/** Espera entre consultas: 6 h normalmente; depois de falha de rede, 30 min, 1 h, 2 h, 4 h, ate 6 h. */
function intervaloConsulta(falhas) {
  if (!(falhas > 0)) return INTERVALO_CONSULTA_MS;
  return Math.min(INTERVALO_CONSULTA_MS, 30 * 60 * 1000 * 2 ** (Math.min(falhas, 10) - 1));
}

/**
 * Pode trocar o programa (ou preparar a versao nova) agora?
 * `status` e o JSON de /api/status; null = bridge FORA do ar (conexao recusada);
 * qualquer outra coisa (inclusive undefined = incerto) = na duvida, nao.
 */
function seguroAplicar(status) {
  if (status === null) return true;
  if (!status || typeof status !== 'object') return false;
  return Boolean(status.midi) && status.midi.simulado === true && status.clientes === 0;
}

/** Nome de pasta que o atualizador cria dentro de versoes\ (e so esses ele apaga). */
function nomeDeVersao(nome) {
  return /^[0-9a-f]{40}(\.(preparando|extraindo|zip))?$/.test(nome);
}

/** Dos nomes em versoes\, quais apagar: so os do atualizador que nao estao em uso. */
function versoesParaApagar(nomes, manter) {
  const guardar = new Set(manter.filter(Boolean));
  return nomes.filter((n) => nomeDeVersao(n) && !guardar.has(n));
}

/** So ECONNREFUSED (porta fechada) conta como "fora do ar". */
function conexaoRecusada(erro) {
  const causa = erro && erro.cause;
  if (!causa) return Boolean(erro && erro.code === 'ECONNREFUSED');
  if (causa.code === 'ECONNREFUSED') return true;
  return Array.isArray(causa.errors) && causa.errors.length > 0 && causa.errors.every((e) => e && e.code === 'ECONNREFUSED');
}

/**
 * Anota uma falha da versao `sha`. Definitiva recusa na hora; transitoria
 * conta tentativa e recusa na 3a. Devolve 'recusada' ou 'tentar-de-novo'.
 */
function registrarFalha(e, sha, definitiva) {
  const n = (e.tentativas[sha] || 0) + (definitiva ? 0 : 1);
  if (definitiva || n >= MAX_TENTATIVAS) {
    if (!e.recusadas.includes(sha)) e.recusadas.push(sha);
    e.recusadas = e.recusadas.slice(-MAX_RECUSADAS);
    delete e.tentativas[sha];
    if (e.alvo === sha) e.alvo = null;
    if (e.preparada === sha) e.preparada = null;
    return 'recusada';
  }
  e.tentativas[sha] = n;
  return 'tentar-de-novo';
}

/** O processo e o bridge desta instalacao (`node ...\iniciar.js` sem argumento)? */
function casaBridge(linhaDeComando, instalacao) {
  if (typeof linhaDeComando !== 'string') return false;
  const alvo = path.join(instalacao, 'iniciar.js').toLowerCase();
  const linha = linhaDeComando.toLowerCase().replace(/"/g, ' ');
  const i = linha.indexOf(alvo);
  if (i < 0) return false;
  if (i > 0 && !/\s/.test(linha[i - 1])) return false;
  const resto = linha.slice(i + alvo.length);
  if (resto.length > 0 && !/^\s/.test(resto)) return false; // iniciar.js.bak e parecidos
  return !/^\s*atualizar(\s|$)/.test(resto);
}

/** Em producao so HTTPS e so os hosts do GitHub; overrides so com MONITOR_TESTE=1. */
function urlPermitida(url, sobrescrita = false) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (sobrescrita) return TESTE && (u.protocol === 'http:' || u.protocol === 'https:');
  return u.protocol === 'https:' && HOSTS_PERMITIDOS.has(u.hostname) && !u.username && !u.password;
}

/** Nomes das entradas de um zip, lidos do diretorio central. null se invalido ou zip64. */
function listarEntradasZip(buf) {
  const FIM = 0x06054b50;
  let i = buf.length - 22;
  const minimo = Math.max(0, buf.length - 22 - 65535);
  while (i >= minimo && buf.readUInt32LE(i) !== FIM) i--;
  if (i < minimo) return null;
  if (i >= 20 && buf.readUInt32LE(i - 20) === 0x07064b50) return null; // localizador zip64
  const total = buf.readUInt16LE(i + 10);
  let pos = buf.readUInt32LE(i + 16);
  if (total === 0xffff || pos === 0xffffffff) return null;
  const nomes = [];
  for (let n = 0; n < total; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) return null;
    const tam = buf.readUInt16LE(pos + 28);
    const extra = buf.readUInt16LE(pos + 30);
    const coment = buf.readUInt16LE(pos + 32);
    if (pos + 46 + tam > buf.length) return null;
    nomes.push(buf.toString('utf8', pos + 46, pos + 46 + tam));
    pos += 46 + tam + extra + coment;
  }
  return nomes;
}

/**
 * Nenhuma entrada pode sair da pasta de destino (zip-slip), ter ':' (letra de
 * unidade, fluxo alternativo NTFS) e, se `sha` vier, tudo tem que estar dentro
 * da pasta de topo `app-mixagem-de-som-<sha>`.
 */
function entradasSeguras(nomes, sha) {
  if (!Array.isArray(nomes) || nomes.length === 0) return false;
  const topo = sha ? 'app-mixagem-de-som-' + sha : null;
  return nomes.every((nome) => {
    const n = String(nome).replace(/\\/g, '/');
    if (!n || n.startsWith('/') || n.includes(':') || n.includes('\0')) return false;
    const partes = n.split('/');
    if (partes.includes('..')) return false;
    return topo ? partes[0] === topo : true;
  });
}

/** Hora local com fuso: 2026-10-03 14:05:09-03:00. */
function horaLocal(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
    (off >= 0 ? '+' : '-') + p(Math.floor(a / 60)) + ':' + p(a % 60);
}

/** Acrescenta uma linha ao log; mensagem igual a ultima vira "(xN)" em vez de repetir. */
function acrescentarLog(linhas, texto, agora = new Date()) {
  const novas = linhas.slice();
  const ultima = novas[novas.length - 1];
  const m = ultima && /^(\S+ \S+) (.*?)(?: \(x(\d+)\))?$/.exec(ultima);
  if (m && m[2] === texto) {
    novas[novas.length - 1] = horaLocal(agora) + ' ' + texto + ' (x' + ((Number(m[3]) || 1) + 1) + ')';
  } else {
    novas.push(horaLocal(agora) + ' ' + texto);
  }
  return novas.length > LIMITE_LOG_LINHAS ? novas.slice(-LIMITE_LOG_LINHAS) : novas;
}

/**
 * Anota uma religacao feita pela vigia sobre a versao atual. Devolve true
 * quando e a 2a queda dentro de 48 h da instalacao dessa versao e existe uma
 * anterior para voltar (aí a versao atual deve ser recusada).
 */
function contarReligacao(e, agora = Date.now(), temAnterior = Boolean(e.anterior)) {
  const desde = Date.parse(e.instaladaEm);
  const dentro = Number.isFinite(desde) && agora >= desde && agora - desde < 48 * HORA;
  if (!dentro) { e.religacoes = []; return false; }
  e.religacoes = (e.religacoes || []).filter((x) => Date.parse(x) >= desde).concat(new Date(agora).toISOString()).slice(-10);
  return e.religacoes.length >= 2 && temAnterior;
}

/**
 * O PC ligou ha pouco (queda de energia, Windows Update)? Ai o programa fora do
 * ar e so o reinicio, nao defeito da versao, e a religacao nao conta como queda.
 */
function pcAcabouDeLigar(segundosLigado) {
  return Number.isFinite(segundosLigado) && segundosLigado >= 0 && segundosLigado < PC_ACABOU_DE_LIGAR_S;
}

function segundosLigado() {
  const forcado = TESTE ? Number(process.env.MONITOR_ATUALIZAR_UPTIME_S) : NaN;
  return Number.isFinite(forcado) ? forcado : os.uptime();
}

/** A pasta tem test/ com pelo menos um *.test.js? */
function temTestes(projeto) {
  const achar = (dir) => {
    let itens;
    try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    return itens.some((i) => (i.isDirectory() ? achar(path.join(dir, i.name)) : /\.test\.js$/.test(i.name)));
  };
  return achar(path.join(projeto, 'test'));
}

/* ---- arquivos --------------------------------------------------------- */

function caminhos(inst) {
  return {
    inst,
    iniciar: path.join(inst, 'iniciar.js'),
    estado: path.join(inst, 'atualizacao.json'),
    log: path.join(inst, 'atualizacao.log'),
    lock: path.join(inst, 'atualizacao.lock'),
    pid: path.join(inst, 'bridge.pid'),
    versoes: path.join(inst, 'versoes')
  };
}

const dirVersao = (c, sha) => path.join(c.versoes, sha);
const bridgeDe = (c, sha) => path.join(c.versoes, sha, 'src', 'bridge.js');
const versaoCompleta = (c, sha) => shaValido(sha) && fs.existsSync(bridgeDe(c, sha));

function registrar(c, texto) {
  try {
    let atual = '';
    try { atual = fs.readFileSync(c.log, 'utf8'); } catch { /* ainda nao existe */ }
    const linhas = acrescentarLog(atual.split(/\r?\n/).filter(Boolean), texto);
    fs.writeFileSync(c.log, linhas.join('\n') + '\n');
  } catch { /* log nunca pode derrubar nada */ }
}

function lerJson(arquivo) {
  const texto = fs.readFileSync(arquivo, 'utf8');
  return JSON.parse(texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto);
}

function lerEstado(c) {
  let e = {};
  try { e = lerJson(c.estado); } catch { /* sem arquivo ou quebrado */ }
  if (!e || typeof e !== 'object' || Array.isArray(e)) e = {};
  const t = {};
  if (e.tentativas && typeof e.tentativas === 'object') {
    for (const [k, v] of Object.entries(e.tentativas)) if (shaValido(k) && Number.isInteger(v) && v > 0) t[k] = v;
  }
  const troca = e.emTroca && typeof e.emTroca === 'object' && shaValido(e.emTroca.para)
    ? {
      de: shaValido(e.emTroca.de) ? e.emTroca.de : null,
      para: e.emTroca.para,
      anteriorAntes: shaValido(e.emTroca.anteriorAntes) ? e.emTroca.anteriorAntes : null
    }
    : null;
  const atual = shaValido(e.atual) ? e.atual : null;
  const anterior = shaValido(e.anterior) && e.anterior !== atual ? e.anterior : null;
  return {
    atual,
    anterior,
    emTroca: troca,
    alvo: shaValido(e.alvo) ? e.alvo : null,
    preparada: shaValido(e.preparada) ? e.preparada : null,
    recusadas: Array.isArray(e.recusadas) ? e.recusadas.filter(shaValido) : [],
    tentativas: t,
    instaladaEm: typeof e.instaladaEm === 'string' ? e.instaladaEm : null,
    ultimaConsulta: typeof e.ultimaConsulta === 'string' ? e.ultimaConsulta : null,
    religacoes: Array.isArray(e.religacoes) ? e.religacoes.filter((x) => typeof x === 'string' && Number.isFinite(Date.parse(x))).slice(-10) : [],
    falhasRede: Number.isInteger(e.falhasRede) && e.falhasRede > 0 ? e.falhasRede : 0,
    ultimoResultado: typeof e.ultimoResultado === 'string' ? e.ultimoResultado : null
  };
}

/** tmp + rename: o ponteiro nunca fica pela metade. */
function gravarEstado(c, e) {
  if (e.anterior === e.atual) e.anterior = null; // nunca a mesma versao nos dois ponteiros
  const tmp = c.estado + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(e, null, 2) + '\n');
  fs.renameSync(tmp, c.estado);
}

/**
 * Apaga algo dentro de versoes\ — e SO isso. Confere que a pasta e uma
 * instalacao (tem iniciar.js) e que o alvo esta dentro de versoes\ com nome
 * de versao. Qualquer outra coisa e erro, nao apagamento.
 */
function apagarVersao(c, alvo) {
  if (!fs.existsSync(c.iniciar)) throw new Error('recusei apagar: nao e uma instalacao');
  const rel = path.relative(c.versoes, alvo);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || !nomeDeVersao(rel)) {
    throw new Error('recusei apagar fora de versoes: ' + rel);
  }
  fs.rmSync(alvo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

function limparVersoes(c, e) {
  // Sem uma versao atual de verdade, nao apaga nada: nao sabemos o que e velho.
  if (!versaoCompleta(c, e.atual)) return;
  let nomes;
  try { nomes = fs.readdirSync(c.versoes); } catch { return; }
  for (const n of versoesParaApagar(nomes, [e.atual, e.anterior, e.preparada, e.emTroca && e.emTroca.para])) {
    try { apagarVersao(c, path.join(c.versoes, n)); } catch (erro) { registrar(c, 'nao consegui limpar ' + n.slice(0, 7) + ': ' + erro.message); }
  }
}

/**
 * Onde sondar o bridge, lido do config.json como o bridge le: a porta com
 * Number() (aceita "9090" em texto) e o host do config quando nao for curinga
 * (0.0.0.0, ::, vazio); curinga ou ausente = 127.0.0.1.
 */
function alvoDoConfig(cfg) {
  const srv = (cfg && typeof cfg === 'object' && cfg.servidor && typeof cfg.servidor === 'object') ? cfg.servidor : {};
  let porta = Number(srv.porta);
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) porta = 8080;
  let host = typeof srv.host === 'string' ? srv.host.trim() : '';
  if (!host || host === '0.0.0.0' || host === '::' || host === '[::]' || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) host = '127.0.0.1';
  return { host, porta };
}

function lerPorta(c) {
  try {
    return alvoDoConfig(lerJson(path.join(c.inst, 'config.json')));
  } catch { /* sem config ainda: o bridge cria a partir do exemplo e usa a porta padrao */ }
  return { host: '127.0.0.1', porta: 8080 };
}

/* ---- trava ------------------------------------------------------------ */

/** O processo e o atualizador (`node iniciar.js atualizar`) DESTA instalacao? */
function casaAtualizador(linhaDeComando, instalacao) {
  if (typeof linhaDeComando !== 'string') return false;
  const alvo = path.join(instalacao, 'iniciar.js').toLowerCase();
  const linha = linhaDeComando.toLowerCase().replace(/"/g, ' ');
  const i = linha.indexOf(alvo);
  if (i < 0) return false;
  return /^\s+atualizar(\s|$)/.test(linha.slice(i + alvo.length));
}

/** Linha de comando de um PID (null se o processo nao existe). */
async function linhaDoPid(pid) {
  const r = await rodar(powershellExe(), [
    '-NoProfile', '-NonInteractive', '-Command',
    UTF8_PS + '$p = Get-CimInstance Win32_Process -Filter "ProcessId = ' + Number(pid) + '"; if ($p) { $p.CommandLine }'
  ], { timeout: 30000 });
  const t = semBom(r.saida).trim();
  return r.codigo === 0 && t ? t : null;
}

/**
 * A trava guarda o PID de quem a pegou. Ela e velha se: passou de 30 min (ou a
 * data esta no futuro), ou o PID nao existe mais (atualizador morto), ou o PID
 * existe mas nao e um atualizador desta instalacao (PID reaproveitado).
 */
async function travaOrfa(c) {
  let texto = '';
  try { texto = fs.readFileSync(c.lock, 'utf8'); } catch { return false; }
  const pid = Number(/^\s*(\d+)/.exec(texto) && /^\s*(\d+)/.exec(texto)[1]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (erro) {
    return erro.code === 'ESRCH';
  }
  try {
    const linha = await linhaDoPid(pid);
    return linha === null ? true : !casaAtualizador(linha, c.inst);
  } catch { return false; }
}

async function pegarTrava(c) {
  const tentar = () => {
    const fd = fs.openSync(c.lock, 'wx');
    fs.writeSync(fd, String(process.pid) + ' ' + new Date().toISOString());
    fs.closeSync(fd);
  };
  try { tentar(); return true; } catch (erro) {
    if (erro.code !== 'EEXIST') throw erro;
  }
  let idade = 0;
  try { idade = Date.now() - fs.statSync(c.lock).mtimeMs; } catch { /* sumiu: tenta de novo */ }
  // idade negativa = relogio voltou: a trava e velha, nao eterna.
  const velha = idade < 0 || idade >= LOCK_VELHO_MS || await travaOrfa(c);
  if (!velha) return false;
  try { fs.unlinkSync(c.lock); tentar(); return true; } catch { return false; }
}

function soltarTrava(c) {
  try { fs.unlinkSync(c.lock); } catch { /* ja foi */ }
}

/* ---- rede ------------------------------------------------------------- */

const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** { tipo: 'ok', status } | { tipo: 'recusado' } | { tipo: 'incerto' } */
async function consultarStatus(alvo, ms = 3000) {
  const a = typeof alvo === 'object' ? alvo : { host: '127.0.0.1', porta: alvo };
  const host = a.host.includes(':') && !a.host.startsWith('[') ? '[' + a.host + ']' : a.host;
  try {
    const r = await fetch('http://' + host + ':' + a.porta + '/api/status', {
      signal: AbortSignal.timeout(ms),
      cache: 'no-store'
    });
    if (r.status !== 200) return { tipo: 'incerto' };
    try { return { tipo: 'ok', status: await r.json() }; } catch { return { tipo: 'incerto' }; }
  } catch (erro) {
    return conexaoRecusada(erro) ? { tipo: 'recusado' } : { tipo: 'incerto' };
  }
}

/**
 * So e "fora" depois de duas recusas seguidas, com uma pausa no meio, E sem
 * nenhum processo do bridge desta instalacao vivo (um bridge subindo ou
 * travado nao e "fora": ligar outro so atrapalharia). Na duvida, incerto.
 */
async function sondar(c, porta) {
  const primeira = await consultarStatus(porta);
  if (primeira.tipo !== 'recusado') return primeira;
  await pausa(TESTE && process.env.MONITOR_ATUALIZAR_PAUSA_MS ? Number(process.env.MONITOR_ATUALIZAR_PAUSA_MS) : 2000);
  const segunda = await consultarStatus(porta);
  if (segunda.tipo !== 'recusado') return segunda;
  try {
    const nodes = await listarNodes();
    if (nodes.some((n) => n.ProcessId !== process.pid && casaBridge(n.CommandLine, c.inst))) return { tipo: 'incerto' };
  } catch {
    return { tipo: 'incerto' };
  }
  return { tipo: 'fora' };
}

/** Sondagem -> o que seguroAplicar entende (null = fora, undefined = incerto). */
function statusDaSondagem(s) {
  if (s.tipo === 'fora') return null;
  if (s.tipo === 'ok') return s.status;
  return undefined;
}

/** Erro de rede (nao conta como tentativa da versao). */
function erroDeRede(erro) {
  erro.rede = true;
  return erro;
}

async function baixar(url, sobrescrita, max = LIMITE_DOWNLOAD, ms = 120000) {
  if (!urlPermitida(url, sobrescrita)) throw new Error('endereco nao permitido');
  let r;
  try {
    r = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(ms),
      headers: { 'User-Agent': 'monitor-01v96-atualizador' }
    });
  } catch (erro) {
    throw erroDeRede(erro);
  }
  if (!r.ok) {
    const e = new Error('HTTP ' + r.status);
    if (r.status >= 500 || r.status === 403 || r.status === 429) erroDeRede(e);
    throw e;
  }
  const declarado = Number(r.headers.get('content-length'));
  if (declarado > max) throw new ErroDefinitivo('download maior que o limite');
  const partes = [];
  let total = 0;
  try {
    for await (const parte of r.body) {
      total += parte.length;
      if (total > max) throw new ErroDefinitivo('download maior que o limite');
      partes.push(Buffer.from(parte));
    }
  } catch (erro) {
    throw erro instanceof ErroDefinitivo ? erro : erroDeRede(erro);
  }
  return Buffer.concat(partes);
}

async function consultarShaRemoto() {
  const sobre = TESTE && process.env.MONITOR_ATUALIZAR_API;
  const url = (sobre || API_PADRAO) + '/commits/' + RAMO;
  if (!urlPermitida(url, Boolean(sobre))) throw new Error('endereco nao permitido');
  let r;
  try {
    r = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'monitor-01v96-atualizador' }
    });
  } catch (erro) {
    throw erroDeRede(erro);
  }
  if (r.status === 403 || r.status === 429) {
    const e = new Error('limite da API do GitHub');
    e.limite = true;
    throw erroDeRede(e);
  }
  if (!r.ok) throw erroDeRede(new Error('GitHub respondeu HTTP ' + r.status));
  const sha = (await r.text()).trim();
  if (!shaValido(sha)) throw erroDeRede(new Error('resposta do GitHub sem sha valido'));
  return sha;
}

class ErroDefinitivo extends Error {}

/* ---- processos -------------------------------------------------------- */

function powershellExe() {
  const raiz = process.env.SystemRoot || 'C:\\Windows';
  const p = path.join(raiz, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : 'powershell.exe';
}

/** Roda um programa e devolve { codigo, saida, estourou }. Nunca rejeita. */
function rodar(exe, args, { cwd, timeout, env, shell } = {}) {
  return new Promise((ok) => {
    const ambiente = { ...process.env, ...env };
    // Se este processo foi chamado de dentro do `node --test`, o filho acharia
    // que e um worker do teste de fora e nao imprimiria o resultado.
    delete ambiente.NODE_TEST_CONTEXT;
    for (const k of Object.keys(ambiente)) if (ambiente[k] === null || ambiente[k] === undefined) delete ambiente[k];
    let saida = '';
    let estourou = false;
    let filho;
    try {
      filho = spawn(exe, args, { cwd, env: ambiente, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (erro) {
      ok({ codigo: -1, saida: String(erro.message), estourou: false });
      return;
    }
    const juntar = (p) => { saida = (saida + p).slice(-20000); };
    filho.stdout.setEncoding('utf8');
    filho.stderr.setEncoding('utf8');
    filho.stdout.on('data', juntar);
    filho.stderr.on('data', juntar);
    const relogio = timeout ? setTimeout(() => {
      estourou = true;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(filho.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        try { filho.kill('SIGKILL'); } catch { /* ja saiu */ }
      }
    }, timeout) : null;
    filho.on('error', (erro) => {
      if (relogio) clearTimeout(relogio);
      ok({ codigo: -1, saida: String(erro.message), estourou });
    });
    filho.on('close', (codigo) => {
      if (relogio) clearTimeout(relogio);
      ok({ codigo: codigo === null ? -1 : codigo, saida, estourou });
    });
  });
}

const UTF8_PS = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ';

function semBom(texto) {
  return texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
}

/**
 * Liga o bridge (`node iniciar.js`) sem janela e FORA da Tarefa Agendada: o
 * Agendador encerra os processos filhos da tarefa quando ela termina, e o
 * bridge precisa continuar. No Windows isso se faz criando o processo pelo
 * WMI (o pai passa a ser o servico do WMI). Se o WMI falhar, cai no spawn comum.
 */
async function ligarBridge(c) {
  if (process.platform === 'win32') {
    const linha = '"' + process.execPath + '" "' + c.iniciar + '"';
    const r = await rodar(powershellExe(), [
      '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; try { ' +
      '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; ' +
      '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:MONITOR_LINHA; CurrentDirectory = $env:MONITOR_PASTA; ProcessStartupInformation = $si }; ' +
      'if ($r -and $r.ReturnValue -eq 0 -and $r.ProcessId) { exit 0 } else { exit 90 } ' +
      '} catch { exit 91 }'
    ], { timeout: 30000, env: { MONITOR_LINHA: linha, MONITOR_PASTA: c.inst } });
    if (r.codigo === 0) return;
    registrar(c, 'WMI nao ligou o programa (' + r.codigo + '); tentando o modo comum');
  }
  const filho = spawn(process.execPath, [c.iniciar], {
    cwd: c.inst,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  filho.on('error', () => { /* o status mostra se subiu */ });
  filho.unref();
}

async function esperarBridge(porta, ms) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    const r = await consultarStatus(porta, 2000);
    if (r.tipo === 'ok') return true;
    await pausa(500);
  }
  return false;
}

/** Decide sozinho quanto esperar o bridge novo (45 s; menos so nos testes). */
const esperaBridgeMs = () => (TESTE && Number(process.env.MONITOR_ATUALIZAR_ESPERA_MS)) || 45000;

async function listarNodes() {
  const r = await rodar(powershellExe(), [
    '-NoProfile', '-NonInteractive', '-Command',
    UTF8_PS + "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | " +
    'Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress'
  ], { timeout: 30000 });
  if (r.codigo !== 0) throw new Error('nao consegui listar processos: ' + r.saida.slice(0, 200));
  const texto = semBom(r.saida).trim();
  if (!texto) return [];
  const j = JSON.parse(texto);
  return Array.isArray(j) ? j : [j];
}

async function donosDaPorta(porta) {
  const r = await rodar(powershellExe(), [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-NetTCPConnection -LocalPort ${Number(porta.porta || porta)} -State Listen -ErrorAction SilentlyContinue | ` +
    'ForEach-Object { $_.OwningProcess }'
  ], { timeout: 30000 });
  return r.saida.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

function pidDoArquivo(c) {
  try {
    const n = Number(fs.readFileSync(c.pid, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

/**
 * Para o bridge desta instalacao. Vale: o PID de bridge.pid, ou qualquer node
 * cuja linha de comando e `iniciar.js` DESTA instalacao sem argumento, desde
 * que a linha de comando confira. Plano B: o node que escuta na porta daqui e
 * e um iniciar.js/bridge.js (bridge aberto pelo jeito antigo). Outros node
 * nunca sao tocados.
 */
async function pararBridge(c, porta) {
  const nodes = await listarNodes();
  const donos = new Set(await donosDaPorta(porta));
  const doArquivo = pidDoArquivo(c);
  const alvos = nodes.filter((n) => {
    if (n.ProcessId === process.pid) return false;
    const cmd = n.CommandLine || '';
    if (casaBridge(cmd, c.inst)) return true;
    return donos.has(n.ProcessId) && /(iniciar|bridge)\.js/i.test(cmd) && !/\batualizar\s*$/i.test(cmd.trim()) &&
      (n.ProcessId === doArquivo || /bridge\.js/i.test(cmd) || cmd.toLowerCase().includes(c.inst.toLowerCase()));
  });
  for (const n of alvos) {
    try { process.kill(n.ProcessId); } catch { /* ja saiu */ }
  }
  const limite = Date.now() + 8000;
  while (Date.now() < limite) {
    const r = await consultarStatus(porta, 800);
    if (r.tipo === 'recusado') return alvos.length;
    await pausa(300);
  }
  throw new Error('o bridge nao parou');
}

/* ---- preparar --------------------------------------------------------- */

/** Percorre a pasta; recusa links simbolicos/juncoes e o que sair dela. */
function conferirArvore(raiz) {
  const base = fs.realpathSync(raiz);
  const pilha = [raiz];
  while (pilha.length) {
    const dir = pilha.pop();
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      const info = fs.lstatSync(p);
      if (info.isSymbolicLink()) throw new ErroDefinitivo('link simbolico no pacote: ' + nome);
      const real = fs.realpathSync(p);
      if (real !== base && !real.startsWith(base + path.sep)) throw new ErroDefinitivo('arquivo fora da pasta: ' + nome);
      if (info.isDirectory()) pilha.push(p);
    }
  }
}

/**
 * npm sem depender de .cmd: chama o npm-cli.js com o proprio node. Sem ele,
 * null (problema de ambiente, nao da versao). O caminho so pode ser trocado
 * com MONITOR_TESTE=1 (MONITOR_ATUALIZAR_NPM_CLI).
 */
function comandoNpm(args) {
  const cli = (TESTE && process.env.MONITOR_ATUALIZAR_NPM_CLI) ||
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(cli)) return { exe: process.execPath, args: [cli, ...args] };
  return null;
}

/** Deixou de ser seguro no meio do preparo: para sem contar tentativa. */
class ErroAdiado extends Error {}

function baixarPrioridade(baixa) {
  try {
    os.setPriority(0, baixa ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL);
  } catch { /* sem permissao: segue normal */ }
}

/**
 * Baixa, extrai, instala e testa em versoes\<sha>.preparando e so entao
 * renomeia para versoes\<sha>. Lanca ErroDefinitivo quando a versao e ruim;
 * qualquer outro erro e transitorio.
 */
async function preparar(c, sha, aindaSeguro) {
  const dest = dirVersao(c, sha);
  const prep = dest + '.preparando';
  const ext = dest + '.extraindo';
  const zip = dest + '.zip';

  if (versaoCompleta(c, sha)) return;
  fs.mkdirSync(c.versoes, { recursive: true });
  for (const p of [prep, ext, zip, dest]) apagarVersao(c, p);

  baixarPrioridade(true);
  try {
    const sobre = TESTE && process.env.MONITOR_ATUALIZAR_ZIP;
    const url = (sobre || ZIP_PADRAO) + '/zip/' + sha;
    registrar(c, 'baixando ' + sha.slice(0, 7));
    const buf = await baixar(url, Boolean(sobre));
    if (!entradasSeguras(listarEntradasZip(buf), sha)) throw new ErroDefinitivo('pacote com conteudo suspeito');
    fs.writeFileSync(zip, buf);

    const ex = await rodar(powershellExe(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      "$ProgressPreference='SilentlyContinue'; " +
      'Expand-Archive -LiteralPath $env:MONITOR_ZIP -DestinationPath $env:MONITOR_DESTINO -Force'
    ], { timeout: 180000, env: { MONITOR_ZIP: zip, MONITOR_DESTINO: ext } });
    if (ex.codigo !== 0) throw new Error('nao consegui extrair: ' + ex.saida.slice(0, 300));

    conferirArvore(ext);
    const topo = fs.readdirSync(ext);
    if (topo.length !== 1 || topo[0] !== 'app-mixagem-de-som-' + sha || !fs.statSync(path.join(ext, topo[0])).isDirectory()) {
      throw new ErroDefinitivo('pacote com formato inesperado');
    }
    fs.renameSync(path.join(ext, topo[0]), prep);
    apagarVersao(c, ext);
    apagarVersao(c, zip);

    if (!fs.existsSync(path.join(prep, 'package.json')) || !fs.existsSync(path.join(prep, 'src', 'bridge.js'))) {
      throw new ErroDefinitivo('pacote sem package.json ou src/bridge.js');
    }
    if (!temTestes(prep)) throw new ErroDefinitivo('pacote sem testes: nao da para confiar nele');
    if (!fs.existsSync(path.join(prep, 'package-lock.json'))) throw new ErroDefinitivo('pacote sem package-lock.json');

    // A versao nova tem que trazer o proprio atualizador e o lancador: sem eles
    // a instalacao nao conseguiria mais se atualizar nem religar.
    for (const rel of [path.join('src', 'atualizar.js'), path.join('instalar', 'iniciar.js')]) {
      if (!fs.existsSync(path.join(prep, rel))) throw new ErroDefinitivo('pacote sem ' + rel);
    }

    // Tudo que a candidata roda (npm e testes) usa uma pasta de dados vazia e
    // descartavel: nunca a calibracao desta instalacao.
    const dadosTeste = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-preparo-'));
    const ambienteTeste = { MONITOR_DADOS: dadosTeste, MONITOR_INSTALACAO: null };
    try {
      if (!(await aindaSeguro())) throw new ErroAdiado('deixou de ser seguro');
      registrar(c, 'instalando dependencias de ' + sha.slice(0, 7));
      const npm = comandoNpm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']);
      if (!npm) throw erroDeRede(new Error('npm nao encontrado neste computador'));
      const inst = await rodar(npm.exe, npm.args, { cwd: prep, timeout: 5 * 60 * 1000, env: ambienteTeste });
      if (inst.codigo === -1 || /Cannot find module|MODULE_NOT_FOUND/.test(inst.saida)) {
        throw erroDeRede(new Error('npm nao subiu: ' + inst.saida.trim().split(/\r?\n/).slice(-2).join(' | ')));
      }
      if (inst.codigo !== 0) {
        throw new Error('npm ci falhou: ' + inst.saida.trim().split(/\r?\n/).slice(-3).join(' | '));
      }

      if (!(await aindaSeguro())) throw new ErroAdiado('deixou de ser seguro');
      registrar(c, 'rodando os testes de ' + sha.slice(0, 7));
      const t = await rodar(process.execPath, ['--test'], { cwd: prep, timeout: TESTES_TETO_MS, env: ambienteTeste });
      if (t.estourou) throw new Error('testes estouraram o tempo');
      if (t.codigo !== 0) {
        throw new ErroDefinitivo('testes falharam: ' + t.saida.trim().split(/\r?\n/).slice(-3).join(' | '));
      }
    } finally {
      try { fs.rmSync(dadosTeste, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* temp: o sistema limpa */ }
    }
    fs.renameSync(prep, dest);
  } catch (erro) {
    try { for (const p of [prep, ext, zip]) apagarVersao(c, p); } catch { /* o proximo preparo limpa */ }
    throw erro;
  } finally {
    baixarPrioridade(false);
  }
}

/* ---- aplicar ---------------------------------------------------------- */

/** Troca o launcher se a versao nova traz outro (por arquivo temporario + rename). */
function atualizarLancador(c, sha) {
  const novo = path.join(dirVersao(c, sha), 'instalar', 'iniciar.js');
  if (!fs.existsSync(novo)) return;
  const bytes = fs.readFileSync(novo);
  let igual = false;
  try { igual = Buffer.compare(bytes, fs.readFileSync(c.iniciar)) === 0; } catch { /* sem launcher */ }
  if (igual) return;
  const tmp = path.join(c.inst, 'iniciar.novo.js');
  fs.writeFileSync(tmp, bytes);
  // So vale se a sintaxe confere; senao fica o lancador atual.
  const chk = spawnSync(process.execPath, ['--check', tmp], { windowsHide: true, encoding: 'utf8' });
  if (chk.status !== 0) {
    fs.rmSync(tmp, { force: true });
    registrar(c, 'lancador novo com erro de sintaxe; mantive o atual');
    return;
  }
  try { fs.copyFileSync(c.iniciar, c.iniciar + '.bak'); } catch { /* sem lancador antigo */ }
  fs.renameSync(tmp, c.iniciar);
  registrar(c, 'lancador atualizado (o anterior ficou em iniciar.js.bak)');
}

function bridgeMorreu(c, desde) {
  // So afirma "morreu" se o bridge.pid e deste lancamento e o processo nao existe mais.
  try {
    if (fs.statSync(c.pid).mtimeMs < desde - 1000) return false;
    const pid = pidDoArquivo(c);
    if (!pid) return false;
    try { process.kill(pid, 0); return false; } catch (erro) { return erro.code === 'ESRCH'; }
  } catch { return false; }
}

/**
 * Troca para e.preparada. Devolve 'aplicada' | 'adiada' | 'falhou-definitiva' |
 * 'falhou-transitoria'.
 */
async function aplicar(c, e, porta) {
  const sha = e.preparada;
  if (sha === e.atual) {
    // ja e a versao em uso (ex.: troca anterior terminou apos uma queda)
    e.preparada = null;
    e.alvo = null;
    return 'adiada';
  }
  if (!versaoCompleta(c, sha)) {
    registrar(c, 'versao preparada ' + String(sha).slice(0, 7) + ' sumiu; preparo de novo na proxima');
    e.preparada = null;
    return 'adiada';
  }
  // Confere de novo logo antes de parar o bridge: um celular pode ter entrado.
  if (!seguroAplicar(statusDaSondagem(await sondar(c, porta)))) return 'adiada';

  const de = e.atual;
  const anteriorAntes = e.anterior;
  registrar(c, 'trocando para ' + sha.slice(0, 7));

  e.emTroca = { de, para: sha, anteriorAntes };
  gravarEstado(c, e);

  try {
    await pararBridge(c, porta);
  } catch (erro) {
    registrar(c, 'nao consegui parar o programa: ' + erro.message);
    e.emTroca = null;
    gravarEstado(c, e);
    return 'adiada';
  }

  e.anterior = de;
  e.atual = sha;
  gravarEstado(c, e);

  const inicio = Date.now();
  await ligarBridge(c);
  const subiu = await esperarBridge(porta, esperaBridgeMs());

  if (subiu) {
    e.emTroca = null;
    e.preparada = null;
    e.alvo = null;
    delete e.tentativas[sha];
    e.instaladaEm = new Date().toISOString();
    gravarEstado(c, e);
    try { atualizarLancador(c, sha); } catch (erro) { registrar(c, 'nao troquei o lancador: ' + erro.message); }
    limparVersoes(c, e);
    registrar(c, 'atualizado para ' + sha.slice(0, 7));
    return 'aplicada';
  }

  const definitiva = bridgeMorreu(c, inicio);
  registrar(c, (definitiva ? 'o programa novo fechou com erro' : 'o programa novo nao respondeu a tempo') + '; voltando a versao anterior');
  try { await pararBridge(c, porta); } catch { /* pode nem ter subido */ }
  e.atual = de;
  e.anterior = anteriorAntes;
  e.emTroca = null;
  gravarEstado(c, e);
  await ligarBridge(c);
  const voltou = await esperarBridge(porta, esperaBridgeMs());
  registrar(c, voltou ? 'versao anterior de volta no ar' : 'ATENCAO: versao anterior nao respondeu apos voltar');
  return definitiva ? 'falhou-definitiva' : 'falhou-transitoria';
}

/* ---- fluxo ------------------------------------------------------------ */

/** Vigia + recuperacao de troca interrompida. Devolve a sondagem final. */
async function vigiar(c, e, porta) {
  let s = await sondar(c, porta);
  let recuperou = false;

  if (e.emTroca) {
    if (s.tipo !== 'ok') {
      // Troca interrompida e o programa nao responde. Se ainda ha um processo
      // do bridge desta instalacao (travado), para ele antes de voltar.
      if (s.tipo !== 'fora') {
        try { await pararBridge(c, porta); } catch { /* segue: a religacao abaixo confere */ }
        s = { tipo: 'fora' };
      }
      const t = e.emTroca;
      recuperou = true;
      registrar(c, 'troca interrompida; voltando a versao anterior');
      if (versaoCompleta(c, t.de)) e.atual = t.de;
      e.anterior = t.anteriorAntes;
      registrar(c, 'versao ' + t.para.slice(0, 7) + ' contada como falha');
      registrarFalha(e, t.para, false);
      e.emTroca = null;
      gravarEstado(c, e);
    } else {
      // O programa esta de pe (o novo ou o antigo): nada a desfazer. Se o
      // ponteiro ja estava na versao nova, ela nao e mais "preparada" nem alvo.
      const t = e.emTroca;
      e.emTroca = null;
      if (t.para === e.atual) {
        if (e.preparada === t.para) e.preparada = null;
        if (e.alvo === t.para) e.alvo = null;
        delete e.tentativas[t.para];
        e.instaladaEm = new Date().toISOString();
      }
      gravarEstado(c, e);
    }
  }

  if (s.tipo === 'fora') {
    const reinicio = pcAcabouDeLigar(segundosLigado());
    if (reinicio) registrar(c, 'o PC acabou de ligar; nao conto como queda da versao');
    if (!recuperou && !reinicio && contarReligacao(e, Date.now(), versaoCompleta(c, e.anterior))) {
      const ruim = e.atual;
      registrar(c, 'a versao ' + ruim.slice(0, 7) + ' caiu de novo em menos de 48 h; voltando a anterior');
      e.atual = e.anterior;
      e.anterior = null;
      if (!e.recusadas.includes(ruim)) e.recusadas.push(ruim);
      e.recusadas = e.recusadas.slice(-MAX_RECUSADAS);
      if (e.alvo === ruim) e.alvo = null;
      if (e.preparada === ruim) e.preparada = null;
      e.religacoes = [];
      e.instaladaEm = new Date().toISOString();
      e.ultimoResultado = RESULTADO.voltou;
    }
    gravarEstado(c, e);
    await ligarBridge(c);
    registrar(c, 'o programa estava fora do ar; liguei de novo');
    await esperarBridge(porta, 20000);
    s = await consultarStatus(porta);
  } else if (s.tipo === 'incerto') {
    registrar(c, 'o programa respondeu de forma estranha; nao mexo');
  }
  return s;
}

async function consultar(c, e) {
  if (!deveConsultar(e.ultimaConsulta, Date.now(), intervaloConsulta(e.falhasRede))) return;
  let sha;
  try {
    sha = await consultarShaRemoto();
  } catch (erro) {
    e.falhasRede++;
    e.ultimaConsulta = new Date().toISOString();
    e.ultimoResultado = erro.limite ? RESULTADO.limiteApi : RESULTADO.semRede;
    registrar(c, (erro.limite ? 'limite da API: ' : 'sem consulta: ') + erro.message);
    gravarEstado(c, e);
    return;
  }
  e.falhasRede = 0;
  e.ultimaConsulta = new Date().toISOString();
  if (sha === e.atual) {
    e.alvo = null;
    if (!e.preparada) e.ultimoResultado = RESULTADO.emDia;
  } else if (e.recusadas.includes(sha)) {
    e.alvo = null;
    if (!e.preparada) e.ultimoResultado = RESULTADO.recusada;
  } else {
    e.alvo = sha;
  }
  gravarEstado(c, e);
}

async function executar(inst) {
  const c = caminhos(inst);
  // So age em cima de uma instalacao de verdade (tem o lancador).
  if (!fs.existsSync(inst) || !fs.existsSync(c.iniciar)) return 'sem-instalacao';
  if (!(await pegarTrava(c))) return 'ocupado';

  try {
    const porta = lerPorta(c);
    const e = lerEstado(c);
    try {
      await vigiar(c, e, porta);
      limparVersoes(c, e);

      await consultar(c, e);

      // Preparar: so quando e seguro (nada de CPU pesada nem codigo novo durante o culto).
      if (e.alvo && e.alvo !== e.preparada && e.alvo !== e.atual) {
        const esperaRede = e.falhasRede > 0 && !deveConsultar(e.ultimaConsulta, Date.now(), intervaloConsulta(e.falhasRede));
        const sondagem = await sondar(c, porta);
        if (esperaRede) {
          // acabou de falhar a rede: espera a janela
        } else if (process.platform !== 'win32') {
          e.ultimoResultado = RESULTADO.soWindows;
          registrar(c, 'atualizacao automatica so no Windows');
        } else if (!seguroAplicar(statusDaSondagem(sondagem))) {
          e.ultimoResultado = RESULTADO.esperandoSeguro;
          registrar(c, 'versao ' + e.alvo.slice(0, 7) + ' achada; espero a mesa desligada e ninguem conectado para preparar');
        } else {
          const sha = e.alvo;
          try {
            await preparar(c, sha, async () => seguroAplicar(statusDaSondagem(await sondar(c, porta))));
            e.preparada = sha;
            delete e.tentativas[sha];
            registrar(c, 'versao ' + sha.slice(0, 7) + ' preparada');
          } catch (erro) {
            if (erro instanceof ErroAdiado) {
              registrar(c, 'preparo de ' + sha.slice(0, 7) + ' interrompido: deixou de ser seguro');
              e.ultimoResultado = RESULTADO.esperandoSeguro;
              gravarEstado(c, e);
              return 'adiado';
            }
            const definitiva = erro instanceof ErroDefinitivo;
            registrar(c, (definitiva ? 'versao ' + sha.slice(0, 7) + ' recusada: ' : 'nao consegui preparar ' + sha.slice(0, 7) + ': ') + erro.message);
            if (erro.rede) {
              e.falhasRede++;
              e.ultimaConsulta = new Date().toISOString();
              e.ultimoResultado = RESULTADO.semRede;
            } else {
              const r = registrarFalha(e, sha, definitiva);
              e.ultimoResultado = r === 'recusada' ? RESULTADO.recusada : RESULTADO.falhaPreparo;
            }
          }
        }
        gravarEstado(c, e);
      }

      // Aplicar: so quando e seguro.
      if (e.preparada) {
        const sha = e.preparada;
        if (e.recusadas.includes(sha)) {
          e.preparada = null;
        } else if (!seguroAplicar(statusDaSondagem(await sondar(c, porta)))) {
          registrar(c, 'versao ' + sha.slice(0, 7) + ' pronta; espero a mesa desligada e ninguem conectado');
          e.ultimoResultado = RESULTADO.esperando;
        } else {
          const r = await aplicar(c, e, porta);
          if (r === 'aplicada') e.ultimoResultado = 'atualizado para ' + sha.slice(0, 7);
          else if (r === 'adiada') e.ultimoResultado = RESULTADO.esperando;
          else {
            registrarFalha(e, sha, r === 'falhou-definitiva');
            e.ultimoResultado = RESULTADO.voltou;
          }
        }
        gravarEstado(c, e);
      }
    } catch (erro) {
      registrar(c, 'erro inesperado: ' + (erro && erro.message));
      // A vigia ja rodou; se um erro derrubou o bridge no meio de uma troca, religa.
      try {
        if (e.emTroca) {
          e.atual = versaoCompleta(c, e.emTroca.de) ? e.emTroca.de : e.atual;
          e.anterior = e.emTroca.anteriorAntes;
          e.emTroca = null;
          gravarEstado(c, e);
        }
        const depois = await sondar(c, porta);
        if (depois.tipo === 'fora') { await ligarBridge(c); registrar(c, 'religuei o programa depois do erro'); }
      } catch { /* nada a fazer */ }
      return 'erro';
    }
    return 'ok';
  } finally {
    soltarTrava(c);
  }
}

async function main() {
  let inst = process.env.MONITOR_INSTALACAO ? path.resolve(process.env.MONITOR_INSTALACAO) : null;
  if (!inst) {
    // versoes\<sha>\src\atualizar.js -> INST tres pastas acima
    const tres = path.resolve(__dirname, '..', '..', '..');
    if (path.basename(path.resolve(__dirname, '..', '..')) === 'versoes') inst = tres;
  }
  if (!inst) return 'sem-instalacao';
  try {
    return await executar(inst);
  } catch (erro) {
    try { registrar(caminhos(inst), 'erro inesperado: ' + (erro && erro.message)); } catch { /* ignora */ }
    return 'erro';
  }
}

if (require.main === module) {
  // Sem process.exit(): no Windows ele derruba o node com um assert do libuv
  // quando ainda ha conexoes fechando. Sai sozinho quando nada mais pende.
  main().then(() => { process.exitCode = 0; }, () => { process.exitCode = 0; });
}

module.exports = {
  DADOS_PROTEGIDOS,
  RESULTADO,
  shaValido,
  deveConsultar,
  intervaloConsulta,
  seguroAplicar,
  nomeDeVersao,
  versoesParaApagar,
  conexaoRecusada,
  registrarFalha,
  casaBridge,
  casaAtualizador,
  alvoDoConfig,
  contarReligacao,
  pcAcabouDeLigar,
  urlPermitida,
  listarEntradasZip,
  entradasSeguras,
  horaLocal,
  acrescentarLog,
  temTestes,
  executar,
  main
};
