export async function getCloudflareContext() {
  return {
    env: globalThis.__testEnv ?? {},
    ctx: { waitUntil() {} },
  };
}
