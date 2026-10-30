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
      icon: "/icons/icon-192.v3.png",
      badge: "/icons/serpix-48.v3.png",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((window) => window.url === target);
      if (existing) return existing.focus();
      return clients.openWindow(target);
    })
  );
});
