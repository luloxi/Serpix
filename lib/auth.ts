import { betterAuth } from "better-auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function getAuth() {
  const { env } = await getCloudflareContext({ async: true });

  return betterAuth({
    appName: "Serpix",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],
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
            const isAdmin = user.email.trim().toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
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
      database: { generateId: "uuid" },
      useSecureCookies: true,
    },
  });
}
