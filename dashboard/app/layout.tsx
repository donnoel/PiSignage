import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { beamThemeCookieName, normalizeBeamThemeId } from "./theme";

export const metadata: Metadata = {
  title: "Beam - What's Playing",
  description: "Beam screen playback and health overview"
};

export default async function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const themeId = normalizeBeamThemeId(cookieStore.get(beamThemeCookieName)?.value);

  return (
    <html lang="en" data-beam-theme={themeId}>
      <body data-beam-theme={themeId}>{children}</body>
    </html>
  );
}
