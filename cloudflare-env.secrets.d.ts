// Secret bindings are configured in Cloudflare and intentionally are not stored in Git.
declare global {
  interface CloudflareEnv {
    BETTER_AUTH_SECRET: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
  }
}
export {};
