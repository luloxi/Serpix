import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  if (session.user.approvalStatus !== "approved") redirect("/pending");
  if (session.user.role === "admin") redirect("/admin");
  redirect("/dashboard");
}
