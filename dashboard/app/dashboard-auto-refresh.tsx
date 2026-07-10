"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useTransition } from "react";

type DashboardAutoRefreshProps = {
  enabled?: boolean;
  intervalMs?: number;
};

function isEditingFormField(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  return Boolean(element.closest("input, textarea, select"));
}

export function DashboardAutoRefresh({ enabled = true, intervalMs = 10_000 }: DashboardAutoRefreshProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const pendingRef = useRef(false);

  useEffect(() => {
    pendingRef.current = isPending;
  }, [isPending]);

  const refresh = useCallback(() => {
    const activeElement = document.activeElement;
    if (
      !enabled ||
      pendingRef.current ||
      document.hidden ||
      isEditingFormField(activeElement) ||
      Boolean(activeElement instanceof Element && activeElement.closest("[data-refresh-busy='true'], [draggable='true']"))
    ) {
      return;
    }

    pendingRef.current = true;
    startTransition(() => {
      router.refresh();
    });
  }, [router, startTransition]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const interval = window.setInterval(refresh, intervalMs);
    const refreshWhenVisible = () => {
      if (!document.hidden) {
        refresh();
      }
    };

    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [enabled, intervalMs, refresh]);

  return null;
}
