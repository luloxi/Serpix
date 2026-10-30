import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  if (session.user.approvalStatus !== "approved") redirect("/pending");
  if (session.user.role === "admin") redirect("/admin");

  return (
    <main className="workspace">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">ESPACIO DE TRABAJO</p>
          <h1>Hola, {session.user.name}</h1>
          <p>Tu cuenta está habilitada. Los módulos se habilitarán a medida que queden conectados a datos reales.</p>
        </div>
      </header>
      <section className="empty-state">
        <h2>Serpix se está configurando</h2>
        <p>No hay información de demostración ni registros inventados. El próximo módulo será CRM, con contactos persistidos en tu base de datos.</p>
      </section>
    </main>
  );
}
