// Secret bindings are configured in Cloudflare and intentionally are not stored in Git.
declare global {
  interface CloudflareEnv {
    BETTER_AUTH_SECRET: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    /** Shared secret the portfolio sends in x-serpix-secret (wrangler secret put). */
    PORTFOLIO_INBOUND_SECRET: string;
    /** VAPID private scalar, base64url (wrangler secret put). The public key is the VAPID_PUBLIC_KEY var. */
    VAPID_PRIVATE_KEY: string;
  }
}
export {};
