import { NextResponse } from "next/server";
import { approvedContext, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";
type Row = { id: string; name: string; email: string; message: string; status: string; contactId: string | null; createdAt: number };

// Actions on one inquiry of the signed-in owner: read | unread | archive | unarchive | convert.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await approvedContext();
  if (!ctx) return unauthorized();
  let body: { action?: unknown };
  try { body = await request.json() as { action?: unknown }; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const db = ctx.db, userId = ctx.userId, now = Date.now();
  const row = await db.prepare("SELECT id, name, email, message, status, contact_id AS contactId, created_at AS createdAt FROM inquiries WHERE id=? AND user_id=?").bind(id, userId).first<Row>();
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  switch (body.action) {
    case "read": await db.prepare("UPDATE inquiries SET status='read', read_at=COALESCE(read_at,?) WHERE id=? AND user_id=? AND status='new'").bind(now, id, userId).run(); break;
    case "unread": await db.prepare("UPDATE inquiries SET status='new' WHERE id=? AND user_id=? AND status<>'archived'").bind(id, userId).run(); break;
    case "archive": await db.prepare("UPDATE inquiries SET status='archived', read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?").bind(now, id, userId).run(); break;
    case "unarchive": await db.prepare("UPDATE inquiries SET status='read' WHERE id=? AND user_id=? AND status='archived'").bind(id, userId).run(); break;
    case "convert": {
      if (row.contactId) return NextResponse.json({ ok: true, contactId: row.contactId, existed: true });
      // Never modifies a contact. If one already has this email, the inquiry is just linked to it.
      const dup = await db.prepare("SELECT id FROM contacts WHERE user_id=? AND lower(email)=? LIMIT 1").bind(userId, row.email.toLowerCase()).first<{ id: string }>();
      let contactId = dup?.id;
      if (!contactId) {
        contactId = crypto.randomUUID();
        const day = new Date(row.createdAt - 3 * 3600_000).toISOString().slice(0, 10);
        const notes = `Solicitud del portfolio (${day}):\n\n${row.message}`.slice(0, 5000);
        await db.prepare("INSERT INTO contacts (id,user_id,kind,name,email,notes,is_potential,role,relations,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(contactId, userId, "person", row.name, row.email, notes, 1, "client_potential", JSON.stringify({ client: "potential" }), now, now).run();
      }
      await db.prepare("UPDATE inquiries SET contact_id=?, status=CASE WHEN status='new' THEN 'read' ELSE status END, read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?").bind(contactId, now, id, userId).run();
      return NextResponse.json({ ok: true, contactId, existed: Boolean(dup) });
    }
    default: return NextResponse.json({ error: "Acción inválida" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
