import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PiSignage Dashboard",
  description: "Local mock dashboard for the PiSignage proof of concept"
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
