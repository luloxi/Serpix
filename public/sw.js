self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() || "Tenés una novedad en Serpix." };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Serpix", {
      body: data.body || "Tenés una novedad en tu espacio de trabajo.",
      icon: "/icons/icon-192.v5.png",
      badge: "/icons/serpix-48.v5.png",
      tag: data.tag || undefined,
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((window) => window.url === target) || windows.find((window) => new URL(window.url).origin === self.location.origin);
      if (existing) return (existing.url === target ? existing.focus() : existing.navigate(target).then((w) => (w || existing).focus()));
      return clients.openWindow(target);
    })
  );
});
