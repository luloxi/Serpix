import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./brand.css";
import "./urgency.css";
import "./documents.css";
import "./gastos.css";
import "./e2e.css";
import "./contacts.css";
import "./luma-settings.css";
import { E2eEngineSlot } from "./e2e-slot";

export const metadata: Metadata = {
  title: "Serpix — Tu espacio de trabajo",
  description: "CRM, proyectos, tareas y finanzas en un solo espacio.",
  applicationName: "Serpix",
  manifest: "/manifest-v7.webmanifest",
  icons: {
    icon: [
      { url: "/icons/favicon.v7.ico", sizes: "any" },
      { url: "/icons/favicon-32.v7.png", type: "image/png", sizes: "32x32" },
    ],
    shortcut: "/icons/favicon.v7.ico",
    apple: [{ url: "/icons/apple-touch-icon-180.v7.png", type: "image/png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Serpix",
  },
};

export const viewport: Viewport = {
  themeColor: "#080A12",
  width: "device-width",
  initialScale: 1,
};

// Nonce CSP requires a per-request render. The HTML cannot be cached as a static document;
// /theme-init.js and /_next/static still can.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Same value proxy.ts put in the CSP. 'strict-dynamic' ignores 'self', so this file needs the nonce too.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        {/* Parser-blocking on purpose: theme is set before first paint, and strict-dynamic needs the nonce on this tag. */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme-init.js" nonce={nonce} />
      </head>
      <body>
        <E2eEngineSlot />
        {children}
      </body>
    </html>
  );
}
