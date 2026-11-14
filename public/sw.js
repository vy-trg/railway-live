// Railway Live service worker: makes the site installable (Add to Home Screen) and shows the
// Start journey notifications the server pushes (push.js) when the page isn't on screen.
// It doesn't store pages or data: everything here is live, and an old copy would be wrong.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Railway Live', {
    body: data.body || '',
    tag: data.tag || 'rl-go',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [200, 100, 200],
  }));
});

// Tapping a notification opens the app (or brings it to the front)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (page) return page.focus();
    return self.clients.openWindow('/');
  })());
});

// Every request goes to the network as usual
self.addEventListener('fetch', () => {});
