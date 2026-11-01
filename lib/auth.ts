import { betterAuth } from "better-auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const APP_URL = "https://erp.lulox.com.ar";
export const ADMIN_EMAIL = "lucianoolivabianco@gmail.com";

export async function getAuth() {
  const { env } = await getCloudflareContext({ async: true });

  return betterAuth({
    appName: "Serpix",
    baseURL: APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [APP_URL],
    database: env.DB,
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    user: {
      additionalFields: {
        role: {
          type: ["admin", "user"],
          required: false,
          defaultValue: "user",
          input: false,
        },
        approvalStatus: {
          type: ["pending", "approved", "rejected"],
          required: false,
          defaultValue: "pending",
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const isAdmin = user.email.trim().toLowerCase() === ADMIN_EMAIL;
            return {
              data: {
                ...user,
                role: isAdmin ? "admin" : "user",
                approvalStatus: isAdmin ? "approved" : "pending",
              },
            };
          },
        },
      },
    },
    advanced: {
      database: {
        generateId: "uuid",
        // Our migrations own the schema; skip Better Auth's per-instance D1 pragma check.
        validateSchema: false,
      },
      useSecureCookies: true,
    },
  });
}
