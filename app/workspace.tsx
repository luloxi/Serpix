"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { mailtoxComposeUrl } from "@/lib/mailtox-url";
import AdminUsers from "@/app/admin/users";
import Agenda, { Markdown } from "@/app/agenda";
import { AVATAR_EXTERNAL_CONTINUE, AVATAR_EXTERNAL_WARNING, AvatarError, autoAvatar, autoEligible, avatarFetchStep, fetchAvatar, handleOf, shouldAutoAvatarOnSave, sourcesKey, toSmallWebp, waNumber, type AvatarSource } from "@/lib/avatar-client";
import { contactRelations, RELATION_KEYS, RELATION_LABEL, type RelationKey, type RelationState, type Relations } from "@/lib/relations";
import { ArrowRight, AlertCircle, CalendarOff, Clock, UserRound, ListChecks, CalendarClock, House, Users, Wallet, ShieldCheck, Sun, Moon, Plus, ContactRound, ListPlus, WalletCards, CalendarDays, NotebookPen, ReceiptText, TrendingDown, Timer, Inbox, MessageCircle, Search, Paperclip, ScanLine } from "lucide-react";
import AddSheet, { type AddSheetAction } from "@/app/add-sheet";
import Inquiries, { type Inquiry } from "@/app/inquiries";
import InvitesAdmin from "@/app/invites-admin";
import PushToggle from "@/app/push-toggle";
import ReceiptField from "@/app/receipt-field";
import { RecurrenceField, RecurringBadge, RecurringPanel, type RecurringRule } from "@/app/recurring";
import type { ScanResponse } from "@/lib/receipt-client";
import MonthHeading from "@/app/month-heading";
import TimerHost, { TimeEntriesPanel, readTimerCache, writeTimerCache, type TimeEntry, type TimerView } from "@/app/timer";
import { useDocuments } from "@/app/documents";
import { toneClass } from "@/lib/palette";
import { createCoalescedLoader } from "@/lib/coalesce";
import { clockSkew, parseTimerState, type TimerState } from "@/lib/timer";
import { DEFAULT_NAV, buildSearch, buildUrl, closeLayer, layerOf, openLayer, parseNav, pushScreen, refine as refineHistory, sameNav, type EditTarget, type Layer, type NavState, type Section } from "@/lib/nav";

const NavIcons = { home: House, contacts: Users, activity: CalendarDays, finance: Wallet, admin: ShieldCheck };
import SignOutButton from "@/app/sign-out-button";

