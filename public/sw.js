'use strict';
/**
 * Service worker minimo.
 * Objetivo unico: se o Wi-Fi cair na hora de abrir o app, a tela ainda aparece
 * (e o WebSocket reconecta sozinho quando a rede voltar).
 *
 * Estrategia: tenta a rede primeiro e guarda uma copia. Sem rede, serve a
 * copia. Nada de /api e nada de WebSocket passa por aqui.
 */

const CACHE = 'monitor-01v96-v1';

const ARQUIVOS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icone.svg',
  'icone-192.png',
  'icone-512.png'
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ARQUIVOS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evento) => {
  const req = evento.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  evento.respondWith(
    fetch(req)
      .then((resposta) => {
        if (resposta && resposta.ok) {
          const copia = resposta.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copia)).catch(() => {});
        }
        return resposta;
      })
      .catch(async () => {
        const guardado = await caches.match(req);
        if (guardado) return guardado;
        if (req.mode === 'navigate') {
          const inicial = await caches.match('index.html');
          if (inicial) return inicial;
        }
        return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      })
  );
});
