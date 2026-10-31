import { sanitizeRelations, legacyRole } from "@/lib/relations";
import { avatarChange } from "@/lib/avatar";
import { updateAccount } from "@/lib/finance";
import { NextResponse } from "next/server";
import { encryptedAccount, legacyDataContext, unauthorized } from "@/lib/session";
import { clearCounterpartLink, reconcileManual, unlinkTransaction } from "@/lib/cuentix-sync";
import { createRuleForTransaction, generateDue, isDateKey, parseRecurrence, todayInBuenosAires } from "@/lib/recurring";
import { attachReceipt, receiptLinkable } from "@/lib/receipts-db";

export const dynamic = "force-dynamic";
const tableByResource = { contacts: "contacts", projects: "projects", tasks: "tasks", accounts: "financial_accounts", transactions: "financial_transactions", activities: "activities" } as const;
type Resource = keyof typeof tableByResource;
function str(v: unknown, max=5000): string { return typeof v === "string" ? v.trim().slice(0,max) : ""; }
function nullable(v: unknown, max=5000): string | null { return str(v,max) || null; }
function pick<T extends string>(v: unknown, values: readonly T[], fallback: T): T { return values.includes(v as T) ? v as T : fallback; }

export async function PATCH(request: Request, { params }: { params: Promise<{resource:string;id:string}> }) {
  const {resource,id}=await params;
  if (!(resource in tableByResource)) return NextResponse.json({error:"Not found"},{status:404});
  const ctx=await legacyDataContext(); if (!ctx) return unauthorized(); if ("encrypted" in ctx) return encryptedAccount();
  let b:Record<string,unknown>; try { b=await request.json() as Record<string,unknown>; } catch { return NextResponse.json({error:"Invalid JSON"},{status:400}); }
  const {db,userId}=ctx, now=Date.now();
  try {
    let result;
    switch(resource as Resource) {
      case "contacts": {
        const name=str(b.name,160); if(!name) return NextResponse.json({error:"El nombre es obligatorio"},{status:400});
        const rel=sanitizeRelations(b.relations);
        result=await db.prepare("UPDATE contacts SET kind=?,name=?,company_name=?,email=?,phone=?,notes=?,is_potential=?,role=?,relations=?,github_url=?,x_url=?,instagram_url=?,telegram_url=?,whatsapp_url=?,linkedin_url=?,updated_at=? WHERE id=? AND user_id=?").bind(pick(b.kind,["person","company"] as const,"person"),name,nullable(b.companyName,160),nullable(b.email,254),nullable(b.phone,80),nullable(b.notes),b.isPotential?1:0,legacyRole(rel),JSON.stringify(rel),nullable(b.githubUrl,500),nullable(b.xUrl,500),nullable(b.instagramUrl,500),nullable(b.telegramUrl,500),nullable(b.whatsappUrl,500),nullable(b.linkedinUrl,500),now,id,userId).run(); { const av=avatarChange(b); if(av!==undefined) await db.prepare("UPDATE contacts SET avatar_data=?, avatar_source=? WHERE id=? AND user_id=?").bind(av?av.data:null,av?av.source:null,id,userId).run(); } break;
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
        const updated=await updateAccount(db,userId,id,b,now);
        return NextResponse.json(updated.body,{status:updated.status});
      }
      case "activities": {
        const title=str(b.title,200), kind=pick(b.kind,["event","note"] as const,"note");
        const occurredAt=str(b.occurredAt,32) || new Date().toISOString();
        const contactIds=Array.isArray(b.contactIds)?[...new Set(b.contactIds.map(v=>str(v,80)).filter(Boolean))]:[];
        if(!title) return NextResponse.json({error:"El título es obligatorio"},{status:400});
        if(contactIds.length){
          const placeholders=contactIds.map(()=>"?").join(",");
          const linked=await db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE user_id=? AND id IN ("+placeholders+")").bind(userId,...contactIds).first<{count:number}>();
          if(Number(linked?.count||0)!==contactIds.length) return NextResponse.json({error:"Hay contactos inválidos"},{status:400});
        }
        result=await db.prepare("UPDATE activities SET kind=?,title=?,body=?,occurred_at=?,updated_at=? WHERE id=? AND user_id=?").bind(kind,title,nullable(b.body,30000),occurredAt,now,id,userId).run();
        if(result.meta.changes){
          await db.prepare("DELETE FROM activity_contacts WHERE activity_id=? AND user_id=?").bind(id,userId).run();
          for(const contactId of contactIds) await db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)").bind(id,contactId,userId).run();
        }
        break;
      }
      case "transactions": {
        if(b.unlink===true){
          const unlinked=await unlinkTransaction(db,userId,id,now);
          return NextResponse.json(unlinked.body,{status:unlinked.status});
        }
        const amount=Number(b.amountMinor), category=str(b.category,80);
        if(!Number.isSafeInteger(amount)||amount<=0||!category) return NextResponse.json({error:"Importe o categoría inválidos"},{status:400});
        const accountId=str(b.accountId,80), contactId=nullable(b.contactId,80);
        if(!(await db.prepare("SELECT id FROM financial_accounts WHERE id=? AND user_id=?").bind(accountId,userId).first())) return NextResponse.json({error:"Cuenta inválida"},{status:400});
        if(contactId && !(await db.prepare("SELECT id FROM contacts WHERE id=? AND user_id=?").bind(contactId,userId).first())) return NextResponse.json({error:"Contacto inválido"},{status:400});
        const kind=pick(b.kind,["income","expense"] as const,"expense"), occurredAt=str(b.occurredAt,10)||todayInBuenosAires(now);
        if(!isDateKey(occurredAt)) return NextResponse.json({error:"Fecha inválida"},{status:400});
        const receiptIdEarly=nullable(b.receiptId,80);
        if(receiptIdEarly && !(await receiptLinkable(db,userId,receiptIdEarly,id))) return NextResponse.json({error:"Ticket inválido"},{status:400});
        const existingTx=await db.prepare("SELECT source, deleted_at AS deletedAt, recurring_id AS recurringId, kind, amount_minor AS amountMinor, occurred_at AS occurredAt, account_id AS accountId FROM financial_transactions WHERE id=? AND user_id=?").bind(id,userId).first<{source:string|null;deletedAt:number|null;recurringId:string|null;kind:string;amountMinor:number;occurredAt:string;accountId:string}>();
        if(!existingTx||existingTx.deletedAt!=null) return NextResponse.json({error:"Registro no encontrado"},{status:404});
        if(existingTx.source){
          if(kind!==existingTx.kind||amount!==Number(existingTx.amountMinor)||occurredAt!==existingTx.occurredAt||accountId!==existingTx.accountId) return NextResponse.json({error:"El importe, la fecha y el tipo se editan en Cuentix"},{status:400});
          if(b.recurrence&&b.recurrence!=="none"&&b.recurrence!=="") return NextResponse.json({error:"Los movimientos de Cuentix no se repiten desde acá"},{status:400});
        }
        const recurrence=!existingTx.recurringId?parseRecurrence(b.recurrence,b.recurrenceEnd,occurredAt):null;
        if(typeof recurrence==="string") return NextResponse.json({error:recurrence},{status:400});
        result=await db.prepare("UPDATE financial_transactions SET account_id=?,contact_id=?,kind=?,amount_minor=?,category=?,description=?,occurred_at=? WHERE id=? AND user_id=?").bind(accountId,contactId,kind,amount,category,nullable(b.description),occurredAt,id,userId).run();
        if(result.meta.changes>0){
          const receiptId=nullable(b.receiptId,80);
          if(receiptId) await attachReceipt(db,userId,id,receiptId);
          else if(b.removeReceipt===true) await db.prepare("DELETE FROM receipts WHERE transaction_id=? AND user_id=?").bind(id,userId).run();
          if(recurrence){
            await createRuleForTransaction(db,userId,id,{accountId,contactId,kind,amountMinor:amount,category,description:nullable(b.description),anchorDate:occurredAt,recurrence},now);
            await generateDue(db,userId,todayInBuenosAires(now),now);
          }
          await reconcileManual(db,userId,id,now);
        }
        break;
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
  const ctx=await legacyDataContext(); if(!ctx) return unauthorized(); if ("encrypted" in ctx) return encryptedAccount();
  const table=tableByResource[resource as Resource];
  try {
    if(resource==="transactions"){
      const row=await ctx.db.prepare("SELECT source, linked_to AS linkedTo FROM financial_transactions WHERE id=? AND user_id=?").bind(id,ctx.userId).first<{source:string|null;linkedTo:string|null}>();
      if(!row) return NextResponse.json({error:"Registro no encontrado"},{status:404});
      if(row.source) return NextResponse.json({error:"Este movimiento se borra desde Cuentix"},{status:409});
      const removed=await ctx.db.prepare("DELETE FROM financial_transactions WHERE id=? AND user_id=?").bind(id,ctx.userId).run();
      if(removed.meta.changes===0) return NextResponse.json({error:"Registro no encontrado"},{status:404});
      await clearCounterpartLink(ctx.db,ctx.userId,row.linkedTo,Date.now());
      return NextResponse.json({ok:true});
    }
    const result=await ctx.db.prepare(`DELETE FROM ${table} WHERE id=? AND user_id=?`).bind(id,ctx.userId).run();
    if(result.meta.changes===0) return NextResponse.json({error:"Registro no encontrado"},{status:404});
    return NextResponse.json({ok:true});
  } catch(error) {
    console.error("workspace_delete_failed",{resource,error:String(error)});
    return NextResponse.json({error:"No se pudo eliminar. Puede haber registros relacionados."},{status:409});
  }
}
