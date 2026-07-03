"use client";

import { useEffect, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";

const SCREEN_FOCUS_STORAGE_KEY = "beam.whatsPlaying.selectedScreenId";

type ScreenFocusOption = {
  location: string;
  screenId: string;
  screenName: string;
};

type ScreenFocusSelectProps = {
  options: ScreenFocusOption[];
  selectedScreenId: string;
};

export function ScreenFocusSelect({ options, selectedScreenId }: ScreenFocusSelectProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const validScreenIds = useMemo(() => new Set(options.map((option) => option.screenId)), [options]);

  useEffect(() => {
    if (options.length === 0) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const currentView = params.get("view");
    if (currentView && currentView !== "dashboard") {
      return;
    }

    const hasExplicitScreen = params.has("screen");

    if (hasExplicitScreen) {
      if (selectedScreenId && validScreenIds.has(selectedScreenId)) {
        window.localStorage.setItem(SCREEN_FOCUS_STORAGE_KEY, selectedScreenId);
      }
      return;
    }

    const storedScreenId = window.localStorage.getItem(SCREEN_FOCUS_STORAGE_KEY);
    if (storedScreenId && validScreenIds.has(storedScreenId)) {
      if (storedScreenId !== selectedScreenId) {
        params.set("view", "dashboard");
        params.set("screen", storedScreenId);
        router.replace(`/?${params.toString()}`);
      }
      return;
    }

    if (storedScreenId) {
      window.localStorage.removeItem(SCREEN_FOCUS_STORAGE_KEY);
    }

    if (selectedScreenId && validScreenIds.has(selectedScreenId)) {
      window.localStorage.setItem(SCREEN_FOCUS_STORAGE_KEY, selectedScreenId);
    }
  }, [options.length, router, selectedScreenId, validScreenIds]);

  return (
    <div>
      <label htmlFor="screen-focus" className="sr-only">Choose screen to preview</label>
      <select
        id="screen-focus"
        value={selectedScreenId}
        disabled={isPending || options.length === 0}
        onChange={(event) => {
          const screenId = event.currentTarget.value;
          if (!screenId) {
            return;
          }
          window.localStorage.setItem(SCREEN_FOCUS_STORAGE_KEY, screenId);
          startTransition(() => {
            const params = new URLSearchParams(window.location.search);
            params.set("view", "dashboard");
            params.set("screen", screenId);
            router.push(`/?${params.toString()}`);
            router.refresh();
          });
        }}
        className="beam-control min-h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-950 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-zinc-100"
      >
        {options.length === 0 ? (
          <option value="">No screens in inventory</option>
        ) : (
          options.map((option) => (
            <option key={option.screenId} value={option.screenId}>
              {option.screenName} · {option.location}
            </option>
          ))
        )}
      </select>
    </div>
  );
}
