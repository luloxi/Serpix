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
    /** HMAC secret for Cuentix -> Serpix movement sync (wrangler secret put CUENTIX_SYNC_SECRET). Never log it. */
    CUENTIX_SYNC_SECRET: string;
    /** Luma ICS feed (wrangler secret put LUMA_ICS_URL). Optional: the sync logs luma_sync_skipped when unset. Never log the URL. */
    LUMA_ICS_URL?: string;
    /** AES-256-GCM key for the saved Luma ICS link, 64 hex chars. openssl rand -hex 32 | npx wrangler secret put LUMA_SETTINGS_KEY. Never log it or the URL. */
    LUMA_SETTINGS_KEY?: string;
  }
}
export {};
