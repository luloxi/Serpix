import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import AdminUsers from "./users";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  if (session.user.role !== "admin") redirect("/");

  return (
    <main className="workspace">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">ADMINISTRACIÓN</p>
          <h1>Accesos a Serpix</h1>
          <p>Administrá quién puede ingresar a tu espacio.</p>
        </div>
      </header>
      <AdminUsers userId={session.user.id} />
    </main>
  );
}
