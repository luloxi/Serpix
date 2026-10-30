import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";
import { sanitizeRelations, legacyRole } from "@/lib/relations";
import { avatarChange } from "@/lib/avatar";

export const dynamic = "force-dynamic";
const resources = ["contacts", "projects", "tasks", "accounts", "transactions", "activities"] as const;
type Resource = typeof resources[number];

async function context() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.approvalStatus !== "approved") return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { env } = await getCloudflareContext({ async: true });
  return { userId: session.user.id, db: env.DB };
}
function validResource(value: string): value is Resource { return resources.includes(value as Resource); }
function str(value: unknown, max = 5000): string { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function nullable(value: unknown, max = 5000): string | null { return str(value, max) || null; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T { return allowed.includes(value as T) ? value as T : fallback; }

export async function GET(_request: Request, { params }: { params: Promise<{ resource: string }> }) {
  const { resource } = await params;
  if (!validResource(resource)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ctx = await context(); if ("response" in ctx) return ctx.response;
  const { db, userId } = ctx;
  let query: string;
  switch (resource) {
    case "contacts": query = "SELECT id, kind, name, company_name AS companyName, email, phone, notes, is_potential AS isPotential, role, relations, github_url AS githubUrl, CASE WHEN avatar_data IS NOT NULL THEN 1 ELSE 0 END AS hasAvatar, avatar_source AS avatarSource, updated_at AS updatedAt, x_url AS xUrl, instagram_url AS instagramUrl, telegram_url AS telegramUrl, whatsapp_url AS whatsappUrl, linkedin_url AS linkedinUrl, created_at AS createdAt FROM contacts WHERE user_id = ? ORDER BY name COLLATE NOCASE"; break;
    case "projects": query = "SELECT id, name, description, status, start_date AS startDate, due_date AS dueDate, created_at AS createdAt FROM projects WHERE user_id = ? ORDER BY updated_at DESC"; break;
    case "tasks": query = "SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date AS dueDate, t.project_id AS projectId, p.name AS projectName, t.contact_id AS contactId, c.name AS contactName FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.user_id = ? ORDER BY CASE t.status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, t.due_date"; break;
    case "accounts": query = "SELECT a.id, a.name, a.currency, a.opening_balance_minor AS openingBalanceMinor, a.opening_balance_minor + COALESCE((SELECT SUM(CASE WHEN t.kind = 'income' THEN t.amount_minor ELSE -t.amount_minor END) FROM financial_transactions t WHERE t.account_id = a.id AND t.user_id = a.user_id), 0) AS balanceMinor FROM financial_accounts a WHERE a.user_id = ? ORDER BY a.name"; break;
    case "transactions": query = "SELECT t.id, t.kind, t.amount_minor AS amountMinor, t.category, t.description, t.occurred_at AS occurredAt, t.account_id AS accountId, a.name AS accountName, a.currency, t.contact_id AS contactId, c.name AS contactName FROM financial_transactions t JOIN financial_accounts a ON a.id = t.account_id LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.user_id = ? ORDER BY t.occurred_at DESC, t.created_at DESC LIMIT 250"; break;
    case "activities": query = "SELECT a.id, a.kind, a.title, a.body, a.occurred_at AS occurredAt, a.created_at AS createdAt, (SELECT group_concat(ac.contact_id, ',') FROM activity_contacts ac WHERE ac.activity_id=a.id) AS contactIds, (SELECT group_concat(c.name, ', ') FROM activity_contacts ac JOIN contacts c ON c.id=ac.contact_id WHERE ac.activity_id=a.id) AS contactNames FROM activities a WHERE a.user_id = ? ORDER BY a.occurred_at DESC, a.created_at DESC LIMIT 500"; break;
  }
  const result = await db.prepare(query).bind(userId).all();
  return NextResponse.json({ items: result.results });
}

export async function POST(request: Request, { params }: { params: Promise<{ resource: string }> }) {
  const { resource } = await params;
  if (!validResource(resource)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ctx = await context(); if ("response" in ctx) return ctx.response;
  const { db, userId } = ctx;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const id = crypto.randomUUID(), now = Date.now();
  try {
    switch (resource) {
      case "contacts": {
        const name = str(body.name, 160); if (!name) return NextResponse.json({ error: "El nombre es obligatorio" }, { status: 400 });
        const rel = sanitizeRelations(body.relations);
        await db.prepare("INSERT INTO contacts (id,user_id,kind,name,company_name,email,phone,notes,is_potential,role,relations,github_url,x_url,instagram_url,telegram_url,whatsapp_url,linkedin_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,userId,oneOf(body.kind,["person","company"] as const,"person"),name,nullable(body.companyName,160),nullable(body.email,254),nullable(body.phone,80),nullable(body.notes),body.isPotential ? 1 : 0,legacyRole(rel),JSON.stringify(rel),nullable(body.githubUrl,500),nullable(body.xUrl,500),nullable(body.instagramUrl,500),nullable(body.telegramUrl,500),nullable(body.whatsappUrl,500),nullable(body.linkedinUrl,500),now,now).run();
        { const av = avatarChange(body); if (av) await db.prepare("UPDATE contacts SET avatar_data=?, avatar_source=? WHERE id=? AND user_id=?").bind(av.data, av.source, id, userId).run(); }
        break;
      }
      case "projects": {
        const name = str(body.name,160); if (!name) return NextResponse.json({ error: "El nombre es obligatorio" }, { status: 400 });
        await db.prepare("INSERT INTO projects (id,user_id,name,description,status,start_date,due_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(id,userId,name,nullable(body.description),oneOf(body.status,["active","paused","completed","archived"] as const,"active"),nullable(body.startDate,10),nullable(body.dueDate,10),now,now).run(); break;
      }
      case "tasks": {
        const title = str(body.title,200); if (!title) return NextResponse.json({ error: "El título es obligatorio" }, { status: 400 });
        const projectId = nullable(body.projectId,80), contactId = nullable(body.contactId,80);
        if (projectId && !(await db.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(projectId,userId).first())) return NextResponse.json({error:"Proyecto inválido"}, {status:400});
        if (contactId && !(await db.prepare("SELECT id FROM contacts WHERE id=? AND user_id=?").bind(contactId,userId).first())) return NextResponse.json({error:"Contacto inválido"}, {status:400});
        await db.prepare("INSERT INTO tasks (id,user_id,project_id,contact_id,title,description,status,priority,due_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(id,userId,projectId,contactId,title,nullable(body.description),oneOf(body.status,["todo","in_progress","done","cancelled"] as const,"todo"),oneOf(body.priority,["low","normal","high","urgent"] as const,"normal"),nullable(body.dueDate,10),now,now).run(); break;
      }
      case "accounts": {
        const name = str(body.name,100), currency = oneOf(body.currency,["ARS","USD"] as const,"ARS"), opening = Number(body.openingBalanceMinor ?? 0);
        if (!name || !Number.isSafeInteger(opening)) return NextResponse.json({error:"Nombre o saldo inválido"}, {status:400});
        await db.prepare("INSERT INTO financial_accounts (id,user_id,name,currency,opening_balance_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(id,userId,name,currency,opening,now,now).run(); break;
      }
      case "activities": {
        const title = str(body.title,200), kind = oneOf(body.kind,["event","note"] as const,"note");
        const occurredAt = str(body.occurredAt,32) || new Date().toISOString();
        const contactIds = Array.isArray(body.contactIds) ? [...new Set(body.contactIds.map(v=>str(v,80)).filter(Boolean))] : [];
        if (!title) return NextResponse.json({error:"El título es obligatorio"},{status:400});
        if (contactIds.length) {
          const placeholders = contactIds.map(()=>"?").join(",");
          const linked = await db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE user_id=? AND id IN ("+placeholders+")").bind(userId,...contactIds).first<{count:number}>();
          if (Number(linked?.count||0)!==contactIds.length) return NextResponse.json({error:"Hay contactos inválidos"},{status:400});
        }
        await db.prepare("INSERT INTO activities (id,user_id,kind,title,body,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(id,userId,kind,title,nullable(body.body,30000),occurredAt,now,now).run();
        for (const contactId of contactIds) await db.prepare("INSERT INTO activity_contacts (activity_id,contact_id) VALUES (?,?)").bind(id,contactId).run();
        break;
      }
      case "transactions": {
        const accountId = str(body.accountId,80), amount = Number(body.amountMinor), category = str(body.category,80);
        if (!accountId || !Number.isSafeInteger(amount) || amount <= 0 || !category) return NextResponse.json({error:"Cuenta, importe y categoría son obligatorios"}, {status:400});
        const account = await db.prepare("SELECT id,currency FROM financial_accounts WHERE id=? AND user_id=?").bind(accountId,userId).first<{id:string;currency:string}>();
        if (!account) return NextResponse.json({error:"Cuenta inválida"}, {status:400});
        const contactId = nullable(body.contactId,80);
        if (contactId && !(await db.prepare("SELECT id FROM contacts WHERE id=? AND user_id=?").bind(contactId,userId).first())) return NextResponse.json({error:"Contacto inválido"}, {status:400});
        await db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,contact_id,kind,amount_minor,category,description,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id,userId,accountId,contactId,oneOf(body.kind,["income","expense"] as const,"expense"),amount,category,nullable(body.description),str(body.occurredAt,10) || new Date().toISOString().slice(0,10),now).run(); break;
      }
    }
    return NextResponse.json({ ok: true, id }, { status: 201 });
  } catch (error) {
    console.error("workspace_create_failed", { resource, error: String(error) });
    return NextResponse.json({ error: "No se pudo guardar el registro" }, { status: 500 });
  }
}
