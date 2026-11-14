/**
 * MSEC Tuition Desk - Progressive Web App Service Worker
 * Handles Web Push notifications and notification click window focusing.
 * Operates dynamically across standalone PWA and standard browser contexts.
 */

// 1. Service Worker Lifecycle: Immediate activation
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// 2. Web Push Event Listener
self.addEventListener("push", (event) => {
  let notificationData = {
    title: "MSEC Institute",
    body: "You have a new update in your Parent Portal.",
    icon: "/icons/icon-192x192.png",
    badge: "/icons/icon-192x192.png",
    tag: "msec-update",
    renotify: true,
    data: {
      url: "/portal",
    },
  };

  if (event.data) {
    try {
      const payload = event.data.json();
      notificationData = {
        title: payload.title || notificationData.title,
        body: payload.body || notificationData.body,
        icon: payload.icon || notificationData.icon,
        badge: payload.badge || notificationData.badge,
        tag: payload.tag || notificationData.tag,
        renotify: payload.renotify ?? true,
        vibrate: payload.vibrate || [100, 50, 100],
        data: {
          url: payload.url || (payload.data && payload.data.url) || "/portal",
          ...payload.data,
        },
        actions: payload.actions || [
          { action: "open_portal", title: "View Portal" },
        ],
      };
    } catch {
      // Fallback for plain text push messages
      notificationData.body = event.data.text() || notificationData.body;
    }
  }

  const options = {
    body: notificationData.body,
    icon: notificationData.icon,
    badge: notificationData.badge,
    tag: notificationData.tag,
    renotify: notificationData.renotify,
    vibrate: notificationData.vibrate || [100, 50, 100],
    data: notificationData.data,
    actions: notificationData.actions,
  };

  event.waitUntil(
    self.registration.showNotification(notificationData.title, options)
  );
});

// 3. Notification Click & App Navigation Listener
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl =
    (event.notification.data && event.notification.data.url) || "/portal";

  // When user clicks an action or the notification body
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // If a window/PWA instance is already open, focus it and navigate
        for (const client of clientList) {
          if ("focus" in client) {
            if ("navigate" in client && targetUrl) {
              client.navigate(targetUrl);
            }
            return client.focus();
          }
        }

        // If no window is open, open a new one.
        // In standalone PWA mode (installed to home screen), this opens the standalone window.
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
  );
});
