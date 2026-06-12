import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Beam - What's Playing",
  description: "Beam screen playback and health overview"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
