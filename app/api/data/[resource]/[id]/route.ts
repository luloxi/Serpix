import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";
const tableByResource = { contacts: "contacts", projects: "projects", tasks: "tasks", accounts: "financial_accounts", transactions: "financial_transactions" } as const;
type Resource = keyof typeof tableByResource;
async function context() {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.approvalStatus !== "approved") return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { env } = await getCloudflareContext({ async: true });
  return { userId: session.user.id, db: env.DB };
}
function str(v: unknown, max=5000): string { return typeof v === "string" ? v.trim().slice(0,max) : ""; }
function nullable(v: unknown, max=5000): string | null { return str(v,max) || null; }
function pick<T extends string>(v: unknown, values: readonly T[], fallback: T): T { return values.includes(v as T) ? v as T : fallback; }

export async function PATCH(request: Request, { params }: { params: Promise<{resource:string;id:string}> }) {
  const {resource,id}=await params;
  if (!(resource in tableByResource)) return NextResponse.json({error:"Not found"},{status:404});
  const ctx=await context(); if ("response" in ctx) return ctx.response;
  let b:Record<string,unknown>; try { b=await request.json() as Record<string,unknown>; } catch { return NextResponse.json({error:"Invalid JSON"},{status:400}); }
  const {db,userId}=ctx, now=Date.now();
  try {
    let result;
    switch(resource as Resource) {
      case "contacts": {
        const name=str(b.name,160); if(!name) return NextResponse.json({error:"El nombre es obligatorio"},{status:400});
        result=await db.prepare("UPDATE contacts SET kind=?,name=?,company_name=?,email=?,phone=?,notes=?,is_potential=?,updated_at=? WHERE id=? AND user_id=?").bind(pick(b.kind,["person","company"] as const,"person"),name,nullable(b.companyName,160),nullable(b.email,254),nullable(b.phone,80),nullable(b.notes),b.isPotential?1:0,now,id,userId).run(); break;
      }
      case "projects": {
        const name=str(b.name,160); if(!name) return NextResponse.json({error:"El nombre es obligatorio"},{status:400});
        result=await db.prepare("UPDATE projects SET name=?,description=?,status=?,start_date=?,due_date=?,updated_at=? WHERE id=? AND user_id=?").bind(name,nullable(b.description),pick(b.status,["active","paused","completed","archived"] as const,"active"),nullable(b.startDate,10),nullable(b.dueDate,10),now,id,userId).run(); break;
      }
      case "tasks": {
        const title=str(b.title,200); if(!title) return NextResponse.json({error:"El título es obligatorio"},{status:400});
        const projectId=nullable(b.projectId,80), contactId=nullable(b.contactId,80);
        if(projectId && !(await db.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(projectId,userId).first())) return NextResponse.json({error:"Proyecto inválido"},{status:400});
        if(contactId && !(await db.prepare("SELECT id FROM contacts WHERE id=? AND user_id=?").bind(contactId,userId).first())) return NextResponse.json({error:"Contacto inválido"},{status:400});
        result=await db.prepare("UPDATE tasks SET title=?,description=?,status=?,priority=?,due_date=?,project_id=?,contact_id=?,updated_at=? WHERE id=? AND user_id=?").bind(title,nullable(b.description),pick(b.status,["todo","in_progress","done","cancelled"] as const,"todo"),pick(b.priority,["low","normal","high","urgent"] as const,"normal"),nullable(b.dueDate,10),projectId,contactId,now,id,userId).run(); break;
      }
      case "accounts": {
        const name=str(b.name,100); if(!name) return NextResponse.json({error:"El nombre es obligatorio"},{status:400});
        const existing=await db.prepare("SELECT currency FROM financial_accounts WHERE id=? AND user_id=?").bind(id,userId).first<{currency:string}>();
        if(!existing) return NextResponse.json({error:"Cuenta inexistente"},{status:404});
        const currency=pick(b.currency,["ARS","USD"] as const,existing.currency as "ARS"|"USD");
        result=await db.prepare("UPDATE financial_accounts SET name=?,currency=?,updated_at=? WHERE id=? AND user_id=?").bind(name,currency,now,id,userId).run(); break;
      }
      case "transactions": {
        const amount=Number(b.amountMinor), category=str(b.category,80);
        if(!Number.isSafeInteger(amount)||amount<=0||!category) return NextResponse.json({error:"Importe o categoría inválidos"},{status:400});
        const accountId=str(b.accountId,80), contactId=nullable(b.contactId,80);
        if(!(await db.prepare("SELECT id FROM financial_accounts WHERE id=? AND user_id=?").bind(accountId,userId).first())) return NextResponse.json({error:"Cuenta inválida"},{status:400});
        if(contactId && !(await db.prepare("SELECT id FROM contacts WHERE id=? AND user_id=?").bind(contactId,userId).first())) return NextResponse.json({error:"Contacto inválido"},{status:400});
        result=await db.prepare("UPDATE financial_transactions SET account_id=?,contact_id=?,kind=?,amount_minor=?,category=?,description=?,occurred_at=? WHERE id=? AND user_id=?").bind(accountId,contactId,pick(b.kind,["income","expense"] as const,"expense"),amount,category,nullable(b.description),str(b.occurredAt,10)||new Date().toISOString().slice(0,10),id,userId).run(); break;
      }
    }
    if(result.meta.changes===0) return NextResponse.json({error:"Registro no encontrado"},{status:404});
    return NextResponse.json({ok:true});
  } catch(error) {
    console.error("workspace_update_failed",{resource,error:String(error)});
    return NextResponse.json({error:"No se pudo actualizar el registro"},{status:500});
  }
}

export async function DELETE(_request:Request,{params}:{params:Promise<{resource:string;id:string}>}) {
  const {resource,id}=await params;
  if(!(resource in tableByResource)) return NextResponse.json({error:"Not found"},{status:404});
  const ctx=await context(); if("response" in ctx) return ctx.response;
  const table=tableByResource[resource as Resource];
  try {
    const result=await ctx.db.prepare(`DELETE FROM ${table} WHERE id=? AND user_id=?`).bind(id,ctx.userId).run();
    if(result.meta.changes===0) return NextResponse.json({error:"Registro no encontrado"},{status:404});
    return NextResponse.json({ok:true});
  } catch(error) {
    console.error("workspace_delete_failed",{resource,error:String(error)});
    return NextResponse.json({error:"No se pudo eliminar. Puede haber registros relacionados."},{status:409});
  }
}