type FinTotals = { ARS: { incomeMinor: number; expenseMinor: number }; USD: { incomeMinor: number; expenseMinor: number }; transactionCount: number };
type Item = Record<string, string | number | boolean | null | undefined> & { id: string };
type Field = { key:string; label:string; type?:"text"|"textarea"|"select"|"segmented"|"relations"|"avatar"|"date"|"datetime-local"|"number"|"email"|"tel"; required?:boolean; options?:{value:string;label:string}[]; placeholder?:string };
const sections:{id:Section;label:string;short:string}[]=[
  {id:"home",label:"Resumen",short:"Inicio"},{id:"contacts",label:"Contactos",short:"CRM"},
  {id:"activity",label:"Agenda",short:"Agenda"},
  {id:"finance",label:"Finanzas",short:"Finanzas"},{id:"admin",label:"Accesos",short:"Admin"}
];
const empty:Record<string,string>={};
const contactFields:Field[]=[{key:"name",label:"Nombre",required:true},{key:"avatar",label:"Foto",type:"avatar"},{key:"kind",label:"Tipo",type:"segmented",options:[{value:"person",label:"Persona"},{value:"company",label:"Empresa"}]},{key:"relations",label:"Relación",type:"relations"},{key:"companyName",label:"Empresa / organización"},{key:"email",label:"Email",type:"email"},{key:"phone",label:"Teléfono",type:"tel",placeholder:"+54 …"},{key:"xUrl",label:"X",placeholder:"@usuario o enlace"},{key:"instagramUrl",label:"Instagram",placeholder:"@usuario o enlace"},{key:"telegramUrl",label:"Telegram",placeholder:"@usuario o enlace"},{key:"whatsappUrl",label:"WhatsApp",placeholder:"@usuario o enlace"},{key:"linkedinUrl",label:"LinkedIn",placeholder:"@usuario o enlace"},{key:"githubUrl",label:"GitHub",placeholder:"@usuario o enlace"},{key:"notes",label:"Ideas y notas sobre el contacto",type:"textarea"}];
const projectFields:Field[]=[{key:"name",label:"Nombre",required:true},{key:"description",label:"Descripción",type:"textarea"},{key:"status",label:"Estado",type:"select",options:[{value:"active",label:"Activo"},{value:"paused",label:"Pausado"},{value:"completed",label:"Completado"},{value:"archived",label:"Archivado"}]},{key:"startDate",label:"Inicio",type:"date"},{key:"dueDate",label:"Fecha límite",type:"date"}];
const taskFields:Field[]=[{key:"title",label:"Tarea",required:true},{key:"description",label:"Descripción",type:"textarea"},{key:"status",label:"Estado",type:"segmented",options:[{value:"todo",label:"Pendiente"},{value:"in_progress",label:"En curso"},{value:"done",label:"Hecha"},{value:"cancelled",label:"Cancelada"}]},{key:"priority",label:"Prioridad",type:"segmented",options:[{value:"low",label:"Baja"},{value:"normal",label:"Normal"},{value:"high",label:"Alta"},{value:"urgent",label:"Urgente"}]},{key:"projectId",label:"Proyecto",type:"select"},{key:"contactId",label:"Contacto",type:"select"},{key:"dueDate",label:"Vencimiento",type:"date"}];
const accountFields:Field[]=[{key:"name",label:"Nombre de la cuenta",required:true},{key:"currency",label:"Moneda",type:"segmented",options:[{value:"ARS",label:"ARS"},{value:"USD",label:"USD"}]},{key:"openingBalance",label:"Saldo inicial",type:"number",placeholder:"0,00"}];
const activityFields:Field[]=[{key:"title",label:"Título",required:true},{key:"occurredAt",label:"Fecha y hora",type:"datetime-local",required:true},{key:"body",label:"Contenido / notas",type:"textarea"}];
const transactionFields:Field[]=[{key:"kind",label:"Tipo",type:"segmented",options:[{value:"expense",label:"Gasto"},{value:"income",label:"Ingreso"}]},{key:"amount",label:"Importe",type:"number",required:true,placeholder:"0,00"},{key:"category",label:"Categoría",required:true,placeholder:"Ej. Servicios, ventas, alquiler"},{key:"accountId",label:"Cuenta",type:"select",required:true},{key:"contactId",label:"Contacto",type:"select"},{key:"occurredAt",label:"Fecha",type:"date"},{key:"description",label:"Detalle",type:"textarea"}];
const recurringFields:Field[]=[{key:"amount",label:"Importe",type:"number",required:true,placeholder:"0,00"},{key:"category",label:"Categoría",required:true},{key:"accountId",label:"Cuenta",type:"select",required:true},{key:"endDate",label:"Termina (opcional)",type:"date"},{key:"description",label:"Detalle",type:"textarea"}];
const socialHref=(kind:"x"|"instagram"|"telegram"|"whatsapp"|"linkedin"|"github",raw:unknown):string|null=>{
  const v=String(raw||"").trim();if(!v)return null;
  if(/^https?:\/\//i.test(v)){try{const u=new URL(v);return u.href;}catch{return null;}}
  if(/^[a-z]+:/i.test(v))return null;
  const h=v.replace(/^@/,"").replace(/^(www\.)?(x\.com|twitter\.com|instagram\.com|t\.me|github\.com|linkedin\.com\/in)\//i,"");
  if(kind==="whatsapp"){const d=v.replace(/[^\d]/g,"");return d?"https://wa.me/"+d:null;}
  if(!/^[\w.\-]+$/.test(h))return null;
  return ({x:"https://x.com/",instagram:"https://instagram.com/",telegram:"https://t.me/",linkedin:"https://linkedin.com/in/",github:"https://github.com/"} as const)[kind]+h;
};
const money=(minor:number,currency:string)=>new Intl.NumberFormat("es-AR",{style:"currency",currency,maximumFractionDigits:2}).format(minor/100);
const dateLabel=(value:unknown)=>typeof value==="string"&&value?new Date(value+"T12:00:00").toLocaleDateString("es-AR"):"Sin fecha";
const labelStatus=(value:unknown)=>({active:"Activo",paused:"Pausado",completed:"Completado",archived:"Archivado",todo:"Pendiente",in_progress:"En curso",done:"Hecha",cancelled:"Cancelada",low:"Baja",normal:"Normal",high:"Alta",urgent:"Urgente"} as Record<string,string>)[String(value)]??String(value??"—");
const fieldsFor=(resource:string)=>resource==="contacts"?contactFields:resource==="projects"?projectFields:resource==="tasks"?taskFields:resource==="accounts"?accountFields:resource==="activities"?activityFields:resource==="recurring"?recurringFields:transactionFields;
function editorSeed(resource:string,item:Item|undefined,accountList:Item[]):Record<string,string>{
  const initial:Record<string,string>={};
  for(const f of fieldsFor(resource)){const v=item?.[f.key];initial[f.key]=v===undefined||v===null?"":String(v);}
  if(resource==="contacts"&&item)initial.isPotential=String(Boolean(item.isPotential));
  if(resource==="contacts")initial.relations=JSON.stringify(contactRelations(item?.relations,item?.role));
  if(resource==="activities"&&item){initial.contactIds=String(item.contactIds||"").split(",").filter(Boolean).join(",");initial.occurredAt=String(item.occurredAt||"").replace(" ","T").slice(0,16);}
  if(resource==="accounts"&&item)initial.openingBalance=(Number(item.openingBalanceMinor||0)/100).toFixed(2);
  if(resource==="transactions"&&item)initial.amount=(Number(item.amountMinor||0)/100).toFixed(2);
  if(resource==="recurring"&&item){initial.amount=(Number(item.amountMinor||0)/100).toFixed(2);initial.endDate=String(item.endDate||"");}
  if(resource==="transactions"){initial.receiptId=String(item?.receiptId||"");initial.recurrence="";initial.recurrenceEnd="";}
  if(resource==="contacts"&&!item){initial.kind="person";initial.isPotential="false";initial.phone="+54 ";}
  if(resource==="projects"&&!item)initial.status="active";
  if(resource==="tasks"&&!item){initial.status="todo";initial.priority="normal";}
  if(resource==="accounts"&&!item){initial.currency="ARS";initial.openingBalance="0";}
  if(resource==="transactions"&&!item){initial.kind="expense";initial.occurredAt=new Date().toISOString().slice(0,10);initial.accountId=String(accountList[0]?.id??"");}
  if(resource==="activities"&&!item){initial.occurredAt=new Date(new Date().getTime()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);initial.contactIds="";}
  return initial;
}
function urlEdit(section:Section,resource:string,id:string):EditTarget|null{
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(id))return null;
  if(section==="contacts"&&resource==="contacts")return{resource:"contacts",id};
  if(section==="activity"&&resource==="tasks")return{resource:"tasks",id};
  if(section==="activity"&&resource==="activities")return{resource:"activities",id};
  if(section==="finance"&&resource==="accounts")return{resource:"accounts",id};
  if(section==="finance"&&resource==="transactions")return{resource:"transactions",id};
  return null;
}
const itemsOf=(resource:string,lists:{contacts:Item[];projects:Item[];tasks:Item[];accounts:Item[];transactions:Item[];activities:Item[]})=>resource==="contacts"?lists.contacts:resource==="projects"?lists.projects:resource==="tasks"?lists.tasks:resource==="accounts"?lists.accounts:resource==="transactions"?lists.transactions:lists.activities;

export default function Workspace({name,email,image,isAdmin,e2e=false,e2eMenu}:{name:string;email:string;image:string|null;isAdmin:boolean;e2e?:boolean;e2eMenu?:ReactNode}) {
  const [nav,setNav]=useState<NavState>(DEFAULT_NAV);
  const navRef=useRef(nav);
  const section=nav.section,contactsTab=nav.contactsView,openInquiry=nav.inquiryId,roleFilter=nav.role,stateFilter=nav.relState;
  const [histLayer,setHistLayer]=useState<Layer|null>(null);
  const [theme,setTheme]=useState<"light"|"dark">("light");
  const [addMenuOpen,setAddMenuOpen]=useState(false);
  const [profileMenuOpen,setProfileMenuOpen]=useState(false);
  const profileMenuRef=useRef<HTMLDivElement>(null);
  const addTriggerRef=useRef<HTMLButtonElement>(null);
  const timerClosing=useRef(false);
  const armTimer=useRef(false);
  const booted=useRef(false);
  const editorRef=useRef<{resource:string;item?:Item}|null>(null);
  const seenContact=useRef<string|null>(null);
  const txLimitRef=useRef(250);
  const lastLoadAt=useRef(0);
  const loaderRef=useRef<((silent?:boolean)=>Promise<void>)|null>(null);
  const [inquiries,setInquiries]=useState<Inquiry[]>([]);
  const unreadInquiries=inquiries.filter(i=>i.status==="new").length;
  const [contacts,setContacts]=useState<Item[]>([]),[projects,setProjects]=useState<Item[]>([]),[tasks,setTasks]=useState<Item[]>([]),[accounts,setAccounts]=useState<Item[]>([]),[transactions,setTransactions]=useState<Item[]>([]),[activities,setActivities]=useState<Item[]>([]);
  const [finTotals,setFinTotals]=useState<FinTotals|null>(null);
  const [rules,setRules]=useState<RecurringRule[]>([]);
  const [txLimit,setTxLimit]=useState(250);
  const [loading,setLoading]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [dataReady,setDataReady]=useState(false);
  const [editor,setEditor]=useState<{resource:string;item?:Item}|null>(null),[saving,setSaving]=useState(false),[values,setValues]=useState<Record<string,string>>(empty);
  const setEditorState=(next:{resource:string;item?:Item}|null)=>{editorRef.current=next;setEditor(next);};
  const [timer,setTimer]=useState<TimerState|null>(null),[timerSkew,setTimerSkew]=useState(0),[timeEntries,setTimeEntries]=useState<TimeEntry[]>([]),[timerView,setTimerView]=useState<TimerView>("closed");
  const timerRev=useRef(0),entriesRev=useRef(0);
  const closeTimerLayer=useCallback(()=>{const layer=layerOf(window.history.state);if((layer==="timer"||layer==="timer-stop")&&!timerClosing.current){timerClosing.current=true;closeLayer(window.history);setHistLayer(null);}setTimerView("closed");},[]);
  const publishTimer=useCallback((next:TimerState|null,skew:number)=>{timerRev.current++;setTimer(next);setTimerSkew(skew);writeTimerCache(next,skew);if(!next)closeTimerLayer();},[closeTimerLayer]);
  const onTimerView=useCallback((next:TimerView)=>{
    if(next==="sheet"){timerClosing.current=false;openLayer(window.history,"timer");setHistLayer("timer");setTimerView("sheet");return;}
    if(next==="stopping"){timerClosing.current=false;openLayer(window.history,"timer-stop");setHistLayer("timer-stop");setTimerView("stopping");return;}
    closeTimerLayer();
  },[closeTimerLayer]);
  const publishEntry=useCallback((entry:TimeEntry)=>{entriesRev.current++;setTimeEntries(es=>es.some(e=>e.id===entry.id)?es:[entry,...es].slice(0,300));},[]);
  const dropEntry=useCallback((id:string)=>{entriesRev.current++;setTimeEntries(es=>es.filter(e=>e.id!==id));},[]);
  const load=useCallback((silent=false)=>{
    const run=async(quiet:boolean)=>{
      if(!quiet){setLoading(true);setError("");}
      try{
        try{const rr=await fetch("/api/recurring",{cache:"no-store"});if(rr.ok)setRules((await rr.json() as {items:RecurringRule[]}).items);}catch{/* recurring rules are optional; the movements below do not depend on this */}
        const names=["contacts","projects","tasks","accounts","transactions","activities"];
        const [results,totals]=await Promise.all([
          Promise.all(names.map(async n=>{const r=await fetch(n==="transactions"?"/api/data/transactions?limit="+txLimitRef.current:"/api/data/"+n,{cache:"no-store"});if(!r.ok)throw new Error("No se pudieron cargar los datos");return (await r.json() as {items:Item[]}).items;})),
          fetch("/api/finance/totals",{cache:"no-store"}).then(async r=>{if(!r.ok)throw new Error("No se pudieron cargar los datos");return await r.json() as FinTotals;}),
        ]);
        setContacts(results[0]);setProjects(results[1]);setTasks(results[2]);setAccounts(results[3]);setTransactions(results[4]);setActivities(results[5]);
        setFinTotals(totals);setDataReady(true);
        try{const ir=await fetch("/api/inquiries",{cache:"no-store"});if(ir.ok)setInquiries((await ir.json() as {items:Inquiry[]}).items);}catch{/* inquiries are optional */}
        try{const rev=timerRev.current;const tr=await fetch("/api/timer",{cache:"no-store"});if(tr.ok){const data=await tr.json() as {timer?:unknown;serverNow?:unknown};if(rev===timerRev.current&&typeof data.serverNow==="number"){const next=data.timer==null?null:parseTimerState(data.timer);if(data.timer==null||next){const skew=clockSkew(data.serverNow,Date.now());setTimerSkew(skew);setTimer(next);writeTimerCache(next,skew);if(!next)setTimerView("closed");}}}}catch{/* timer is optional */}
        try{const rev=entriesRev.current;const er=await fetch("/api/time-entries",{cache:"no-store"});if(er.ok){const items=(await er.json() as {items?:TimeEntry[]}).items;if(rev===entriesRev.current&&Array.isArray(items))setTimeEntries(items);}}catch{/* time entries are optional */}
      }catch(e){if(!quiet)setError(e instanceof Error?e.message:"Error cargando datos");}finally{if(!quiet)setLoading(false);lastLoadAt.current=Date.now();}
    };
    if(!loaderRef.current)loaderRef.current=createCoalescedLoader(run);
    return loaderRef.current(silent);
  },[setError]);
  useEffect(()=>{void load();},[load]);
  const docs=useDocuments({contacts,accounts,issuer:{name,email},onNotice:setNotice,onError:setError,onChanged:()=>{void load(true);}});
  const docsRef=useRef(docs);
  useEffect(()=>{docsRef.current=docs;});
  const docsWasOpen=useRef(false);
  useEffect(()=>{
    const was=docsWasOpen.current;docsWasOpen.current=docs.open;
    if(docs.open){if(layerOf(window.history.state)!=="doc")openLayer(window.history,"doc");setHistLayer("doc");setAddMenuOpen(false);}
    else if(was&&layerOf(window.history.state)==="doc"){closeLayer(window.history);setHistLayer(null);}
  },[docs.open]);
  useLayoutEffect(()=>{const cached=readTimerCache();if(!cached)return;setTimer(cached.timer);setTimerSkew(cached.skewMs);},[]);
  useEffect(()=>{const refresh=()=>{if(Date.now()-lastLoadAt.current<1500)return;void load(true);};const onVisible=()=>{if(document.visibilityState==="visible")refresh();};document.addEventListener("visibilitychange",onVisible);window.addEventListener("focus",refresh);window.addEventListener("online",refresh);return()=>{document.removeEventListener("visibilitychange",onVisible);window.removeEventListener("focus",refresh);window.removeEventListener("online",refresh);};},[load]);
  useEffect(()=>{const saved=window.localStorage.getItem("serpix-theme");const initial=saved==="dark"?"dark":"light";setTheme(initial);document.documentElement.dataset.theme=initial;document.documentElement.style.colorScheme=initial;},[]);
  useEffect(()=>{if(!notice)return;const timer=window.setTimeout(()=>setNotice(""),3200);return()=>window.clearTimeout(timer);},[notice]);
  useEffect(()=>{if(!error)return;const timer=window.setTimeout(()=>setError(""),4500);return()=>window.clearTimeout(timer);},[error]);
  useEffect(()=>{if(!profileMenuOpen)return;const closeOnEscape=(event:KeyboardEvent)=>{if(event.key==="Escape")setProfileMenuOpen(false);};const closeOnOutside=(event:PointerEvent)=>{if(profileMenuRef.current&&!profileMenuRef.current.contains(event.target as Node))setProfileMenuOpen(false);};window.addEventListener("keydown",closeOnEscape);document.addEventListener("pointerdown",closeOnOutside);return()=>{window.removeEventListener("keydown",closeOnEscape);document.removeEventListener("pointerdown",closeOnOutside);};},[profileMenuOpen]);
  const inquiryAction=async(id:string,action:"read"|"unread"|"archive"|"unarchive"|"convert")=>{const r=await fetch("/api/inquiries/"+encodeURIComponent(id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({action})});const j=await r.json().catch(()=>({})) as {error?:string;existed?:boolean};if(!r.ok){setError(j.error||"No se pudo actualizar la solicitud");return;}if(action==="convert"){setNotice(j.existed?"Ya había un contacto con ese mail: la solicitud quedó vinculada.":"Contacto creado desde la solicitud.");await load(true);}else{const ir=await fetch("/api/inquiries",{cache:"no-store"});if(ir.ok)setInquiries((await ir.json() as {items:Inquiry[]}).items);}};
  useEffect(()=>{if(!openInquiry||contactsTab!=="inquiries"||section!=="contacts")return;const t=window.setTimeout(()=>document.getElementById("inq-"+openInquiry)?.scrollIntoView({block:"center",behavior:"smooth"}),300);return()=>window.clearTimeout(t);},[openInquiry,contactsTab,section,inquiries.length]);
  const toggleTheme=()=>{const next=theme==="light"?"dark":"light";setTheme(next);document.documentElement.dataset.theme=next;document.documentElement.style.colorScheme=next;window.localStorage.setItem("serpix-theme",next);};
  const totals=useMemo(()=>({openTasks:tasks.filter(t=>t.status!=="done"&&t.status!=="cancelled").length,activeProjects:projects.filter(p=>p.status==="active").length}),[tasks,projects]);
  const todayKey=new Date().toLocaleDateString("sv-SE");
  const homeTasks=useMemo(()=>tasks.filter(t=>t.status!=="done"&&t.status!=="cancelled").sort((a,b)=>(a.dueDate?0:1)-(b.dueDate?0:1)||String(a.dueDate||"").localeCompare(String(b.dueDate||""))).slice(0,8),[tasks]);
  const timeByTask=useMemo(()=>{const m:Record<string,number>={};for(const e of timeEntries)if(e.taskId)m[e.taskId]=(m[e.taskId]||0)+Number(e.durationMs||0);return m;},[timeEntries]);
  const homeKpis:{id:string;icon:typeof Users;value:number;tip:string;go:Section}[]=[
    {id:"contacts",icon:Users,value:contacts.length,tip:"Contactos en tu CRM",go:"contacts"},
    {id:"tasks",icon:ListChecks,value:totals.openTasks,tip:"Tareas abiertas: pendientes o en curso",go:"activity"},
    {id:"events",icon:CalendarClock,value:activities.filter(a=>a.kind==="event"&&String(a.occurredAt||"").slice(0,10)>=todayKey).length,tip:"Eventos próximos",go:"activity"},
    {id:"money",icon:Wallet,value:finTotals?finTotals.transactionCount:transactions.length,tip:"Movimientos financieros registrados",go:"finance"},
  ];
  const autoBusy=useRef<Set<string>>(new Set());
  const autoLimited=useRef(false);
  const autoLoadAvatar=async(c:Item)=>{
    // Encrypted accounts never send a contact's email or handle to gravatar/unavatar on their own.
    if(e2e||autoLimited.current||autoBusy.current.has(c.id))return;
    const key=await sourcesKey(c);
    if(!autoEligible(c,key))return;
    autoBusy.current.add(c.id);
    try{
      const r=await autoAvatar(c);
      const post=(body:Record<string,unknown>)=>fetch("/api/avatar/"+encodeURIComponent(c.id),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      if(typeof r==="object"){const res=await post({avatarData:r.data,avatarSource:"auto:"+r.source});if(res.ok)setContacts(cs=>cs.map(x=>x.id===c.id?{...x,hasAvatar:1,avatarSource:"auto:"+r.source,updatedAt:new Date().getTime()}:x));}
      else if(r==="limited")autoLimited.current=true;
      else if(r==="none"){const res=await post({failedKey:key});if(res.ok)setContacts(cs=>cs.map(x=>x.id===c.id?{...x,avatarTriedKey:key,avatarTriedAt:new Date().getTime()}:x));}
    }catch{/* silent: automatic lookup is best effort */}
    finally{autoBusy.current.delete(c.id);}
  };
  const [taskPending,setTaskPending]=useState<string|null>(null);
  const [noteTab,setNoteTab]=useState<"write"|"preview">("write");
  const [activityKind,setActivityKind]=useState<"event"|"note">("event");
  const applyNav=(next:NavState)=>{navRef.current=next;setNav(next);};
  const go=(patch:Partial<NavState>)=>{
    const current=navRef.current;
    const next=parseNav(buildSearch({...current,edit:null,noteId:null,...patch}));
    const layer=layerOf(window.history.state);
    const base=parseNav(buildSearch({...current,edit:null,noteId:null}));
    const sameScreen=sameNav(next,base);
    if(sameScreen&&layer&&closeLayer(window.history)){
      setHistLayer(null);setEditorState(null);setAddMenuOpen(false);setError("");setProfileMenuOpen(false);
      if(layer==="timer"||layer==="timer-stop")setTimerView("closed");
      if(!sameNav(current,next))applyNav(next);
      return;
    }
    if(sameScreen&&!sameNav(current,next)){
      refineHistory(window.history,buildUrl(next));
      applyNav(next);setHistLayer(layerOf(window.history.state));setEditorState(null);setAddMenuOpen(false);setError("");setProfileMenuOpen(false);
      return;
    }
    if(sameNav(current,next)){setEditorState(null);setAddMenuOpen(false);setError("");setProfileMenuOpen(false);return;}
    pushScreen(window.history,buildUrl(next));
    setHistLayer(null);setEditorState(null);setAddMenuOpen(false);setError("");setProfileMenuOpen(false);
    if(layer==="timer"||layer==="timer-stop")setTimerView("closed");
    applyNav(next);
  };
  const refineNav=(patch:Partial<NavState>)=>{
    const next=parseNav(buildSearch({...navRef.current,...patch}));
    if(sameNav(navRef.current,next))return;
    refineHistory(window.history,buildUrl(next));
    applyNav(next);
  };
  const closeEditor=()=>{
    const layer=layerOf(window.history.state);
    if((layer==="editor"||layer==="edit")&&closeLayer(window.history)){
      setEditorState(null);setHistLayer(null);
      if(navRef.current.edit)applyNav(parseNav(buildSearch({...navRef.current,edit:null})));
      return;
    }
    setEditorState(null);
    if(navRef.current.edit){const next=parseNav(buildSearch({...navRef.current,edit:null}));refineHistory(window.history,buildUrl(next));applyNav(next);}
  };
  const openEditor=(resource:string,item?:Item)=>{
    setValues(editorSeed(resource,item,accounts));setNoteTab("write");setEditorState({resource,item});
    if(item&&resource==="activities")setActivityKind(item.kind==="event"?"event":"note");
    const target=item?urlEdit(navRef.current.section,resource,item.id):null;
    if(target){
      const next=parseNav(buildSearch({...navRef.current,edit:target,noteId:null}));
      openLayer(window.history,"edit",buildUrl(next));setHistLayer("edit");applyNav(next);
    }else{openLayer(window.history,"editor");setHistLayer("editor");}
  };
  const openNote=(id:string)=>{
    const next=parseNav(buildSearch({...navRef.current,noteId:id,edit:null}));
    openLayer(window.history,"note",buildUrl(next));setHistLayer("note");setEditorState(null);applyNav(next);
  };
  const closeNote=()=>{
    if(closeLayer(window.history)){setHistLayer(null);if(navRef.current.noteId)applyNav(parseNav(buildSearch({...navRef.current,noteId:null})));return;}
    const next=parseNav(buildSearch({...navRef.current,noteId:null}));
    refineHistory(window.history,buildUrl(next));applyNav(next);setHistLayer(layerOf(window.history.state));
  };
  const closeAddMenu=()=>{
    if(layerOf(window.history.state)==="add"&&closeLayer(window.history)){setAddMenuOpen(false);setHistLayer(null);return;}
    setAddMenuOpen(false);
  };
  const toggleAdd=()=>{
    if(addMenuOpen||layerOf(window.history.state)==="add"){closeAddMenu();return;}
    openLayer(window.history,"add");setHistLayer("add");setAddMenuOpen(true);setProfileMenuOpen(false);
  };
  const save=async()=>{
    if(!editor)return;setSaving(true);setError("");setNotice("");
    const payload:Record<string,unknown>={...values};
    if(editor.resource==="activities"){payload.kind=activityKind;payload.contactIds=values.contactIds?values.contactIds.split(",").filter(Boolean):[];}
    if(editor.resource==="contacts"){payload.isPotential=values.isPotential==="true";try{payload.relations=JSON.parse(values.relations||"{}");}catch{payload.relations={};}delete payload.role;}if(editor.resource==="contacts"&&String(values.phone||"").replace(/\D/g,"").length<=3)payload.phone="";
    if(editor.resource==="accounts")payload.openingBalanceMinor=Math.round(Number(values.openingBalance||0)*100);
    if(editor.resource==="transactions"){payload.amountMinor=Math.round(Number(values.amount||0)*100);if(editor.item&&editor.item.receiptId&&!values.receiptId)payload.removeReceipt=true;if(editor.item?.source==="cuentix"){payload.kind=editor.item.kind;payload.amountMinor=Number(editor.item.amountMinor);payload.occurredAt=editor.item.occurredAt;payload.accountId=editor.item.accountId;}}
    if(editor.resource==="recurring")payload.amountMinor=Math.round(Number(values.amount||0)*100);
    if(editor.resource==="tasks"){payload.projectId=values.projectId||null;payload.contactId=values.contactId||null;}
    if(editor.resource==="transactions")payload.contactId=values.contactId||null;
    try{
      let failedKey="";
      if(editor.resource==="contacts"&&!("avatarData" in values)&&Number(editor.item?.hasAvatar)!==1){
        const key=await sourcesKey(values);
        const eligible=autoEligible({hasAvatar:0,avatarTriedKey:editor.item?.avatarTriedKey,avatarTriedAt:editor.item?.avatarTriedAt},key);
        if(shouldAutoAvatarOnSave({e2e,resource:editor.resource,hasAvatarDataInValues:false,hasPhoto:false,key,eligible})){
          const r=await autoAvatar(values);
          if(typeof r==="object"){payload.avatarData=r.data;payload.avatarSource="auto:"+r.source;}else if(r==="none")failedKey=key;
        }
      }
      const url=editor.resource==="recurring"?"/api/recurring/"+encodeURIComponent(String(editor.item?.id)):"/api/data/"+editor.resource+(editor.item?"/"+encodeURIComponent(editor.item.id):"");
      const response=await fetch(url,{method:editor.item?"PATCH":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      if(!response.ok){const body=await response.json() as {error?:string};throw new Error(body.error||"No se pudo guardar");}
      if(failedKey){const saved=await response.clone().json().catch(()=>({})) as {id?:string};const cid=editor.item?.id||saved.id;if(cid)await fetch("/api/avatar/"+encodeURIComponent(cid),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({failedKey})}).catch(()=>undefined);}
      closeEditor();setNotice(editor.item?"Cambios guardados":"Registro creado");await load();
    }catch(e){setError(e instanceof Error?e.message:"Error guardando");}finally{setSaving(false);}
  };
  const remove=async(resource:string,item:Item)=>{
    if(!window.confirm("¿Eliminar este registro? Esta acción no se puede deshacer."))return;
    setError("");setNotice("");const r=await fetch("/api/data/"+resource+"/"+encodeURIComponent(item.id),{method:"DELETE"});
    if(!r.ok){const body=await r.json() as {error?:string};setError(body.error||"No se pudo eliminar");return;}
    setNotice("Registro eliminado");await load();
  };
  const unlinkMovement=async()=>{
    if(!editor?.item)return;setSaving(true);setError("");setNotice("");
    try{
      const r=await fetch("/api/data/transactions/"+encodeURIComponent(editor.item.id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({unlink:true})});
      if(!r.ok){const body=await r.json() as {error?:string};throw new Error(body.error||"No se pudo desvincular");}
      closeEditor();setNotice("Desvinculado. El movimiento de Cuentix vuelve a sumar.");await load();
    }catch(e){setError(e instanceof Error?e.message:"No se pudo desvincular");}finally{setSaving(false);}
  };
  const fields=editor?(editor.resource==="contacts"?contactFields:editor.resource==="projects"?projectFields:editor.resource==="tasks"?taskFields:editor.resource==="accounts"?accountFields:editor.resource==="activities"?activityFields:editor.resource==="recurring"?recurringFields:transactionFields):[];
  const onScanned=(scan:ScanResponse)=>{
    setValues(v=>{
      const next:Record<string,string>={...v,receiptId:scan.receiptId};const f=scan.fields;if(!f)return next;
      if(f.amountMinor)next.amount=(f.amountMinor/100).toFixed(2);
      if(f.date)next.occurredAt=f.date;
      if(f.category&&!String(v.category||"").trim())next.category=f.category;
      if(f.merchant&&!String(v.description||"").trim())next.description=f.merchant;
      if(f.currency){const cur=accounts.find(a=>String(a.id)===v.accountId);if(!cur||cur.currency!==f.currency){const match=accounts.find(a=>a.currency===f.currency);if(match)next.accountId=String(match.id);}}
      return next;
    });
    if(scan.fields?.currency&&!accounts.some(a=>a.currency===scan.fields?.currency))setNotice("El ticket parece estar en "+scan.fields.currency+" y no tenés una cuenta en esa moneda.");
  };
  const visibleSections=sections.filter(s=>["home","contacts","activity","finance"].includes(s.id));
  const activeAddType=({contacts:"contacts",activity:"activities-event"} as Partial<Record<Section,string>>)[section];
  const chooseAdd=(resource:string)=>{
    if(resource==="timer"){
      if(layerOf(window.history.state)==="add"){
        armTimer.current=true;setAddMenuOpen(false);setHistLayer(null);
        if(closeLayer(window.history)){
          const token=window.history.state;
          window.setTimeout(()=>{
            if(!armTimer.current)return;
            if(window.history.state!==token||layerOf(window.history.state)!=="add")return;
            armTimer.current=false;window.history.replaceState(null,"",buildUrl(navRef.current));setHistLayer(null);window.dispatchEvent(new CustomEvent("serpix:timer-start"));
          },200);
          return;
        }
      }
      window.dispatchEvent(new CustomEvent("serpix:timer-start"));
      return;
    }
    setAddMenuOpen(false);
    if(resource==="transactions-income"||resource==="transactions-expense"){
      if(accounts.length===0){openEditor("accounts");setNotice("Creá una cuenta primero para registrar movimientos.");return;}
      openEditor("transactions");
      setValues(v=>resource==="transactions-income"?{...v,kind:"income",category:"Factura"}:{...v,kind:"expense"});
      return;
    }
    if(resource==="activities-event"||resource==="activities-note"){setActivityKind(resource==="activities-event"?"event":"note");openEditor("activities");return;}
    openEditor(resource);
  };
  const addActions:AddSheetAction[]=[
    {id:"contacts",label:"Contacto",icon:ContactRound,onSelect:()=>chooseAdd("contacts")},
    {id:"tasks",label:"Tarea",icon:ListPlus,onSelect:()=>chooseAdd("tasks")},
    {id:"activities-event",label:"Evento",icon:CalendarDays,onSelect:()=>chooseAdd("activities-event")},
    {id:"activities-note",label:"Nota",icon:NotebookPen,onSelect:()=>chooseAdd("activities-note")},
    {id:"transactions-income",label:"Factura",icon:ReceiptText,onSelect:()=>{setAddMenuOpen(false);setEditorState(null);docs.openNew("invoice");}},
    {id:"transactions-expense",label:"Gasto",icon:TrendingDown,onSelect:()=>chooseAdd("transactions-expense")},
    {id:"timer",label:"Temporizador",icon:Timer,onSelect:()=>chooseAdd("timer")},
    {id:"accounts",label:"Cuenta",icon:WalletCards,onSelect:()=>chooseAdd("accounts")},
  ];
  const toggleTask=async(task:Item)=>{if(taskPending)return;setTaskPending(task.id);const status=task.status==="done"?"todo":"done";const r=await fetch("/api/data/tasks/"+encodeURIComponent(task.id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:task.title,description:task.description,status,priority:task.priority,projectId:task.projectId||null,contactId:task.contactId||null,dueDate:task.dueDate||null})});if(!r.ok){setError("No se pudo actualizar la tarea");setTaskPending(null);return;}await load();setTaskPending(null);};
  const createTaskForContact=(contact:Item)=>{openEditor("tasks");setValues(v=>({...v,contactId:contact.id,title:"",description:""}));};
  const noteOpen=section==="activity"&&!!nav.noteId&&(histLayer==="note"||histLayer===null);
  useLayoutEffect(()=>{
    const onPop=()=>{
      let next=parseNav(window.location.search);
      if(next.section==="admin"&&!isAdmin){next=DEFAULT_NAV;window.history.replaceState(window.history.state,"",buildUrl(next));}
      applyNav(next);
      const layer=layerOf(window.history.state);
      setHistLayer(layer);
      setAddMenuOpen(layer==="add");
      if(layer!=="editor"&&layer!=="edit"&&!next.edit)setEditorState(null);
      if(layer!=="doc")docsRef.current.close();
      setTimerView(view=>{if(layer==="timer")return view==="sheet"? "sheet":"closed";if(layer==="timer-stop")return view==="stopping"?"stopping":"closed";return "closed";});
      if(armTimer.current){armTimer.current=false;window.dispatchEvent(new CustomEvent("serpix:timer-start"));}
    };
    window.addEventListener("popstate",onPop);
    if(!booted.current){
      booted.current=true;
      let parsed=parseNav(window.location.search);
      if(parsed.section==="admin"&&!isAdmin)parsed=DEFAULT_NAV;
      const url=buildUrl(parsed);
      const here=window.location.pathname+window.location.search;
      const layer=layerOf(window.history.state);
      const overlay=layer==="add"||layer==="editor"||layer==="timer"||layer==="timer-stop"||layer==="doc";
      if(overlay){
        const token=window.history.state;
        let popped=false;
        const mark=()=>{popped=true;};
        window.addEventListener("popstate",mark);
        window.history.back();
        window.setTimeout(()=>{
          window.removeEventListener("popstate",mark);
          if(!popped&&window.history.state===token&&layerOf(window.history.state)){
            window.history.replaceState(null,"",url);
            setHistLayer(null);setAddMenuOpen(false);setEditorState(null);setTimerView("closed");
          }
        },0);
        applyNav(parsed);setHistLayer(null);setAddMenuOpen(false);setEditorState(null);setTimerView("closed");
      }else{
        if(url!==here)window.history.replaceState(layer?{serpixLayer:layer}:window.history.state,"",url);
        applyNav(parsed);setHistLayer(layer);
      }
    }
    return()=>window.removeEventListener("popstate",onPop);
  },[isAdmin]);
  useLayoutEffect(()=>{
    if(!dataReady||!nav.edit)return;
    const {resource,id}=nav.edit;
    const item=itemsOf(resource,{contacts,projects,tasks,accounts,transactions,activities}).find(x=>x.id===id);
    if(!item){
      const next=parseNav(buildSearch({...navRef.current,edit:null}));
      refineHistory(window.history,buildUrl(next));applyNav(next);setEditorState(null);
      return;
    }
    const ed=editorRef.current;
    if(ed?.resource===resource&&ed.item?.id===id)return;
    if(resource==="activities")setActivityKind(item.kind==="event"?"event":"note");
    setValues(editorSeed(resource,item,accounts));setNoteTab("write");setEditorState({resource,item});
  },[dataReady,nav.edit,contacts,projects,tasks,accounts,transactions,activities]);
  useLayoutEffect(()=>{
    if(!dataReady||nav.section!=="activity"||!nav.noteId)return;
    if(activities.some(a=>a.id===nav.noteId&&a.kind!=="event"))return;
    const next=parseNav(buildSearch({...navRef.current,noteId:null}));
    refineHistory(window.history,buildUrl(next));applyNav(next);
  },[dataReady,nav.section,nav.noteId,activities]);
  useEffect(()=>{
    if(loading||nav.section!=="contacts"||nav.contactsView!=="list"||!nav.contactId)return;
    const el=document.getElementById("contact-"+nav.contactId);
    if(!el)return;
    if(seenContact.current===nav.contactId)return;
    el.scrollIntoView({block:"center",behavior:"auto"});
    seenContact.current=nav.contactId;
    const c=contacts.find(x=>x.id===nav.contactId);
    if(c)void autoLoadAvatar(c);
  },[loading,nav.section,nav.contactsView,nav.contactId,contacts]);
  return <main className="app-shell">
    <aside className="sidebar"><a className="logo" href="/dashboard"><span className="brand-mark small"><img src="/icons/logo-128.v5.png" alt="" width="36" height="36" /></span><span>Serpix</span></a><div className="side-caption">ESPACIO DE TRABAJO</div><nav aria-label="Secciones principales">{visibleSections.map(s=>{const Icon=NavIcons[s.id];return <button key={s.id} className={"nav-item "+(section===s.id?"active":"")} aria-current={section===s.id?"page":undefined} aria-label={s.label} title={s.label} onClick={()=>go({section:s.id})}><span className="nav-symbol"><Icon size={19} strokeWidth={1.9}/>{s.id==="contacts"&&unreadInquiries>0&&<i className="nav-badge" aria-label={unreadInquiries+" solicitudes sin leer"}>{unreadInquiries>9?"9+":unreadInquiries}</i>}</span><span>{s.label}</span></button>;})}<div className="profile-nav-wrap" ref={profileMenuRef}>{profileMenuOpen&&<div className="profile-menu" id="serpix-profile-menu" role="group" aria-label="Menú de cuenta"><div className="profile-menu-heading"><strong>{name}</strong><small>{email}</small><span>{isAdmin?"Administrador":"Usuario"}</span></div><button type="button" className="profile-menu-item theme-menu-toggle" role="switch" aria-checked={theme==="dark"} onClick={toggleTheme}>{theme==="dark"?<Moon size={18}/>:<Sun size={18}/>}<span>Modo oscuro</span><span className={"theme-switch "+(theme==="dark"?"on":"")}><span/></span></button><PushToggle onMessage={(m,k)=>k==="ok"?setNotice(m):setError(m)}/>{isAdmin&&<InvitesAdmin isAdmin={isAdmin}/>}{isAdmin&&<button type="button" className="profile-menu-item" onClick={()=>{go({section:"admin"});window.scrollTo({top:0,behavior:"smooth"});}}><ShieldCheck size={18}/> Administración</button>}{e2eMenu}<div className="profile-menu-divider"/><SignOutButton onWarning={setError}/></div>}<button type="button" className={"nav-item profile-nav-item "+(profileMenuOpen?"active":"")} aria-label="Abrir menú de cuenta" aria-controls="serpix-profile-menu" aria-expanded={profileMenuOpen} title={name+" · Cuenta"} onClick={()=>setProfileMenuOpen(v=>!v)}><span className="profile-nav-avatar"><span className="profile-avatar-fallback">{name.trim().slice(0,1).toUpperCase()}</span>{image&&<img src={image} alt="" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.style.display="none";}}/>}</span><span>Perfil</span></button></div></nav></aside>
    <section className="main-area" aria-busy={loading}><div className="workspace-actions"><div className="add-menu-wrap"><button ref={addTriggerRef} className={"add-trigger "+(addMenuOpen?"is-open":"")} onClick={toggleAdd} aria-label="Agregar" aria-controls="serpix-add-sheet" aria-expanded={addMenuOpen} title="Agregar"><Plus size={23} strokeWidth={2.7}/></button></div></div><AddSheet open={addMenuOpen} onClose={closeAddMenu} actions={addActions} activeId={activeAddType} triggerRef={addTriggerRef}/>
      {error&&<div className="toast error" role="alert" aria-live="assertive">{error}<button onClick={()=>setError("")} aria-label="Cerrar notificación">×</button></div>}{notice&&<div className="toast success" role="status" aria-live="polite">{notice}<button onClick={()=>setNotice("")} aria-label="Cerrar notificación">×</button></div>}
      {loading?<div className="loading" role="status" aria-live="polite">Cargando tu espacio…</div>:<>
      {section==="home"&&<>
        <div className="home-head"><h2>Buen día, {name.split(" ")[0]}.</h2><button type="button" className={"home-inbox "+(unreadInquiries>0?"has-new":"")} title={unreadInquiries>0?unreadInquiries+" solicitudes nuevas del portfolio":"Solicitudes del portfolio"} aria-label={unreadInquiries>0?unreadInquiries+" solicitudes nuevas del portfolio":"Solicitudes del portfolio"} onClick={()=>go({section:"contacts",contactsView:"inquiries"})}><Inbox size={17} aria-hidden="true"/>{unreadInquiries>0&&<i className="nav-badge">{unreadInquiries>9?"9+":unreadInquiries}</i>}</button><span className="home-date" title={new Date().toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}><CalendarDays size={14} aria-hidden="true"/>{new Date().toLocaleDateString("es-AR",{weekday:"short",day:"numeric",month:"short"}).replace(",","")}</span></div>
        <div className="home-kpis" role="group" aria-label="Resumen">
          {homeKpis.map(k=>{const Icon=k.icon;return <button type="button" key={k.id} className="home-kpi" data-tip={k.tip} title={k.tip} aria-label={k.tip} onClick={()=>go({section:k.go})}><Icon size={18} strokeWidth={2.1} aria-hidden="true"/><strong>{k.value}</strong></button>;})}
        </div>
        {docs.homeAlert}
        <section className="panel home-panel"><div className="home-panel-head"><h3>Próximas tareas</h3><button type="button" className="icon-link" title="Ver agenda" aria-label="Ver agenda" onClick={()=>go({section:"activity"})}><ArrowRight size={18} aria-hidden="true"/></button></div>
          {homeTasks.length===0?<p className="empty-copy" title="Creá una con el botón +">Sin tareas abiertas</p>:homeTasks.map(t=>{const overdue=!!t.dueDate&&String(t.dueDate)<todayKey;return <div className="home-task" key={t.id}>
            <button type="button" className={"home-check "+String(t.priority)} title={"Marcar como hecha · Prioridad "+labelStatus(t.priority).toLowerCase()} aria-label={"Marcar como hecha: "+String(t.title)} disabled={!!taskPending} onClick={()=>void toggleTask(t)}/>
            <button type="button" className="home-task-title" title={String(t.title)} onClick={()=>go({section:"activity"})}>{String(t.title)}</button>
            <span className="home-task-meta">
              {t.contactName&&<span className="home-meta-icon" title={"Contacto: "+String(t.contactName)} aria-label={"Contacto: "+String(t.contactName)} tabIndex={0}><UserRound size={14} aria-hidden="true"/></span>}
              {t.status==="in_progress"&&<span className="home-meta-icon" title="En curso" aria-label="En curso" tabIndex={0}><Clock size={14} aria-hidden="true"/></span>}
              <span className={"home-meta-date"+(overdue?" overdue":"")} title={t.dueDate?(overdue?"Vencida · ":"Vence ")+dateLabel(t.dueDate):"Sin fecha"} aria-label={t.dueDate?(overdue?"Vencida · ":"Vence ")+dateLabel(t.dueDate):"Sin fecha"} tabIndex={0}>{t.dueDate?<>{overdue&&<AlertCircle size={13} aria-hidden="true"/>}{String(t.dueDate).slice(8,10)+"/"+String(t.dueDate).slice(5,7)}</>:<CalendarOff size={14} aria-hidden="true"/>}</span>
            </span></div>;})}
        </section>
        <section className="panel home-panel"><div className="home-panel-head"><h3>Movimientos recientes</h3><button type="button" className="icon-link" title="Ver finanzas" aria-label="Ver finanzas" onClick={()=>go({section:"finance"})}><ArrowRight size={18} aria-hidden="true"/></button></div>
          {transactions.length===0?<p className="empty-copy" title="Registrá uno desde Finanzas">Sin movimientos</p>:transactions.slice(0,4).map(t=><div className="home-task" key={t.id}><span className={"money-sign "+String(t.kind)} title={t.kind==="income"?"Ingreso":"Gasto"} aria-label={t.kind==="income"?"Ingreso":"Gasto"}>{t.kind==="income"?"+":"−"}</span><span className="home-task-title static" title={String(t.accountName)+" · "+dateLabel(t.occurredAt)}>{String(t.category)}<CuentixMarks item={t}/></span><b className={t.kind==="income"?"positive":"negative"}>{money(Number(t.amountMinor),String(t.currency))}</b></div>)}
        </section></>}
      {section==="contacts"&&<><SectionIntro title="CRM" description="Relaciones comerciales, contactos y oportunidades. Datos privados de tu cuenta."/><div className="segmented-field crm-tabs" role="group" aria-label="Contactos o solicitudes"><button type="button" className={contactsTab==="list"?"selected":""} aria-pressed={contactsTab==="list"} title="Tus contactos" onClick={()=>go({contactsView:"list"})}><Users size={15} aria-hidden="true"/> Contactos</button><button type="button" className={contactsTab==="inquiries"?"selected":""} aria-pressed={contactsTab==="inquiries"} title="Solicitudes que llegan desde el formulario del portfolio" onClick={()=>go({contactsView:"inquiries"})}><Inbox size={15} aria-hidden="true"/> Solicitudes{unreadInquiries>0&&<i className="tab-count">{unreadInquiries}</i>}</button></div>{contactsTab==="inquiries"?<Inquiries items={inquiries} openId={openInquiry} onAction={inquiryAction} onOpenChange={id=>refineNav({inquiryId:id})} onViewContact={()=>go({contactsView:"list"})}/>:<><div className="contact-filters"><div className="segmented-field wrap contact-filter" role="group" aria-label="Filtrar por relación">{([["all","Todos","Todos los contactos"],["client","Clientes","Contactos que son o pueden ser clientes"],["partner","Socios","Contactos que son o pueden ser socios"],["supplier","Proveedores","Contactos que son o pueden ser proveedores"],["none","Sin relación","Contactos sin ninguna relación marcada"]] as [string,string,string][]).map(([id,label,tip])=><button type="button" key={id} title={tip} className={roleFilter===id?"selected":""} aria-pressed={roleFilter===id} onClick={()=>refineNav({role:id as NavState["role"]})}>{label}</button>)}</div><div className="segmented-field contact-filter state-filter" role="group" aria-label="Filtrar por estado">{([["any","Todos","Potenciales y confirmados"],["potential","Potenciales","Solo potenciales"],["confirmed","Confirmados","Solo confirmados"]] as [string,string,string][]).map(([id,label,tip])=><button type="button" key={id} title={tip} className={stateFilter===id?"selected":""} aria-pressed={stateFilter===id} disabled={roleFilter==="none"} onClick={()=>refineNav({relState:id as NavState["relState"]})}>{label}</button>)}</div></div><div className="contact-list">{contacts.length===0?<div className="panel"><Empty text="Todavía no hay contactos. Creá el primero para empezar a organizar tus relaciones."/></div>:contacts.filter(c=>{const r=contactRelations(c.relations,c.role);if(roleFilter==="all")return stateFilter==="any"||Object.values(r).includes(stateFilter);if(roleFilter==="none")return Object.keys(r).length===0;const st=r[roleFilter as RelationKey];return !!st&&(stateFilter==="any"||st===stateFilter);}).map(c=><details className="panel contact-card" key={c.id} id={"contact-"+c.id} open={nav.contactId===c.id} onToggle={e=>{const el=e.currentTarget as HTMLDetailsElement;if(el.open===(navRef.current.contactId===c.id))return;refineNav({contactId:el.open?c.id:null});if(el.open)void autoLoadAvatar(c);}}><summary><ContactAvatar c={c}/><span className="contact-summary-main"><strong>{String(c.name)}</strong><small>{String(c.companyName|| (c.kind==="company"?"Empresa":"Persona"))}</small></span><RelationBadges relations={contactRelations(c.relations,c.role)}/><span className="contact-chevron">⌄</span></summary><div className="contact-details"><div className="contact-facts">{c.email&&<a href={mailtoxComposeUrl(String(c.email))} target="_blank" rel="noopener noreferrer" style={{cursor:"pointer"}}>{String(c.email)}</a>}{String(c.phone||"").replace(/[^\d]/g,"").length>3&&<a href={"tel:"+String(c.phone).replace(/[^\d+]/g,"")}>{String(c.phone)}</a>}{waNumber(c.phone)&&!socialHref("whatsapp",c.whatsappUrl)&&<a href={"https://wa.me/"+waNumber(c.phone)} target="_blank" rel="noreferrer" title="Abrir WhatsApp con este teléfono">WhatsApp</a>}{socialHref("x",c.xUrl)&&<a href={socialHref("x",c.xUrl)||undefined} target="_blank" rel="noreferrer" title={String(c.xUrl)}>X</a>}{socialHref("instagram",c.instagramUrl)&&<a href={socialHref("instagram",c.instagramUrl)||undefined} target="_blank" rel="noreferrer" title={String(c.instagramUrl)}>Instagram</a>}{socialHref("telegram",c.telegramUrl)&&<a href={socialHref("telegram",c.telegramUrl)||undefined} target="_blank" rel="noreferrer" title={String(c.telegramUrl)}>Telegram</a>}{socialHref("whatsapp",c.whatsappUrl)&&<a href={socialHref("whatsapp",c.whatsappUrl)||undefined} target="_blank" rel="noreferrer" title={String(c.whatsappUrl)}>WhatsApp</a>}{socialHref("linkedin",c.linkedinUrl)&&<a href={socialHref("linkedin",c.linkedinUrl)||undefined} target="_blank" rel="noreferrer" title={String(c.linkedinUrl)}>LinkedIn</a>}{socialHref("github",c.githubUrl)&&<a href={socialHref("github",c.githubUrl)||undefined} target="_blank" rel="noreferrer" title={String(c.githubUrl)}>GitHub</a>}</div>{c.notes&&<p className="contact-notes">{String(c.notes)}</p>}<div className="contact-related"><strong>Tareas vinculadas</strong>{tasks.filter(t=>t.contactId===c.id).length===0?<small>Sin tareas asociadas</small>:tasks.filter(t=>t.contactId===c.id).map(t=><span key={t.id}>{String(t.title)} · {labelStatus(t.status)}</span>)}</div>{activities.filter(a=>String(a.contactIds||"").split(",").includes(String(c.id))).length>0&&<div className="contact-related"><strong>Eventos y notas</strong>{activities.filter(a=>String(a.contactIds||"").split(",").includes(String(c.id))).map(a=><span key={a.id}>{a.kind==="event"?"Evento":"Nota"} · {String(a.title)} · {dateLabel(String(a.occurredAt).slice(0,10))}</span>)}</div>}<div className="contact-actions"><button className="secondary-button compact" onClick={()=>createTaskForContact(c)}>+ Crear tarea</button><Actions onEdit={()=>openEditor("contacts",c)} onDelete={()=>void remove("contacts",c)}/></div></div></details>)}</div></>}</>}
      {section==="activity"&&<Agenda tasks={tasks} activities={activities} taskPending={taskPending} timeByTask={timeByTask} tab={nav.agendaTab} filter={nav.agendaKind} month={nav.month} day={nav.day} noteId={nav.noteId} noteOpen={noteOpen} onNav={(patch,mode)=>{if(mode==="push")go(patch);else refineNav(patch);}} onOpenNote={openNote} onCloseNote={closeNote} onToggleTask={t=>void toggleTask(t)} onEditTask={t=>openEditor("tasks",t)} onEditActivity={a=>{setActivityKind(a.kind==="event"?"event":"note");openEditor("activities",a);}} onDeleteTask={t=>void remove("tasks",t)} onDeleteActivity={a=>void remove("activities",a)}/>}
      {section==="finance"&&<><SectionIntro title="Finanzas" description="Cuentas, ingresos y gastos. Importes guardados en centavos para evitar errores de redondeo."/><div className="finance-summary"><div className="panel"><small>Ingresos registrados · ARS</small><strong className="positive">{money(finTotals?.ARS.incomeMinor??0,"ARS")}</strong></div><div className="panel"><small>Gastos registrados · ARS</small><strong className="negative">{money(finTotals?.ARS.expenseMinor??0,"ARS")}</strong></div><div className="panel"><small>Ingresos registrados · USD</small><strong className="positive">{money(finTotals?.USD.incomeMinor??0,"USD")}</strong></div><div className="panel"><small>Gastos registrados · USD</small><strong className="negative">{money(finTotals?.USD.expenseMinor??0,"USD")}</strong></div></div><TimeEntriesPanel entries={timeEntries} onDeleted={dropEntry} onError={setError}/><RecurringPanel rules={rules} onChanged={()=>void load(true)} onError={setError} onNotice={setNotice} onEdit={r=>openEditor("recurring",r as unknown as Item)}/>{docs.panel}<div className="finance-layout"><section className="panel"><div className="panel-title"><h2>Cuentas</h2><button className="text-button" onClick={()=>openEditor("accounts")}>+ Agregar</button></div>{accounts.map(a=><div className="account-line" key={a.id}><div><strong>{String(a.name)}</strong><small>{String(a.currency)}</small></div><b>{money(Number(a.balanceMinor),String(a.currency))}</b><Actions onEdit={()=>openEditor("accounts",a)} onDelete={()=>void remove("accounts",a)}/></div>)}{accounts.length===0&&<Empty text="Creá una cuenta para registrar movimientos."/>}</section><section className="panel"><div className="panel-title"><h2>Últimos movimientos</h2><button type="button" className="text-button scan-ticket-button" title="Cargar un gasto desde la foto de un ticket" aria-label="Escanear ticket" onClick={()=>chooseAdd("transactions-expense")}><ScanLine size={14} aria-hidden="true"/> Escanear ticket</button></div>{transactions.map((t,i)=>{const mk=String(t.occurredAt||"").slice(0,7);const first=i===0||String(transactions[i-1].occurredAt||"").slice(0,7)!==mk;return <div key={t.id} className={toneClass(mk)}>{first&&mk&&<MonthHeading day={mk+"-01"}/>}<div className="list-line"><span className={"money-sign "+String(t.kind)}>{t.kind==="income"?"+":"−"}</span><div><strong>{String(t.category)}<CuentixMarks item={t} onOpen={()=>openEditor("transactions",t)}/></strong><small>{String(t.description||t.accountName)} · {dateLabel(t.occurredAt)}{!!t.recurringId&&<> <RecurringBadge/></>}{!!t.receiptId&&<> <a className="receipt-link" href={"/api/receipts/"+encodeURIComponent(String(t.receiptId))} target="_blank" rel="noreferrer" title="Ver el ticket" aria-label="Ver el ticket"><Paperclip size={12} aria-hidden="true"/></a></>}</small></div><b className={t.kind==="income"?"positive":"negative"}>{money(Number(t.amountMinor),String(t.currency))}</b><Actions onEdit={()=>openEditor("transactions",t)} onDelete={t.source==="cuentix"?undefined:()=>void remove("transactions",t)}/></div></div>;})}{transactions.length===0&&<Empty text="No hay movimientos registrados."/>}{finTotals&&transactions.length<finTotals.transactionCount&&<button type="button" className="text-button" title="Cargar 250 movimientos más" aria-label="Cargar 250 movimientos más" onClick={()=>{const next=txLimit+250;txLimitRef.current=next;setTxLimit(next);void load(true);}}>Ver más</button>}</section></div></>}
      {section==="admin"&&isAdmin&&<><SectionIntro title="Administración" description="Aprobá o rechazá solicitudes de acceso al espacio."/><AdminUsers/></>}
      </>}
    </section>
{editor&&<div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)closeEditor();}}><section className={"editor-modal"+(editor.resource==="activities"&&activityKind==="note"?" is-note":"")} role="dialog" aria-modal="true" aria-labelledby="editor-title"><div className="panel-title"><div><p className="eyebrow">{editor.item?"EDITAR REGISTRO":"NUEVO REGISTRO"}</p><h2 id="editor-title">{editor.resource==="contacts"?"Contacto":editor.resource==="projects"?"Proyecto":editor.resource==="tasks"?"Tarea":editor.resource==="accounts"?"Cuenta":editor.resource==="activities"?(activityKind==="event"?"Evento":"Nota"):editor.resource==="recurring"?"Movimiento recurrente":"Movimiento financiero"}</h2></div><button className="icon-button" onClick={closeEditor} aria-label="Cerrar">×</button></div>{editor.resource==="activities"&&<div className="activity-type-switch" role="group" aria-label="Tipo de registro"><button type="button" className={activityKind==="event"?"selected":""} aria-pressed={activityKind==="event"} onClick={()=>setActivityKind("event")}>Evento</button><button type="button" className={activityKind==="note"?"selected":""} aria-pressed={activityKind==="note"} onClick={()=>setActivityKind("note")}>Nota</button></div>}{editor.resource==="activities"&&activityKind==="note"&&<div className="segmented-field note-editor-tabs" role="group" aria-label="Modo de edición"><button type="button" className={noteTab==="write"?"selected":""} aria-pressed={noteTab==="write"} onClick={()=>setNoteTab("write")}>Escribir</button><button type="button" className={noteTab==="preview"?"selected":""} aria-pressed={noteTab==="preview"} onClick={()=>setNoteTab("preview")}>Vista previa</button></div>}{editor.resource==="transactions"&&editor.item?.source==="cuentix"&&<p className="cuentix-note">Este movimiento viene de Cuentix. El importe, la fecha y el tipo se cambian allá.</p>}{editor.resource==="transactions"&&!!editor.item?.linkedTo&&<button type="button" className="secondary-button cuentix-unlink" onClick={()=>void unlinkMovement()}>Desvincular</button>}{editor.resource==="transactions"&&values.kind!=="income"&&editor.item?.source!=="cuentix"&&<ReceiptField receiptId={values.receiptId||""} e2e={e2e} onScanned={onScanned} onRemove={()=>setValues(v=>({...v,receiptId:""}))} onError={setError}/>}<div className="form-grid">{fields.map(f=>{const locked=editor.resource==="transactions"&&editor.item?.source==="cuentix"&&(f.key==="kind"||f.key==="amount"||f.key==="occurredAt"||f.key==="accountId");return f.type==="avatar"?<AvatarField key={f.key} label={f.label} item={editor.item} values={values} setValues={setValues} onError={setError} e2e={e2e}/>:f.type==="relations"?<RelationsField key={f.key} label={f.label} value={values[f.key]||"{}"} onChange={v=>setValues(vs=>({...vs,[f.key]:v}))}/>:<label className={f.type==="textarea"?"span-2":""} key={f.key}>{f.label}{f.type==="textarea"&&editor.resource==="activities"&&activityKind==="note"&&noteTab==="preview"?<div className="note-preview">{values[f.key]?<Markdown source={values[f.key]}/>:<p className="empty-copy">Nada para mostrar todavía.</p>}</div>:f.type==="textarea"?<textarea rows={editor.resource==="activities"?14:4} placeholder={editor.resource==="activities"?"Markdown: # Título, **negrita**, - listas, [enlace](https://…)":undefined} required={f.required} value={values[f.key]||""} onChange={e=>setValues(v=>({...v,[f.key]:e.target.value}))}/>:f.type==="segmented"?<span className={"segmented-field"+((f.options||[]).length>3?" wrap":"")} role="group" aria-label={f.label}>{(f.options||[]).map(o=><button type="button" key={o.value} className={values[f.key]===o.value?"selected":""} aria-pressed={values[f.key]===o.value} disabled={locked} onClick={()=>{if(!locked)setValues(v=>({...v,[f.key]:o.value}));}}>{o.label}</button>)}</span>:f.type==="select"?<select required={f.required} disabled={locked} value={values[f.key]||""} onChange={e=>setValues(v=>({...v,[f.key]:e.target.value}))}><option value="">— Seleccionar —</option>{(f.options||(f.key==="projectId"?projects.map(p=>({value:String(p.id),label:String(p.name)})):f.key==="contactId"?contacts.map(c=>({value:String(c.id),label:String(c.name)})):f.key==="accountId"?accounts.map(a=>({value:String(a.id),label:String(a.name)+" ("+String(a.currency)+")"})):[])).map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>:<span className="input-action"><input type={f.type||"text"} required={f.required} readOnly={locked} disabled={locked} min={f.type==="number"?"0":undefined} step={f.type==="number"?"0.01":undefined} placeholder={f.placeholder} value={values[f.key]||""} onChange={e=>setValues(v=>({...v,[f.key]:e.target.value}))}/>{editor.resource==="contacts"&&<FieldLookup k={f.key} values={values}/>}</span>}</label>})}</div>{editor.resource==="transactions"&&!editor.item?.recurringId&&editor.item?.source!=="cuentix"&&<RecurrenceField frequency={values.recurrence||""} endDate={values.recurrenceEnd||""} onChange={patch=>setValues(v=>({...v,...patch}))}/>}{editor.resource==="activities"&&<div className="activity-contact-picker"><strong>Contactos relacionados</strong><div className="activity-contact-options">{contacts.map(contact=><label key={contact.id}><input type="checkbox" checked={(values.contactIds||"").split(",").includes(contact.id)} onChange={e=>setValues(v=>{const ids=new Set((v.contactIds||"").split(",").filter(Boolean));if(e.target.checked)ids.add(contact.id);else ids.delete(contact.id);return {...v,contactIds:[...ids].join(",")};})}/><span>{String(contact.name)}</span></label>)}</div></div>}<div className="modal-actions"><button className="secondary-button" onClick={closeEditor}>Cancelar</button><button className="primary-button" disabled={saving} onClick={()=>void save()}>{saving?"Guardando…":"Guardar"}</button></div></section></div>}
    {docs.modal}
    <TimerHost timer={timer} skewMs={timerSkew} view={timerView} tasks={tasks} onView={onTimerView} onTimer={publishTimer} onEntry={publishEntry} onNotice={setNotice} onError={setError}/>
  </main>;
}
function Empty({text}:{text:string}){return <p className="empty-copy">{text}</p>}
function SectionIntro({title,description}:{title:string;description:string}){return <div className="section-intro" aria-label={title} title={description}/>;}
function Actions({onEdit,onDelete}:{onEdit:()=>void;onDelete?:()=>void}){return <div className="row-actions"><button onClick={onEdit} aria-label="Editar" title="Editar">Editar</button>{onDelete&&<button onClick={onDelete} aria-label="Eliminar" title="Eliminar">Eliminar</button>}</div>}
function CuentixMarks({item,onOpen}:{item:Item;onOpen?:()=>void}){const synced=item.source==="cuentix";const linked=!!item.linkedTo;if(!synced&&!linked)return null;return <>{synced&&<span className="tag cuentix-badge">Cuentix</span>}{linked&&(onOpen?<button type="button" className="tag cuentix-link" title="Vinculado con Cuentix, no suma doble" onClick={onOpen}>Vinculado con Cuentix, no suma doble</button>:<span className="tag cuentix-link" title="Vinculado con Cuentix, no suma doble">Vinculado con Cuentix, no suma doble</span>)}</>;}
const REL_TIP:Record<RelationKey,string>={client:"Cliente: te compra o te puede comprar",partner:"Socio: alguien con quien colaborar o emprender",supplier:"Proveedor: te vende o te puede vender"};
function RelationsField({label,value,onChange}:{label:string;value:string;onChange:(v:string)=>void}){
  const rel:Relations=contactRelations(value,"potential");
  const set=(k:RelationKey,st:RelationState|null)=>{const next:Relations={...rel};if(st)next[k]=st;else delete next[k];onChange(JSON.stringify(next));};
  return <div className="rel-field span-2" role="group" aria-label={label}><span className="field-label">{label}</span>
    {RELATION_KEYS.map(k=>{const st=rel[k];return <div className="rel-row" key={k}>
      <button type="button" className={"rel-chip rel-"+k+(st?" on":"")} aria-pressed={!!st} title={st?"Quitar: "+REL_TIP[k]:"Marcar. "+REL_TIP[k]} aria-label={RELATION_LABEL[k]} onClick={()=>set(k,st?null:"confirmed")}><span className="rel-dot" aria-hidden="true"/>{RELATION_LABEL[k]}</button>
      <span className={"segmented-field rel-state"+(st?"":" is-off")} role="group" aria-label={"Estado de "+RELATION_LABEL[k]}>
        <button type="button" className={st==="potential"?"selected":""} aria-pressed={st==="potential"} disabled={!st} title="Potencial: todavía no es" onClick={()=>set(k,"potential")}>Potencial</button>
        <button type="button" className={st==="confirmed"?"selected":""} aria-pressed={st==="confirmed"} disabled={!st} title="Confirmado: ya lo es" onClick={()=>set(k,"confirmed")}>Confirmado</button>
      </span></div>;})}
  </div>;
}
function RelationBadges({relations}:{relations:Relations}){
  const keys=RELATION_KEYS.filter(k=>relations[k]);
  if(!keys.length)return <span className="tag rel-none" title="Sin ninguna relación marcada">Sin relación</span>;
  return <span className="rel-badges">{keys.map(k=><span key={k} className={"tag rel-badge rel-"+k+(relations[k]==="potential"?" is-potential":"")} title={RELATION_LABEL[k]+(relations[k]==="potential"?" potencial":" confirmado")}>{RELATION_LABEL[k]}{relations[k]==="potential"?" ·pot.":""}</span>)}</span>;
}
function ContactAvatar({c}:{c:Item}){
  const [broken,setBroken]=useState(false);
  const initial=String(c.name||"?").trim().slice(0,1).toUpperCase();
  return <span className="contact-avatar">{Number(c.hasAvatar)===1&&!broken?<img src={"/api/avatar/"+encodeURIComponent(c.id)+"?v="+String(c.updatedAt||"")} alt="" width={40} height={40} onError={()=>setBroken(true)}/>:initial}</span>;
}
const AVATAR_OPTIONS:{id:AvatarSource;label:string;tip:string;field:string}[]=[
  {id:"x",label:"X",tip:"Usar la foto de X",field:"xUrl"},
  {id:"telegram",label:"Telegram",tip:"Usar la foto de Telegram",field:"telegramUrl"},
  {id:"github",label:"GitHub",tip:"Usar la foto de GitHub",field:"githubUrl"},
  {id:"linkedin",label:"LinkedIn",tip:"Usar la foto de LinkedIn",field:"linkedinUrl"},
  {id:"whatsapp",label:"WhatsApp",tip:"Usar la foto de WhatsApp del teléfono (solo si es pública)",field:"phone"},
  {id:"email",label:"Email",tip:"Usar la foto del email (Gravatar)",field:"email"},
];
function AvatarField({label,item,values,setValues,onError,e2e=false}:{label:string;item?:Item;values:Record<string,string>;setValues:React.Dispatch<React.SetStateAction<Record<string,string>>>;onError:(m:string)=>void;e2e?:boolean}){
  const [busy,setBusy]=useState<string|null>(null);
  const [failed,setFailed]=useState<Record<string,string>>({});
  const [confirmId,setConfirmId]=useState<string|null>(null);
  const fileRef=useRef<HTMLInputElement>(null);
  const changed="avatarData" in values;
  const current=changed?values.avatarData:(item&&Number(item.hasAvatar)===1?"/api/avatar/"+encodeURIComponent(item.id)+"?v="+String(item.updatedAt||""):"");
  const initial=String(values.name||"?").trim().slice(0,1).toUpperCase();
  const source=changed?values.avatarSource:String(item?.avatarSource||"");
  const available=AVATAR_OPTIONS.filter(o=>o.id==="email"?/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((values.email||"").trim()):o.id==="whatsapp"?!!waNumber(values.phone):!!handleOf(o.id,values[o.field]));
  const apply=(data:string,src:string)=>setValues(v=>({...v,avatarData:data,avatarSource:src}));
  const pick=async(o:typeof AVATAR_OPTIONS[number])=>{
    setBusy(o.id);
    try{apply(await fetchAvatar(o.id,values[o.field]),o.id);}
    catch(e){if(e instanceof AvatarError){onError(e.message);if(e.code==="none")setFailed(f=>({...f,[o.id]:values[o.field]||""}));}else onError("No se pudo cargar la foto");}
    finally{setBusy(null);}
  };
  const request=(o:typeof AVATAR_OPTIONS[number])=>{
    if(avatarFetchStep(e2e,confirmId===o.id)==="confirm"){setConfirmId(o.id);return;}
    setConfirmId(null);
    void pick(o);
  };
  const upload=async(file:File|undefined)=>{
    if(!file)return;setBusy("custom");
    try{if(!file.type.startsWith("image/")){onError("Elegí una imagen");return;}apply(await toSmallWebp(file),"custom");}
    catch{onError("No se pudo leer esa imagen. Probá con otra");}
    finally{setBusy(null);if(fileRef.current)fileRef.current.value="";}
  };
  return <div className="avatar-field span-2" role="group" aria-label={label}><span className="field-label">{label}</span>
    <div className="avatar-row">
      <span className="avatar-preview" aria-hidden="true">{current?<img src={current} alt="" width={64} height={64}/>:initial}</span>
      <div className="avatar-options">
        {e2e&&confirmId&&<p className="avatar-leak" role="status">{AVATAR_EXTERNAL_WARNING} <button type="button" className="avatar-chip" onClick={()=>{const o=available.find(x=>x.id===confirmId);if(o){setConfirmId(null);void pick(o);}}}>{AVATAR_EXTERNAL_CONTINUE}</button></p>}
        {available.map(o=><button type="button" key={o.id} className={"avatar-chip"+((source===o.id||source==="auto:"+o.id)&&current?" selected":"")} title={failed[o.id]===(values[o.field]||"")?"Sin foto disponible en "+o.label:o.tip} aria-label={o.tip} aria-pressed={(source===o.id||source==="auto:"+o.id)&&!!current} disabled={!!busy||failed[o.id]===(values[o.field]||"")} onClick={()=>request(o)}>{busy===o.id?"…":o.label}</button>)}
        <button type="button" className={"avatar-chip"+(source==="custom"&&current?" selected":"")} title="Subir una foto" aria-label="Subir una foto" disabled={!!busy} onClick={()=>fileRef.current?.click()}>{busy==="custom"?"…":"Subir"}</button>
        {current&&<button type="button" className="avatar-chip danger" title="Quitar la foto" aria-label="Quitar la foto" disabled={!!busy} onClick={()=>apply("","")}>Quitar</button>}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={e=>void upload(e.target.files?.[0])}/>
      </div>
    </div></div>;
}

