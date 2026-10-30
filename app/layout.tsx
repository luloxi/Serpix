import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Serpix — Tu espacio de trabajo",
  description: "CRM, proyectos, tareas y finanzas en un solo espacio.",
  applicationName: "Serpix",
  manifest: "/manifest-v3.webmanifest",
  icons: {
    icon: [
      { url: "/icons/favicon.v3.ico", sizes: "any" },
      { url: "/icons/serpix-32.v3.png", type: "image/png", sizes: "32x32" },
      { url: "/icons/serpix-48.v3.png", type: "image/png", sizes: "48x48" },
      { url: "/icons/icon-192.v3.png", type: "image/png", sizes: "192x192" },
    ],
    shortcut: "/icons/favicon.v3.ico",
    apple: [{ url: "/icons/apple-touch-icon-180.v3.png", type: "image/png", sizes: "180x180" }],
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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: 'try{var t=localStorage.getItem("serpix-theme")==="dark"?"dark":"light";document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t}catch(e){}' }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
