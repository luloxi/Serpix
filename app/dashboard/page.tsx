import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import E2eGateSlot from "@/app/e2e-gate-slot";
import Workspace from "@/app/workspace";
import { shouldMountGate } from "@/lib/e2e/gate";
import { encryptionMode } from "@/lib/e2e-server";
import type { D1Like } from "@/lib/finance";
import { getAuth } from "@/lib/auth";
export const dynamic = "force-dynamic";

type SearchParams = { [key: string]: string | string[] | undefined };

function searchSuffix(searchParams: SearchParams): string {
 const params = new URLSearchParams();
 for (const [key, value] of Object.entries(searchParams)) {
  if (typeof value === "string") params.append(key, value);
  else if (Array.isArray(value)) for (const item of value) params.append(key, item);
 }
 const query = params.toString();
 return query ? `?${query}` : "";
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
 const auth = await getAuth();
 const session = await auth.api.getSession({ headers: await headers() });
 const query = searchSuffix(await searchParams);
 if (!session) redirect("/login?next=" + encodeURIComponent("/dashboard" + query));
 if (session.user.approvalStatus !== "approved") redirect("/pending");
 const name = session.user.name;
 const email = session.user.email;
 const image = session.user.image ?? null;
 // Admin keeps today's workspace: no gate, no key fetch, no local engine.
 if (session.user.role === "admin") return <Workspace name={name} email={email} image={image} isAdmin />;
 const { env } = await getCloudflareContext({ async: true });
 const mode = await encryptionMode(env.DB as D1Like, session.user.id);
 if (!shouldMountGate({ role: session.user.role, encryptionMode: mode })) return <Workspace name={name} email={email} image={image} isAdmin={false} />;
 return <E2eGateSlot userId={session.user.id} encryptionMode={mode} name={name} email={email} image={image} />;
}