// Next to the phone / LinkedIn / Instagram inputs. No search engine allows server-side lookups for free, so these open the
// network's own search (or a site: search) in a new tab for the user to pick the right profile and paste it.
function FieldLookup({k,values}:{k:string;values:Record<string,string>}){
  const name=(values.name||"").trim(),company=(values.companyName||"").trim();
  let href:string|null=null,tip="",label="";
  if(k==="phone"){const n=waNumber(values.phone);if(n){href="https://wa.me/"+n;tip="Abrir WhatsApp con este teléfono";label="Abrir WhatsApp";}}
  else if(k==="linkedinUrl"&&name){href="https://www.linkedin.com/search/results/people/?keywords="+encodeURIComponent((name+" "+company).trim());tip="Buscar a esta persona en LinkedIn (se abre en otra pestaña): elegí el perfil y pegá el link acá";label="Buscar en LinkedIn";}
  else if(k==="instagramUrl"&&name){href="https://www.google.com/search?q="+encodeURIComponent('site:instagram.com "'+name+'"');tip="Buscar a esta persona en Instagram (búsqueda de Google en otra pestaña): elegí el perfil y pegá el link acá";label="Buscar en Instagram";}
  else return null;
  if(!href)return null;
  return <a className="field-lookup" href={href} target="_blank" rel="noreferrer" title={tip} aria-label={label}>{k==="phone"?<MessageCircle size={16} aria-hidden="true"/>:<Search size={16} aria-hidden="true"/>}</a>;
}
