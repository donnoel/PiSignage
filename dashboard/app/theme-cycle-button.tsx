"use client";

import { useState } from "react";
import {
  beamThemeCookieName,
  beamThemeName,
  type BeamThemeId,
  nextBeamThemeId,
  normalizeBeamThemeId
} from "./theme";

type ThemeCycleButtonProps = {
  initialThemeId: BeamThemeId;
};

const cookieMaxAgeSeconds = 60 * 60 * 24 * 365;

function persistTheme(themeId: BeamThemeId) {
  document.documentElement.dataset.beamTheme = themeId;
  document.body.dataset.beamTheme = themeId;
  window.localStorage.setItem(beamThemeCookieName, themeId);
  document.cookie = `${beamThemeCookieName}=${themeId}; Path=/; Max-Age=${cookieMaxAgeSeconds}; SameSite=Lax`;
}

export function ThemeCycleButton({ initialThemeId }: ThemeCycleButtonProps) {
  const [themeId, setThemeId] = useState(initialThemeId);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const nextThemeId = nextBeamThemeId(themeId);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label={`Change color theme. Current theme: ${beamThemeName(themeId)}. Next theme: ${beamThemeName(nextThemeId)}.`}
        title={`Change theme to ${beamThemeName(nextThemeId)}`}
        className="beam-logo-button flex h-9 w-9 items-center justify-center rounded-lg shadow-sm transition focus:outline-none"
        onClick={() => {
          const nextTheme = nextBeamThemeId(normalizeBeamThemeId(themeId));
          persistTheme(nextTheme);
          setThemeId(nextTheme);
          setAnnouncement(beamThemeName(nextTheme));
          window.setTimeout(() => setAnnouncement(null), 1400);
        }}
      >
        <svg viewBox="0 0 36 36" className="h-9 w-9" aria-hidden="true">
          <rect x="0" y="0" width="36" height="36" rx="8" fill="var(--beam-icon-bg)" />
          <rect x="8" y="10" width="14" height="16" rx="2.5" fill="none" stroke="var(--beam-icon-screen)" strokeWidth="2.4" />
          <path d="M20 13.5L30 9.5V26.5L20 22.5V13.5Z" fill="var(--beam-icon-primary)" />
          <path d="M20 16L30 13V23L20 20V16Z" fill="var(--beam-icon-secondary)" opacity="0.88" />
        </svg>
      </button>
      <span className="sr-only" aria-live="polite">
        {announcement ? `Theme changed to ${announcement}.` : ""}
      </span>
      {announcement ? (
        <span className="beam-theme-toast pointer-events-none absolute left-0 top-11 z-30 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold shadow-lg ring-1">
          {announcement}
        </span>
      ) : null}
    </div>
  );
}
