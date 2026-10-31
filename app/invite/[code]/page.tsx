import { redirect } from "next/navigation";
import InviteAccept from "@/app/invite-accept";
import { INVITES_ENABLED } from "@/lib/invites";
import { sessionContext } from "@/lib/session";

export const dynamic = "force-dynamic";

const PAUSED_COPY = "Las invitaciones están pausadas por ahora. Volvé a probar más adelante.";

export default async function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const session = await sessionContext();
  if (session?.approvalStatus === "approved") redirect("/dashboard");
  const invitesPaused: boolean = !INVITES_ENABLED;

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <img className="auth-brand-icon" src="/icons/icon-192.v5.png" alt="" width="88" height="88" />
        <p className="eyebrow">SERPIX</p>
        <h1>Te invitaron a Serpix</h1>
        {invitesPaused ? <p className="auth-copy">{PAUSED_COPY}</p> : session ? <InviteAccept code={code} /> : (
          <>
            <p className="auth-copy">Iniciá sesión con Google para aceptar la invitación.</p>
            <a className="primary-button" href={"/login?next=" + encodeURIComponent("/invite/" + code)}>Iniciar sesión</a>
          </>
        )}
      </section>
    </main>
  );
}
