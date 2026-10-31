import { headers } from "next/headers";
import { redirect } from "next/navigation";
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

export default async function HomePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
 const auth = await getAuth();
 const session = await auth.api.getSession({ headers: await headers() });
 const query = searchSuffix(await searchParams);
 if (!session) redirect("/login?next=" + encodeURIComponent("/" + query));
 if (session.user.approvalStatus !== "approved") redirect("/pending");
 redirect("/dashboard" + query);
}
