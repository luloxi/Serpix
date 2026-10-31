export const ADMIN_EMAIL = "admin@test.local";

export async function getAuth() {
  return {
    api: {
      async getSession() {
        globalThis.__testSessionReads = (globalThis.__testSessionReads ?? 0) + 1;
        return globalThis.__testSession ?? null;
      },
    },
  };
}
