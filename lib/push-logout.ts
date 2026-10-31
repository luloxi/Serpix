// Best-effort removal of THIS device's push subscription before the session cookie is gone.
export const PUSH_LOGOUT_TIMEOUT_MS = 2_500;

export type PushSubscriptionLike = { endpoint: string; unsubscribe: () => Promise<unknown> };
export type PushRegistrationLike = { pushManager: { getSubscription: () => Promise<PushSubscriptionLike | null> } };

export type PushLogoutDeps = {
  fetch: typeof fetch;
  getRegistration: () => Promise<PushRegistrationLike | null | undefined>;
  timeoutMs?: number;
};

/** Deletes the server row (needs the session) and then unsubscribes in the browser. Never throws. */
export async function removeDevicePush(deps: PushLogoutDeps): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? PUSH_LOGOUT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const work = (async () => {
    try {
      const reg = await deps.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) return;
      try {
        await deps.fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      } catch { /* the browser unsubscribe still runs */ }
      try { await sub.unsubscribe(); } catch { /* already gone */ }
    } catch { /* no service worker, or the lookup failed */ }
  })();
  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function browserPushDeps(): PushLogoutDeps {
  return {
    fetch,
    getRegistration() {
      if (typeof navigator === "undefined" || !navigator.serviceWorker) return Promise.resolve(null);
      return navigator.serviceWorker.getRegistration("/sw.js");
    },
  };
}

/** Push cleanup first (it needs the session), then sign-out. Cleanup never blocks logout past the timeout. */
export async function signOutClearingPush(signOut: () => Promise<unknown> | unknown, deps: PushLogoutDeps): Promise<void> {
  try { await removeDevicePush(deps); } catch { /* never block logout */ }
  await signOut();
}
