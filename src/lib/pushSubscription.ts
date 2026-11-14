/**
 * Utility functions for Web Push API and PWA subscription management.
 */

/**
 * Converts a URL-safe Base64 encoded VAPID public key string into a Uint8Array
 * required by the browser's PushManager.subscribe() method.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Checks whether the current browser and operating system support Web Push notifications.
 */
export function isPushNotificationSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Detects whether the web application is running as an installed standalone PWA
 * (e.g., added to mobile home screen or desktop installed app) vs regular browser tab.
 */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  const isMatchMediaStandalone = window.matchMedia(
    "(display-mode: standalone)"
  ).matches;
  const isNavigatorStandalone =
    "standalone" in navigator && Boolean((navigator as any).standalone);
  return Boolean(isMatchMediaStandalone || isNavigatorStandalone);
}
