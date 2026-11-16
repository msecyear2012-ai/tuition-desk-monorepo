"use client";

import React, { createContext, useContext, useState, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

export interface HeaderConfig {
  title?: string;
  subtitle?: string;
  badgeText?: string;
  showNotifications?: boolean;
  showLogout?: boolean;
}

export interface AlertItem {
  id: string;
  type: "warning" | "error" | "info" | "success";
  title: string;
  message: string;
  link?: string;
  time: string;
  isRead?: boolean;
}

export interface HeaderContextType {
  headerConfig: HeaderConfig;
  setHeaderConfig: React.Dispatch<React.SetStateAction<HeaderConfig>>;
  alerts: AlertItem[];
  setAlerts: React.Dispatch<React.SetStateAction<AlertItem[]>>;
  unreadCount: number;
  setUnreadCount: React.Dispatch<React.SetStateAction<number>>;
  overdueCount: number;
  setOverdueCount: React.Dispatch<React.SetStateAction<number>>;
  isWhatsappConnected: boolean | null;
  setIsWhatsappConnected: React.Dispatch<React.SetStateAction<boolean | null>>;
  refreshAlerts: () => Promise<void>;
}

export type HeaderDispatchType = React.Dispatch<React.SetStateAction<HeaderConfig>>;

export const HeaderDispatchContext = createContext<HeaderDispatchType | undefined>(undefined);
const HeaderContext = createContext<HeaderContextType | undefined>(undefined);

export function HeaderProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [headerConfig, setHeaderConfigState] = useState<HeaderConfig>({});
  const prevPathname = useRef(pathname);

  // Global Dynamic Alerts & Badges State
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [overdueCount, setOverdueCount] = useState<number>(0);
  const [isWhatsappConnected, setIsWhatsappConnected] = useState<boolean | null>(null);

  // Stable header configuration updater with structural equality guard
  const updateHeaderConfig: React.Dispatch<React.SetStateAction<HeaderConfig>> =
    React.useCallback((action) => {
      setHeaderConfigState((prev) => {
        const next = typeof action === "function" ? action(prev) : action;
        if (
          prev.title === next.title &&
          prev.subtitle === next.subtitle &&
          prev.badgeText === next.badgeText &&
          prev.showNotifications === next.showNotifications &&
          prev.showLogout === next.showLogout
        ) {
          return prev;
        }
        return next;
      });
    }, []);

  const isParentPortal =
    pathname?.startsWith("/p/") || pathname === "/login" || pathname === "/parent";

  const refreshAlerts = React.useCallback(async () => {
    if (isParentPortal) return;

    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const data = await res.json();
      if (data?.success && Array.isArray(data.alerts)) {
        const resolvedOverdueCount =
          typeof data.overdueCount === "number" ? data.overdueCount : 0;
        setOverdueCount(resolvedOverdueCount);

        const waConnected =
          typeof data.isWhatsappConnected === "boolean"
            ? data.isWhatsappConnected
            : data.alerts.some((a: AlertItem) => a.id === "alert-whatsapp-online");
        setIsWhatsappConnected(waConnected);

        // Filter alerts conditionally:
        // - Overdue Fees: Show ONLY if overdueCount > 0
        // - WhatsApp Active/Offline: Show strictly based on real socket connection status
        const filteredAlerts: AlertItem[] = data.alerts.filter((alert: AlertItem) => {
          if (alert.id === "alert-overdue-fees") {
            return resolvedOverdueCount > 0;
          }
          if (alert.id === "alert-whatsapp-online") {
            return waConnected === true;
          }
          if (alert.id === "alert-whatsapp-disconnected") {
            return waConnected === false;
          }
          return true;
        });

        setAlerts(filteredAlerts);

        const resolvedUnread =
          typeof data.unreadCount === "number"
            ? data.unreadCount
            : filteredAlerts.filter((a) => a.isRead === false).length;
        setUnreadCount(resolvedUnread);
      }
    } catch {
      // Gracefully ignore fetch errors
    }
  }, [isParentPortal]);

  // Initial fetch on mount & listen to live collection recorded events
  useEffect(() => {
    let ignore = false;
    void (async () => {
      if (!ignore) {
        await refreshAlerts();
      }
    })();

    const handleLiveCollection = () => {
      void refreshAlerts();
    };

    window.addEventListener("msec:collection-recorded", handleLiveCollection);
    return () => {
      ignore = true;
      window.removeEventListener("msec:collection-recorded", handleLiveCollection);
    };
  }, [refreshAlerts]);

  // Clear page-specific header overrides whenever the user navigates to a new route
  useEffect(() => {
    if (prevPathname.current !== pathname) {
      prevPathname.current = pathname;
      updateHeaderConfig({});
    }
  }, [pathname, updateHeaderConfig]);

  const contextValue = React.useMemo<HeaderContextType>(
    () => ({
      headerConfig,
      setHeaderConfig: updateHeaderConfig,
      alerts,
      setAlerts,
      unreadCount,
      setUnreadCount,
      overdueCount,
      setOverdueCount,
      isWhatsappConnected,
      setIsWhatsappConnected,
      refreshAlerts,
    }),
    [
      headerConfig,
      updateHeaderConfig,
      alerts,
      unreadCount,
      overdueCount,
      isWhatsappConnected,
      refreshAlerts,
    ]
  );

  return (
    <HeaderDispatchContext.Provider value={updateHeaderConfig}>
      <HeaderContext.Provider value={contextValue}>
        {children}
      </HeaderContext.Provider>
    </HeaderDispatchContext.Provider>
  );
}

export function useHeader() {
  return useContext(HeaderContext);
}

/**
 * Hook enabling any page or view to dynamically customize the persistent TopHeader.
 */
export function useSetHeader(config: HeaderConfig) {
  const setHeaderConfig = useContext(HeaderDispatchContext);

  useEffect(() => {
    if (!setHeaderConfig) return;
    setHeaderConfig((prev) => {
      if (
        prev.title === config.title &&
        prev.subtitle === config.subtitle &&
        prev.badgeText === config.badgeText &&
        prev.showNotifications === config.showNotifications &&
        prev.showLogout === config.showLogout
      ) {
        return prev;
      }
      return {
        ...prev,
        ...config,
      };
    });
  }, [
    setHeaderConfig,
    config.title,
    config.subtitle,
    config.badgeText,
    config.showNotifications,
    config.showLogout,
  ]);
}
