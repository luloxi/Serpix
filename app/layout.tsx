import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Serpix — Tu espacio de trabajo",
  description: "CRM, proyectos, tareas y finanzas en un solo espacio.",
  applicationName: "Serpix",
  manifest: "/manifest-v2.webmanifest",
  icons: {
    icon: [{ url: "/icon", type: "image/png", sizes: "512x512" }],
    shortcut: "/icon",
    apple: [{ url: "/apple-icon", type: "image/png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Serpix",
  },
};

export const viewport: Viewport = {
  themeColor: "#B9E8F8",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
