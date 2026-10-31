import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Browser-only. The server build keeps real next/server and real @/lib/session.
  turbopack: {
    resolveAlias: {
      "next/server": { browser: "./lib/e2e/shims/next-server.ts" },
      "@/lib/session": { browser: "./lib/e2e/shims/session.ts" },
    },
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();
