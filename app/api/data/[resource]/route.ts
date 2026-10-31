import { NextResponse } from "next/server";
import { encryptedAccount, encryptedWriteResponse, legacyDataContext, unauthorized } from "@/lib/session";
import { sanitizeRelations, legacyRole } from "@/lib/relations";
import { avatarChange } from "@/lib/avatar";
import { ACCOUNTS_SQL, TX_VISIBLE } from "@/lib/finance";
import { reconcileManual } from "@/lib/cuentix-sync";
import { createRuleForTransaction, generateDue, isDateKey, parseRecurrence, todayInBuenosAires } from "@/lib/recurring";
import { attachReceipt, receiptLinkable } from "@/lib/receipts-db";

export const dynamic = "force-dynamic";
const resources = ["contacts", "projects", "tasks", "accounts", "transactions", "activities"] as const;
type Resource = typeof resources[number];

function validResource(value: string): value is Resource { return resources.includes(value as Resource); }
function str(value: unknown, max = 5000): string { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function nullable(value: unknown, max = 5000): string | null { return str(value, max) || null; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T { return allowed.includes(value as T) ? value as T : fallback; }
function pageInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function GET(request: Request, { params }: { params: Promise<{ resource: string }> }) {
  const { resource } = await params;
  if (!validResource(resource)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ctx = await legacyDataContext(); if (!ctx) return unauthorized(); if ("encrypted" in ctx) return encryptedAccount();
  const { db, userId } = ctx;
  if (resource === "transactions") {
    const url = new URL(request.url);
    const limit = pageInt(url.searchParams.get("limit"), 250, 1, 5000);
    const offset = pageInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const query = "SELECT t.id, t.kind, t.amount_minor AS amountMinor, t.category, t.description, t.occurred_at AS occurredAt, t.account_id AS accountId, a.name AS accountName, a.currency, t.contact_id AS contactId, c.name AS contactName, t.recurring_id AS recurringId, t.source AS source, t.linked_to AS linkedTo, t.excluded_from_totals AS excludedFromTotals, (SELECT r.id FROM receipts r WHERE r.transaction_id = t.id AND r.user_id = t.user_id LIMIT 1) AS receiptId FROM financial_transactions t JOIN financial_accounts a ON a.id = t.account_id AND a.user_id = t.user_id LEFT JOIN contacts c ON c.id = t.contact_id AND c.user_id = t.user_id WHERE t.user_id = ? AND " + TX_VISIBLE + " ORDER BY t.occurred_at DESC, t.created_at DESC LIMIT ? OFFSET ?";
    const result = await db.prepare(query).bind(userId, limit, offset).all();
    return NextResponse.json({ items: result.results });
  }
  let query: string;
  switch (resource) {
    case "contacts": query = "SELECT id, kind, name, company_name AS companyName, email, phone, notes, is_potential AS isPotential, role, relations, github_url AS githubUrl, CASE WHEN avatar_data IS NOT NULL THEN 1 ELSE 0 END AS hasAvatar, avatar_source AS avatarSource, avatar_tried_at AS avatarTriedAt, avatar_tried_key AS avatarTriedKey, updated_at AS updatedAt, x_url AS xUrl, instagram_url AS instagramUrl, telegram_url AS telegramUrl, whatsapp_url AS whatsappUrl, linkedin_url AS linkedinUrl, created_at AS createdAt FROM contacts WHERE user_id = ? ORDER BY name COLLATE NOCASE"; break;
    case "projects": query = "SELECT id, name, description, status, start_date AS startDate, due_date AS dueDate, created_at AS createdAt FROM projects WHERE user_id = ? ORDER BY updated_at DESC"; break;
    case "tasks": query = "SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date AS dueDate, t.project_id AS projectId, p.name AS projectName, t.contact_id AS contactId, c.name AS contactName FROM tasks t LEFT JOIN projects p ON p.id = t.project_id AND p.user_id = t.user_id LEFT JOIN contacts c ON c.id = t.contact_id AND c.user_id = t.user_id WHERE t.user_id = ? ORDER BY CASE t.status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, t.due_date"; break;
    case "accounts": query = ACCOUNTS_SQL; break;
    case "activities": query = "SELECT a.id, a.kind, a.title, a.body, a.occurred_at AS occurredAt, a.created_at AS createdAt, (SELECT group_concat(ac.contact_id, ',') FROM activity_contacts ac WHERE ac.activity_id=a.id AND ac.user_id=a.user_id) AS contactIds, (SELECT group_concat(c.name, ', ') FROM activity_contacts ac JOIN contacts c ON c.id=ac.contact_id AND c.user_id=ac.user_id WHERE ac.activity_id=a.id AND ac.user_id=a.user_id) AS contactNames FROM activities a WHERE a.user_id = ? ORDER BY a.occurred_at DESC, a.created_at DESC LIMIT 500"; break;
  }
  const result = await db.prepare(query).bind(userId).all();
  return NextResponse.json({ items: result.results });
}

export async function POST(request: Request, { params }: { params: Promise<{ resource: string }> }) {
  const { resource } = await params;
  if (!validResource(resource)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ctx = await legacyDataContext(); if (!ctx) return unauthorized(); if ("encrypted" in ctx) return encryptedAccount();
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
        for (const contactId of contactIds) await db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").bind(id,contactId,userId).run();
        break;
      }
      case "transactions": {
        const accountId = str(body.accountId,80), amount = Number(body.amountMinor), category = str(body.category,80);
        if (!accountId || !Number.isSafeInteger(amount) || amount <= 0 || !category) return NextResponse.json({error:"Cuenta, importe y categoría son obligatorios"}, {status:400});
        const account = await db.prepare("SELECT id,currency FROM financial_accounts WHERE id=? AND user_id=?").bind(accountId,userId).first<{id:string;currency:string}>();
        if (!account) return NextResponse.json({error:"Cuenta inválida"}, {status:400});
        const contactId = nullable(body.contactId,80);
        if (contactId && !(await db.prepare("SELECT id FROM contacts WHERE id=? AND user_id=?").bind(contactId,userId).first())) return NextResponse.json({error:"Contacto inválido"}, {status:400});
        const kind = oneOf(body.kind,["income","expense"] as const,"expense"), occurredAt = str(body.occurredAt,10) || todayInBuenosAires(now);
        if (!isDateKey(occurredAt)) return NextResponse.json({error:"Fecha inválida"}, {status:400});
        const recurrence = parseRecurrence(body.recurrence, body.recurrenceEnd, occurredAt);
        if (typeof recurrence === "string") return NextResponse.json({error:recurrence}, {status:400});
        const receiptId = nullable(body.receiptId,80);
        if (receiptId && !(await receiptLinkable(db, userId, receiptId, null))) return NextResponse.json({error:"Ticket inválido"}, {status:400});
        await db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,contact_id,kind,amount_minor,category,description,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id,userId,accountId,contactId,kind,amount,category,nullable(body.description),occurredAt,now).run();
        if (receiptId && !(await attachReceipt(db,userId,id,receiptId))) {
          await db.prepare("DELETE FROM financial_transactions WHERE id=? AND user_id=?").bind(id, userId).run();
          return NextResponse.json({error:"Ticket inválido"}, {status:400});
        }
        if (recurrence) {
          await createRuleForTransaction(db,userId,id,{accountId,contactId,kind,amountMinor:amount,category,description:nullable(body.description),anchorDate:occurredAt,recurrence},now);
          await generateDue(db,userId,todayInBuenosAires(now),now);
        }
        await reconcileManual(db, userId, id, now);
        break;
      }
    }
    return NextResponse.json({ ok: true, id }, { status: 201 });
  } catch (error) {
    const blocked = encryptedWriteResponse(error);
    if (blocked) return blocked;
    console.error("workspace_create_failed", { resource, error: String(error) });
    return NextResponse.json({ error: "No se pudo guardar el registro" }, { status: 500 });
  }
}
