"use client";

import { useState, useEffect, useCallback } from "react";
import {
  urlBase64ToUint8Array,
  isPushNotificationSupported,
  isStandalonePwa,
} from "@/lib/pushSubscription";

export interface UseWebPushReturn {
  isSupported: boolean;
  isStandalone: boolean;
  permission: NotificationPermission;
  isSubscribed: boolean;
  subscription: PushSubscription | null;
  loading: boolean;
  error: string | null;
  subscribe: (rawToken?: string) => Promise<boolean>;
  unsubscribe: (rawToken?: string) => Promise<boolean>;
}

export function useWebPush(customBackendUrl?: string): UseWebPushReturn {
  const [isSupported, setIsSupported] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const backendUrl =
    customBackendUrl ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:3001/api";

  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";

  // 1. Initial capability & active subscription check
  useEffect(() => {
    if (typeof window === "undefined") return;

    const supported = isPushNotificationSupported();
    setIsSupported(supported);
    setIsStandalone(isStandalonePwa());

    if (!supported) return;

    setPermission(Notification.permission);

    // Check if Service Worker is already active and subscribed
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((existingSub) => {
        if (existingSub) {
          setSubscription(existingSub);
          setIsSubscribed(true);
        }
      })
      .catch((err) => {
        console.warn("[USE_WEB_PUSH] Could not read existing subscription:", err);
      });
  }, []);

  // 2. Subscribe Action
  const subscribe = useCallback(
    async (rawToken?: string): Promise<boolean> => {
      setError(null);
      setLoading(true);

      try {
        if (!isPushNotificationSupported()) {
          throw new Error("Push notifications are not supported on this browser or device.");
        }

        if (!vapidPublicKey) {
          throw new Error(
            "VAPID public key is missing. Ensure NEXT_PUBLIC_VAPID_PUBLIC_KEY is configured in your environment."
          );
        }

        // Request browser permission
        const requestedPermission = await Notification.requestPermission();
        setPermission(requestedPermission);

        if (requestedPermission !== "granted") {
          throw new Error(
            requestedPermission === "denied"
              ? "Notification permission was blocked. Please enable notifications in your browser/device settings."
              : "Notification permission request was dismissed."
          );
        }

        // Register Service Worker if not yet registered
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });
        await navigator.serviceWorker.ready;

        // Subscribe with VAPID Application Server Key
        const convertedKey = urlBase64ToUint8Array(vapidPublicKey);
        let activeSub = await registration.pushManager.getSubscription();

        if (!activeSub) {
          activeSub = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: convertedKey as unknown as BufferSource,
          });
        }

        // Transmit PushSubscription to backend API (supports both staff and parents)
        const targetEndpoint = customBackendUrl
          ? `${backendUrl}/push/subscribe`
          : "/api/push/subscribe";

        let response = await fetch(targetEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            action: "subscribe",
            subscription: activeSub.toJSON(),
            token: rawToken || undefined,
          }),
        });

        // Fallback to legacy parent endpoint if 404
        if (response.status === 404) {
          response = await fetch(`${backendUrl}/parent/push/subscribe`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            credentials: "include",
            body: JSON.stringify({
              action: "subscribe",
              subscription: activeSub.toJSON(),
              token: rawToken || undefined,
            }),
          });
        }

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.error || "Failed to persist push subscription on server.");
        }

        setSubscription(activeSub);
        setIsSubscribed(true);
        return true;
      } catch (err: any) {
        console.error("[USE_WEB_PUSH ERROR]", err);
        setError(err.message || "Failed to enable push notifications.");
        return false;
      } finally {
        setLoading(false);
      }
    },
    [backendUrl, vapidPublicKey]
  );

  // 3. Unsubscribe Action
  const unsubscribe = useCallback(
    async (rawToken?: string): Promise<boolean> => {
      setError(null);
      setLoading(true);

      try {
        if (!isPushNotificationSupported()) return false;

        const registration = await navigator.serviceWorker.ready;
        const activeSub = await registration.pushManager.getSubscription();

        if (activeSub) {
          // Tell backend to remove subscription endpoint
          const targetEndpoint = customBackendUrl
            ? `${backendUrl}/push/subscribe`
            : "/api/push/subscribe";

          await fetch(targetEndpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            credentials: "include",
            body: JSON.stringify({
              action: "unsubscribe",
              subscription: activeSub.toJSON(),
              token: rawToken || undefined,
            }),
          }).catch(async () => {
            // Fallback to legacy parent endpoint
            await fetch(`${backendUrl}/parent/push/subscribe`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              credentials: "include",
              body: JSON.stringify({
                action: "unsubscribe",
                subscription: activeSub.toJSON(),
                token: rawToken || undefined,
              }),
            }).catch(() => {});
          });

          // Unsubscribe locally in browser
          await activeSub.unsubscribe();
        }

        setSubscription(null);
        setIsSubscribed(false);
        return true;
      } catch (err: any) {
        console.error("[USE_WEB_PUSH UNSUBSCRIBE ERROR]", err);
        setError(err.message || "Failed to disable push notifications.");
        return false;
      } finally {
        setLoading(false);
      }
    },
    [backendUrl]
  );

  return {
    isSupported,
    isStandalone,
    permission,
    isSubscribed,
    subscription,
    loading,
    error,
    subscribe,
    unsubscribe,
  };
}
