export const beamThemeCookieName = "beam-theme";

export const beamThemes = [
  { id: "default", name: "Beam Default" },
  { id: "midnight", name: "Midnight Signal" },
  { id: "sunset", name: "Sunset Studio" },
  { id: "indigo", name: "Indigo Broadcast" },
  { id: "evergreen", name: "Evergreen Slate" }
] as const;

export type BeamThemeId = (typeof beamThemes)[number]["id"];

export function normalizeBeamThemeId(value: string | null | undefined): BeamThemeId {
  return beamThemes.some((theme) => theme.id === value) ? (value as BeamThemeId) : "default";
}

export function nextBeamThemeId(themeId: BeamThemeId): BeamThemeId {
  const index = beamThemes.findIndex((theme) => theme.id === themeId);
  const nextIndex = index === -1 ? 0 : (index + 1) % beamThemes.length;
  return beamThemes[nextIndex].id;
}

export function beamThemeName(themeId: BeamThemeId): string {
  return beamThemes.find((theme) => theme.id === themeId)?.name ?? beamThemes[0].name;
}
