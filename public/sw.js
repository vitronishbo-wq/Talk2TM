// Talk2TM Minimalist Shell Service Worker
const CACHE_NAME = 'talk2tm-shell-v9';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-talk2tm.svg'
];

function sanitizeIncomingPushNotification(rawData) {
  let parsed = {};
  try {
    if (rawData && typeof rawData.json === 'function') {
      parsed = rawData.json() || {};
    }
  } catch {
    parsed = {};
  }

  const kind = parsed && parsed.kind === 'match' ? 'match' : 'message';
  // Privacidade rigorosa no ecrã bloqueado: nunca exibe nomes, remetentes ou conteúdo de mensagens
  const safeBody = kind === 'match' ? 'Novo Match' : 'Nova atividade na conta';

  return {
    title: 'Talk2TM',
    options: {
      body: safeBody,
      icon: '/icon-talk2tm.svg',
      badge: '/icon-talk2tm.svg',
      tag: kind === 'match' ? 'talk2tm-match' : 'talk2tm-activity',
      renotify: false,
      silent: false,
      data: { url: '/' },
    },
  };
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('push', (event) => {
  const sanitized = sanitizeIncomingPushNotification(event.data);
  event.waitUntil(self.registration.showNotification(sanitized.title, sanitized.options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification && event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle GET navigation/shell requests. NEVER cache Firestore or backend calls.
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // 11.2 Para requisições de navegação (/ ou /index.html): Network-first com no-store e fallback para cache
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match('/index.html').then((cached) => cached || new Response('Offline', { status: 503 }));
        })
    );
    return;
  }

  // 11.5 Para assets versionados por hash (/assets/): Cache-first
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // Demais requisições estáticas locais
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || new Response('Offline', { status: 503 })))
  );
});


