self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Company Portal';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    data: { destination: typeof payload.destination === 'string' ? payload.destination : null },
    tag: typeof payload.notificationId === 'string' ? payload.notificationId : undefined,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target = new URL('/', self.location.origin).href;
  const destination = event.notification.data && event.notification.data.destination;
  if (typeof destination === 'string') {
    try {
      const url = new URL(destination, self.location.origin);
      if (url.origin === self.location.origin && url.pathname === '/') target = url.href;
    } catch {
      target = new URL('/', self.location.origin).href;
    }
  }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && 'navigate' in client) {
        const navigated = await client.navigate(target);
        if (navigated) return navigated.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
