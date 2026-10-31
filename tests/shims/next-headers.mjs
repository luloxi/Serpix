export async function headers() {
  const extra = globalThis.__testHeaders;
  return new Headers(extra && typeof extra === "object" ? extra : undefined);
}
