// Service worker LEYBOTDY : réseau d'abord (toujours à jour), copie en secours si le réseau coupe. Les appels /api ne sont jamais mis en cache.
const V = 'leybotdy-v7';
const BASE = ['/offline.html', '/manifest.webmanifest', '/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(BASE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.endsWith('.mp3')) return;   // la musique passe directement
  e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); return res; })
    .catch(() => caches.match(r).then(m => m || (r.mode === 'navigate' ? caches.match('/offline.html') : Response.error()))));
});


// 🔔 Réception des notifications : alertes admin et messages du chat.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'LEYBOTDY', {
      body: data.body || 'Une nouvelle activité nécessite ton attention.',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'leybotdy-admin',
      data: { url: data.url || '/admin' },
      renotify: true
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/admin', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if (client.url === target && 'focus' in client) return client.focus();
    }
    if (clients.openWindow) return clients.openWindow(target);
  }));
});
