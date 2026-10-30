import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import Workspace from "@/app/workspace";
export const dynamic = "force-dynamic";
export default async function DashboardPage() {
 const auth = await getAuth();
 const session = await auth.api.getSession({ headers: await headers() });
 if (!session) redirect("/login");
 if (session.user.approvalStatus !== "approved") redirect("/pending");
 return <Workspace name={session.user.name} isAdmin={session.user.role === "admin"} />;
}
