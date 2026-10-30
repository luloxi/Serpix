// Secret bindings are configured in Cloudflare and intentionally are not stored in wrangler.jsonc.
declare global {
  interface CloudflareEnv {
    BETTER_AUTH_SECRET: string;
    GOOGLE_CLIENT_SECRET: string;
  }
}
export {};
