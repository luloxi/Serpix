import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Landing from "@/app/landing";
import { getAuth } from "@/lib/auth";
import { homeQuery, homeTarget, landingLang, type HomeSearchParams } from "@/lib/home";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Serpix",
  description: "Herramienta gratis que Luciano armó para él y sus amigos. Contactos, agenda, cuentas en ARS y USD, y comprobantes internos. Solo por invitación.",
};

export default async function HomePage({ searchParams }: { searchParams: Promise<HomeSearchParams> }) {
  const params = await searchParams;
  const query = homeQuery(params);
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  const target = homeTarget({
    session,
    approvalStatus: session ? session.user.approvalStatus : null,
    query,
  });
  if ("redirect" in target) redirect(target.redirect);
  return <Landing initialLang={landingLang(params)} />;
}
