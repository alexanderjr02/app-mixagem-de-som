'use strict';
/**
 * gerar-icones.js
 * "npm run icones": gera public/icone-192.png e public/icone-512.png a partir
 * do mesmo desenho do icone.svg.
 *
 * Por que gerar PNG: alguns celulares so aceitam instalar o app (aquele
 * "adicionar a tela inicial") se o manifest apontar icones PNG de 192 e 512.
 * O PNG e escrito aqui na mao com o zlib do proprio Node, sem dependencia
 * externa e sem etapa de build.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SAIDA = path.resolve(__dirname, '..', 'public');

// Mesmas cores do tema do app.
const FUNDO = [0x08, 0x08, 0x0a];
const TRILHO = [0x2f, 0x2f, 0x38];
const PUNHO = [0xf2, 0xf2, 0xf5];

/* ----------------------------- desenho ----------------------------------- */

/** Ponto dentro de um retangulo de cantos arredondados. */
function dentroRet(px, py, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Cor de um ponto do icone, ou null se for transparente. */
function corNoPonto(px, py, S) {
  // Fundo ocupando o quadrado todo, com cantos arredondados.
  if (!dentroRet(px, py, 0, 0, S, S, S * 0.223)) return null;

  const topo = S * 0.219;
  const base = S * 0.781;
  const larguraTrilho = S * 0.035;
  const centros = [S * 0.297, S * 0.5, S * 0.703];
  const alturasPunho = [S * 0.371, S * 0.531, S * 0.441];
  const larguraPunho = S * 0.141;
  const alturaPunho = S * 0.059;

  for (let i = 0; i < 3; i++) {
    const cx = centros[i];

    // Punho (o retangulo claro que voce arrasta no app).
    const py0 = alturasPunho[i] - alturaPunho / 2;
    if (
      dentroRet(
        px, py,
        cx - larguraPunho / 2, py0,
        cx + larguraPunho / 2, py0 + alturaPunho,
        alturaPunho / 2
      )
    ) {
      return PUNHO;
    }

    // Trilho do fader.
    if (
      dentroRet(
        px, py,
        cx - larguraTrilho / 2, topo,
        cx + larguraTrilho / 2, base,
        larguraTrilho / 2
      )
    ) {
      return TRILHO;
    }
  }

  return FUNDO;
}

/** Desenha com 3x3 amostras por pixel, para as bordas nao ficarem serrilhadas. */
function desenhar(S) {
  const pixels = Buffer.alloc(S * S * 4);
  const AMOSTRAS = 3;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < AMOSTRAS; sy++) {
        for (let sx = 0; sx < AMOSTRAS; sx++) {
          const px = x + (sx + 0.5) / AMOSTRAS;
          const py = y + (sy + 0.5) / AMOSTRAS;
          const cor = corNoPonto(px, py, S);
          if (cor) {
            r += cor[0];
            g += cor[1];
            b += cor[2];
            a += 255;
          }
        }
      }

      const total = AMOSTRAS * AMOSTRAS;
      const i = (y * S + x) * 4;
      const alfa = a / total;
      // Guardamos a cor ja media dos pontos pintados, para a borda nao escurecer.
      const pintados = a / 255 || 1;
      pixels[i] = Math.round(r / pintados);
      pixels[i + 1] = Math.round(g / pintados);
      pixels[i + 2] = Math.round(b / pintados);
      pixels[i + 3] = Math.round(alfa);
    }
  }

  return pixels;
}

/* ------------------------------- PNG ------------------------------------- */

const TABELA_CRC = (() => {
  const tabela = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c;
  }
  return tabela;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function bloco(tipo, dados) {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length, 0);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo), 0);
  return Buffer.concat([tamanho, corpo, crc]);
}

function montarPng(S, pixels) {
  const assinatura = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8;  // 8 bits por canal
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compressao padrao
  ihdr[11] = 0; // filtro padrao
  ihdr[12] = 0; // sem entrelacamento

  // Cada linha do PNG comeca com um byte de filtro (0 = sem filtro).
  const linhas = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    const destino = y * (S * 4 + 1);
    linhas[destino] = 0;
    pixels.copy(linhas, destino + 1, y * S * 4, (y + 1) * S * 4);
  }

  return Buffer.concat([
    assinatura,
    bloco('IHDR', ihdr),
    bloco('IDAT', zlib.deflateSync(linhas, { level: 9 })),
    bloco('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------ execucao --------------------------------- */

for (const tamanho of [192, 512]) {
  const destino = path.join(SAIDA, 'icone-' + tamanho + '.png');
  fs.writeFileSync(destino, montarPng(tamanho, desenhar(tamanho)));
  console.log('gerado: ' + destino);
}
