"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AdminUsers from "@/app/admin/users";
import Agenda, { Markdown } from "@/app/agenda";
import { AvatarError, autoAvatar, autoEligible, fetchAvatar, handleOf, sourcesKey, toSmallWebp, waNumber, type AvatarSource } from "@/lib/avatar-client";
import { contactRelations, RELATION_KEYS, RELATION_LABEL, type RelationKey, type RelationState, type Relations } from "@/lib/relations";
import { ArrowRight, AlertCircle, CalendarOff, Clock, UserRound, ListChecks, CalendarClock, House, Users, Wallet, ShieldCheck, Sun, Moon, Plus, ContactRound, ListPlus, WalletCards, ArrowLeftRight, CalendarDays, NotebookPen, Check, Inbox, MessageCircle, Search } from "lucide-react";
import Inquiries, { type Inquiry } from "@/app/inquiries";
import PushToggle from "@/app/push-toggle";
import MonthHeading from "@/app/month-heading";
import { toneClass } from "@/lib/palette";

const NavIcons = { home: House, contacts: Users, activity: CalendarDays, finance: Wallet, admin: ShieldCheck };
import SignOutButton from "@/app/sign-out-button";

type Item = Record<string, string | number | boolean | null | undefined> & { id: string };
type Section = "home" | "contacts" | "activity" | "finance" | "admin";
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

export default function Workspace({name,email,image,isAdmin}:{name:string;email:string;image:string|null;isAdmin:boolean}) {
  const [section,setSection]=useState<Section>("home");
  const [theme,setTheme]=useState<"light"|"dark">("light");
  const [addMenuOpen,setAddMenuOpen]=useState(false);
  const [profileMenuOpen,setProfileMenuOpen]=useState(false);
  const profileMenuRef=useRef<HTMLDivElement>(null);
  const pollingRef=useRef(false);
  const [inquiries,setInquiries]=useState<Inquiry[]>([]),[contactsTab,setContactsTab]=useState<"list"|"inquiries">("list"),[openInquiry,setOpenInquiry]=useState<string|null>(null);
  const unreadInquiries=inquiries.filter(i=>i.status==="new").length;
  const [contacts,setContacts]=useState<Item[]>([]),[projects,setProjects]=useState<Item[]>([]),[tasks,setTasks]=useState<Item[]>([]),[accounts,setAccounts]=useState<Item[]>([]),[transactions,setTransactions]=useState<Item[]>([]),[activities,setActivities]=useState<Item[]>([]);
  const [loading,setLoading]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [editor,setEditor]=useState<{resource:string;item?:Item}|null>(null),[saving,setSaving]=useState(false),[values,setValues]=useState<Record<string,string>>(empty);
  const load=useCallback(async(silent=false)=>{
    if(pollingRef.current)return;pollingRef.current=true;
    if(!silent){setLoading(true);setError("");}
    try{
      const names=["contacts","projects","tasks","accounts","transactions","activities"];
      const results=await Promise.all(names.map(async n=>{const r=await fetch("/api/data/"+n,{cache:"no-store"});if(!r.ok)throw new Error("No se pudieron cargar los datos");return (await r.json() as {items:Item[]}).items;}));
      setContacts(results[0]);setProjects(results[1]);setTasks(results[2]);setAccounts(results[3]);setTransactions(results[4]);setActivities(results[5]);
      try{const ir=await fetch("/api/inquiries",{cache:"no-store"});if(ir.ok)setInquiries((await ir.json() as {items:Inquiry[]}).items);}catch{/* inquiries are optional */}
      try{const ir=await fetch("/api/inquiries",{cache:"no-store"});if(ir.ok)setInquiries((await ir.json() as {items:Inquiry[]}).items);}catch{/* inquiries are optional */}
    }catch(e){if(!silent)setError(e instanceof Error?e.message:"Error cargando datos");}finally{if(!silent)setLoading(false);pollingRef.current=false;}
  },[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{const refresh=()=>{if(document.visibilityState==="visible")void load(true);};const timer=window.setInterval(refresh,10000);document.addEventListener("visibilitychange",refresh);return()=>{window.clearInterval(timer);document.removeEventListener("visibilitychange",refresh);};},[load]);
  useEffect(()=>{const saved=window.localStorage.getItem("serpix-theme");const initial=saved==="dark"?"dark":"light";setTheme(initial);document.documentElement.dataset.theme=initial;document.documentElement.style.colorScheme=initial;},[]);
  useEffect(()=>{if(!notice)return;const timer=window.setTimeout(()=>setNotice(""),3200);return()=>window.clearTimeout(timer);},[notice]);
  useEffect(()=>{if(!error)return;const timer=window.setTimeout(()=>setError(""),4500);return()=>window.clearTimeout(timer);},[error]);
  useEffect(()=>{if(!addMenuOpen&&!profileMenuOpen)return;const closeOnEscape=(event:KeyboardEvent)=>{if(event.key==="Escape"){setAddMenuOpen(false);setProfileMenuOpen(false);}};const closeOnOutside=(event:PointerEvent)=>{if(profileMenuOpen&&profileMenuRef.current&&!profileMenuRef.current.contains(event.target as Node))setProfileMenuOpen(false);};window.addEventListener("keydown",closeOnEscape);document.addEventListener("pointerdown",closeOnOutside);return()=>{window.removeEventListener("keydown",closeOnEscape);document.removeEventListener("pointerdown",closeOnOutside);};},[addMenuOpen,profileMenuOpen]);
  const inquiryAction=async(id:string,action:"read"|"unread"|"archive"|"unarchive"|"convert")=>{const r=await fetch("/api/inquiries/"+encodeURIComponent(id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({action})});const j=await r.json().catch(()=>({})) as {error?:string;existed?:boolean};if(!r.ok){setError(j.error||"No se pudo actualizar la solicitud");return;}if(action==="convert"){setNotice(j.existed?"Ya había un contacto con ese mail: la solicitud quedó vinculada.":"Contacto creado desde la solicitud.");await load(true);}else{const ir=await fetch("/api/inquiries",{cache:"no-store"});if(ir.ok)setInquiries((await ir.json() as {items:Inquiry[]}).items);}};
  useEffect(()=>{const id=new URLSearchParams(window.location.search).get("solicitudes");if(id){setSection("contacts");setContactsTab("inquiries");setOpenInquiry(id);window.history.replaceState(null,"","/dashboard");}},[]);
  useEffect(()=>{if(!openInquiry||contactsTab!=="inquiries"||section!=="contacts")return;const t=window.setTimeout(()=>document.getElementById("inq-"+openInquiry)?.scrollIntoView({block:"center",behavior:"smooth"}),300);return()=>window.clearTimeout(t);},[openInquiry,contactsTab,section,inquiries.length]);
  const toggleTheme=()=>{const next=theme==="light"?"dark":"light";setTheme(next);document.documentElement.dataset.theme=next;document.documentElement.style.colorScheme=next;window.localStorage.setItem("serpix-theme",next);};
  const totals=useMemo(()=>({openTasks:tasks.filter(t=>t.status!=="done"&&t.status!=="cancelled").length,activeProjects:projects.filter(p=>p.status==="active").length,income:transactions.filter(t=>t.kind==="income"),expense:transactions.filter(t=>t.kind==="expense")}),[tasks,projects,transactions]);
  const todayKey=new Date().toLocaleDateString("sv-SE");
  const homeTasks=useMemo(()=>tasks.filter(t=>t.status!=="done"&&t.status!=="cancelled").sort((a,b)=>(a.dueDate?0:1)-(b.dueDate?0:1)||String(a.dueDate||"").localeCompare(String(b.dueDate||""))).slice(0,8),[tasks]);
  const homeKpis:{id:string;icon:typeof Users;value:number;tip:string;go:Section}[]=[
    {id:"contacts",icon:Users,value:contacts.length,tip:"Contactos en tu CRM",go:"contacts"},
    {id:"tasks",icon:ListChecks,value:totals.openTasks,tip:"Tareas abiertas: pendientes o en curso",go:"activity"},
    {id:"events",icon:CalendarClock,value:activities.filter(a=>a.kind==="event"&&String(a.occurredAt||"").slice(0,10)>=todayKey).length,tip:"Eventos próximos",go:"activity"},
    {id:"money",icon:Wallet,value:transactions.length,tip:"Movimientos financieros registrados",go:"finance"},
  ];
  const autoBusy=useRef<Set<string>>(new Set());
  const autoLimited=useRef(false);
  const autoLoadAvatar=async(c:Item)=>{
    if(autoLimited.current||autoBusy.current.has(c.id))return;
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
  const [roleFilter,setRoleFilter]=useState<string>("all");
  const [stateFilter,setStateFilter]=useState<"any"|RelationState>("any");
  const [activityKind,setActivityKind]=useState<"event"|"note">("event");
  const openEditor=(resource:string,item?:Item)=>{
    const fields=resource==="contacts"?contactFields:resource==="projects"?projectFields:resource==="tasks"?taskFields:resource==="accounts"?accountFields:resource==="activities"?activityFields:transactionFields;
    const initial:Record<string,string>={};
    for(const f of fields){const v=item?.[f.key];initial[f.key]=v===undefined||v===null?"":String(v);}
    if(resource==="contacts"&&item)initial.isPotential=String(Boolean(item.isPotential));
    if(resource==="contacts")initial.relations=JSON.stringify(contactRelations(item?.relations,item?.role));
    if(resource==="activities"&&item){initial.contactIds=String(item.contactIds||"").split(",").filter(Boolean).join(",");initial.occurredAt=String(item.occurredAt||"").replace(" ","T").slice(0,16);}
    if(resource==="transactions"&&item)initial.amount=(Number(item.amountMinor||0)/100).toFixed(2);
    if(resource==="contacts"&&!item){initial.kind="person";initial.isPotential="false";initial.phone="+54 ";}
    if(resource==="projects"&&!item)initial.status="active";
    if(resource==="tasks"&&!item){initial.status="todo";initial.priority="normal";}
    if(resource==="accounts"&&!item){initial.currency="ARS";initial.openingBalance="0";}
    if(resource==="transactions"&&!item){initial.kind="expense";initial.occurredAt=new Date().toISOString().slice(0,10);initial.accountId=String(accounts[0]?.id??"");}
    if(resource==="activities"&&!item){initial.occurredAt=new Date(new Date().getTime()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);initial.contactIds="";}
    setValues(initial);setNoteTab("write");setEditor({resource,item});
  };
  const save=async()=>{
    if(!editor)return;setSaving(true);setError("");setNotice("");
    const payload:Record<string,unknown>={...values};
    if(editor.resource==="activities"){payload.kind=activityKind;payload.contactIds=values.contactIds?values.contactIds.split(",").filter(Boolean):[];}
    if(editor.resource==="contacts"){payload.isPotential=values.isPotential==="true";try{payload.relations=JSON.parse(values.relations||"{}");}catch{payload.relations={};}delete payload.role;}if(editor.resource==="contacts"&&String(values.phone||"").replace(/\D/g,"").length<=3)payload.phone="";
    if(editor.resource==="accounts")payload.openingBalanceMinor=Math.round(Number(values.openingBalance||0)*100);
    if(editor.resource==="transactions")payload.amountMinor=Math.round(Number(values.amount||0)*100);
    if(editor.resource==="tasks"){payload.projectId=values.projectId||null;payload.contactId=values.contactId||null;}
    if(editor.resource==="transactions")payload.contactId=values.contactId||null;
    try{
      let failedKey="";
      if(editor.resource==="contacts"&&!("avatarData" in values)&&Number(editor.item?.hasAvatar)!==1){
        const key=await sourcesKey(values);
        if(key&&autoEligible({hasAvatar:0,avatarTriedKey:editor.item?.avatarTriedKey,avatarTriedAt:editor.item?.avatarTriedAt},key)){
          const r=await autoAvatar(values);
          if(typeof r==="object"){payload.avatarData=r.data;payload.avatarSource="auto:"+r.source;}else if(r==="none")failedKey=key;
        }
      }
      const url="/api/data/"+editor.resource+(editor.item?"/"+encodeURIComponent(editor.item.id):"");
      const response=await fetch(url,{method:editor.item?"PATCH":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      if(!response.ok){const body=await response.json() as {error?:string};throw new Error(body.error||"No se pudo guardar");}
      if(failedKey){const saved=await response.clone().json().catch(()=>({})) as {id?:string};const cid=editor.item?.id||saved.id;if(cid)await fetch("/api/avatar/"+encodeURIComponent(cid),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({failedKey})}).catch(()=>undefined);}
      setEditor(null);setNotice(editor.item?"Cambios guardados":"Registro creado");await load();
    }catch(e){setError(e instanceof Error?e.message:"Error guardando");}finally{setSaving(false);}
  };
  const remove=async(resource:string,item:Item)=>{
    if(!window.confirm("¿Eliminar este registro? Esta acción no se puede deshacer."))return;
    setError("");setNotice("");const r=await fetch("/api/data/"+resource+"/"+encodeURIComponent(item.id),{method:"DELETE"});
    if(!r.ok){const body=await r.json() as {error?:string};setError(body.error||"No se pudo eliminar");return;}
    setNotice("Registro eliminado");await load();
  };
  const fields=editor?(editor.resource==="contacts"?contactFields:editor.resource==="projects"?projectFields:editor.resource==="tasks"?taskFields:editor.resource==="accounts"?accountFields:editor.resource==="activities"?activityFields:transactionFields):[];
  const visibleSections=sections.filter(s=>["home","contacts","activity","finance"].includes(s.id));
  const activeAddType=({contacts:"contacts",projects:"projects",tasks:"tasks",activity:"activities-event",finance:"transactions"} as Partial<Record<Section,string>>)[section];
  const addOptions=[
    {id:"contacts",label:"Contacto",icon:ContactRound},

    {id:"tasks",label:"Tarea",icon:ListPlus},
    {id:"activities-event",label:"Evento",icon:CalendarDays},
    {id:"activities-note",label:"Nota",icon:NotebookPen},
    {id:"accounts",label:"Cuenta",icon:WalletCards},
    {id:"transactions",label:"Movimiento",icon:ArrowLeftRight},
  ];
  const chooseAdd=(resource:string)=>{setAddMenuOpen(false);if(resource==="activities-event"||resource==="activities-note"){setActivityKind(resource==="activities-event"?"event":"note");openEditor("activities");}else openEditor(resource);};
  const toggleTask=async(task:Item)=>{if(taskPending)return;setTaskPending(task.id);const status=task.status==="done"?"todo":"done";const r=await fetch("/api/data/tasks/"+encodeURIComponent(task.id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:task.title,description:task.description,status,priority:task.priority,projectId:task.projectId||null,contactId:task.contactId||null,dueDate:task.dueDate||null})});if(!r.ok){setError("No se pudo actualizar la tarea");setTaskPending(null);return;}await load();setTaskPending(null);};
  const createTaskForContact=(contact:Item)=>{openEditor("tasks");setValues(v=>({...v,contactId:contact.id,title:"",description:""}));};
  const currencyTotals=(kind:"income"|"expense",currency:"ARS"|"USD")=>transactions.filter(t=>t.kind===kind&&t.currency===currency).reduce((sum,t)=>sum+Number(t.amountMinor||0),0);
  return <main className="app-shell">
    <aside className="sidebar"><a className="logo" href="/dashboard"><span className="brand-mark small"><img src="/icons/logo-128.v3.png" alt="" width="36" height="36" /></span><span>Serpix</span></a><div className="side-caption">ESPACIO DE TRABAJO</div><nav aria-label="Secciones principales">{visibleSections.map(s=>{const Icon=NavIcons[s.id];return <button key={s.id} className={"nav-item "+(section===s.id?"active":"")} aria-current={section===s.id?"page":undefined} aria-label={s.label} title={s.label} onClick={()=>{setSection(s.id);setEditor(null);setError("");setAddMenuOpen(false);setProfileMenuOpen(false);}}><span className="nav-symbol"><Icon size={19} strokeWidth={1.9}/>{s.id==="contacts"&&unreadInquiries>0&&<i className="nav-badge" aria-label={unreadInquiries+" solicitudes sin leer"}>{unreadInquiries>9?"9+":unreadInquiries}</i>}</span><span>{s.label}</span></button>;})}<div className="profile-nav-wrap" ref={profileMenuRef}>{profileMenuOpen&&<div className="profile-menu" id="serpix-profile-menu" role="group" aria-label="Menú de cuenta"><div className="profile-menu-heading"><strong>{name}</strong><small>{email}</small><span>{isAdmin?"Administrador":"Usuario"}</span></div><button type="button" className="profile-menu-item theme-menu-toggle" role="switch" aria-checked={theme==="dark"} onClick={toggleTheme}>{theme==="dark"?<Moon size={18}/>:<Sun size={18}/>}<span>Modo oscuro</span><span className={"theme-switch "+(theme==="dark"?"on":"")}><span/></span></button><PushToggle onMessage={(m,k)=>k==="ok"?setNotice(m):setError(m)}/>{isAdmin&&<button type="button" className="profile-menu-item" onClick={()=>{setSection("admin");setEditor(null);setProfileMenuOpen(false);window.scrollTo({top:0,behavior:"smooth"});}}><ShieldCheck size={18}/> Administración</button>}<div className="profile-menu-divider"/><SignOutButton/></div>}<button type="button" className={"nav-item profile-nav-item "+(profileMenuOpen?"active":"")} aria-label="Abrir menú de cuenta" aria-controls="serpix-profile-menu" aria-expanded={profileMenuOpen} title={name+" · Cuenta"} onClick={()=>setProfileMenuOpen(v=>!v)}><span className="profile-nav-avatar"><span className="profile-avatar-fallback">{name.trim().slice(0,1).toUpperCase()}</span>{image&&<img src={image} alt="" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.style.display="none";}}/>}</span><span>Perfil</span></button></div></nav></aside>
    <section className="main-area" aria-busy={loading}><div className="workspace-actions"><div className="add-menu-wrap"><button className={"add-trigger "+(addMenuOpen?"is-open":"")} onClick={()=>setAddMenuOpen(v=>!v)} aria-label="Agregar" aria-controls="serpix-add-options" aria-expanded={addMenuOpen} title="Agregar"><Plus size={23} strokeWidth={2.7}/></button>{addMenuOpen&&<div className="add-menu" id="serpix-add-options" role="group" aria-label="Qué querés agregar">{addOptions.map(option=>{const Icon=option.icon;const active=activeAddType===option.id;return <button key={option.id} type="button" className={"add-menu-item "+(active?"context-active":"")} aria-pressed={active} onClick={()=>chooseAdd(option.id)}><Icon size={18} strokeWidth={2}/><span>Agregar {option.label.toLowerCase()}</span>{active&&<span className="context-indicator">En esta sección</span>}</button>;})}</div>}</div></div>
      {error&&<div className="toast error" role="alert" aria-live="assertive">{error}<button onClick={()=>setError("")} aria-label="Cerrar notificación">×</button></div>}{notice&&<div className="toast success" role="status" aria-live="polite">{notice}<button onClick={()=>setNotice("")} aria-label="Cerrar notificación">×</button></div>}
      {loading?<div className="loading" role="status" aria-live="polite">Cargando tu espacio…</div>:<>
      {section==="home"&&<>
        <div className="home-head"><h2>Buen día, {name.split(" ")[0]}.</h2><button type="button" className={"home-inbox "+(unreadInquiries>0?"has-new":"")} title={unreadInquiries>0?unreadInquiries+" solicitudes nuevas del portfolio":"Solicitudes del portfolio"} aria-label={unreadInquiries>0?unreadInquiries+" solicitudes nuevas del portfolio":"Solicitudes del portfolio"} onClick={()=>{setSection("contacts");setContactsTab("inquiries");setEditor(null);}}><Inbox size={17} aria-hidden="true"/>{unreadInquiries>0&&<i className="nav-badge">{unreadInquiries>9?"9+":unreadInquiries}</i>}</button><span className="home-date" title={new Date().toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}><CalendarDays size={14} aria-hidden="true"/>{new Date().toLocaleDateString("es-AR",{weekday:"short",day:"numeric",month:"short"}).replace(",","")}</span></div>
        <div className="home-kpis" role="group" aria-label="Resumen">
          {homeKpis.map(k=>{const Icon=k.icon;return <button type="button" key={k.id} className="home-kpi" data-tip={k.tip} title={k.tip} aria-label={k.tip} onClick={()=>{setSection(k.go);setEditor(null);}}><Icon size={18} strokeWidth={2.1} aria-hidden="true"/><strong>{k.value}</strong></button>;})}
        </div>
        <section className="panel home-panel"><div className="home-panel-head"><h3>Próximas tareas</h3><button type="button" className="icon-link" title="Ver agenda" aria-label="Ver agenda" onClick={()=>setSection("activity")}><ArrowRight size={18} aria-hidden="true"/></button></div>
          {homeTasks.length===0?<p className="empty-copy" title="Creá una con el botón +">Sin tareas abiertas</p>:homeTasks.map(t=>{const overdue=!!t.dueDate&&String(t.dueDate)<todayKey;return <div className="home-task" key={t.id}>
            <button type="button" className={"home-check "+String(t.priority)} title={"Marcar como hecha · Prioridad "+labelStatus(t.priority).toLowerCase()} aria-label={"Marcar como hecha: "+String(t.title)} disabled={!!taskPending} onClick={()=>void toggleTask(t)}/>
            <button type="button" className="home-task-title" title={String(t.title)} onClick={()=>setSection("activity")}>{String(t.title)}</button>
            <span className="home-task-meta">
              {t.contactName&&<span className="home-meta-icon" title={"Contacto: "+String(t.contactName)} aria-label={"Contacto: "+String(t.contactName)} tabIndex={0}><UserRound size={14} aria-hidden="true"/></span>}
              {t.status==="in_progress"&&<span className="home-meta-icon" title="En curso" aria-label="En curso" tabIndex={0}><Clock size={14} aria-hidden="true"/></span>}
              <span className={"home-meta-date"+(overdue?" overdue":"")} title={t.dueDate?(overdue?"Vencida · ":"Vence ")+dateLabel(t.dueDate):"Sin fecha"} aria-label={t.dueDate?(overdue?"Vencida · ":"Vence ")+dateLabel(t.dueDate):"Sin fecha"} tabIndex={0}>{t.dueDate?<>{overdue&&<AlertCircle size={13} aria-hidden="true"/>}{String(t.dueDate).slice(8,10)+"/"+String(t.dueDate).slice(5,7)}</>:<CalendarOff size={14} aria-hidden="true"/>}</span>
            </span></div>;})}
        </section>
        <section className="panel home-panel"><div className="home-panel-head"><h3>Movimientos recientes</h3><button type="button" className="icon-link" title="Ver finanzas" aria-label="Ver finanzas" onClick={()=>setSection("finance")}><ArrowRight size={18} aria-hidden="true"/></button></div>
          {transactions.length===0?<p className="empty-copy" title="Registrá uno desde Finanzas">Sin movimientos</p>:transactions.slice(0,4).map(t=><div className="home-task" key={t.id}><span className={"money-sign "+String(t.kind)} title={t.kind==="income"?"Ingreso":"Gasto"} aria-label={t.kind==="income"?"Ingreso":"Gasto"}>{t.kind==="income"?"+":"−"}</span><span className="home-task-title static" title={String(t.accountName)+" · "+dateLabel(t.occurredAt)}>{String(t.category)}</span><b className={t.kind==="income"?"positive":"negative"}>{money(Number(t.amountMinor),String(t.currency))}</b></div>)}
        </section></>}
      {section==="contacts"&&<><SectionIntro title="CRM" description="Relaciones comerciales, contactos y oportunidades. Datos privados de tu cuenta."/><div className="segmented-field crm-tabs" role="group" aria-label="Contactos o solicitudes"><button type="button" className={contactsTab==="list"?"selected":""} aria-pressed={contactsTab==="list"} title="Tus contactos" onClick={()=>setContactsTab("list")}><Users size={15} aria-hidden="true"/> Contactos</button><button type="button" className={contactsTab==="inquiries"?"selected":""} aria-pressed={contactsTab==="inquiries"} title="Solicitudes que llegan desde el formulario del portfolio" onClick={()=>setContactsTab("inquiries")}><Inbox size={15} aria-hidden="true"/> Solicitudes{unreadInquiries>0&&<i className="tab-count">{unreadInquiries}</i>}</button></div>{contactsTab==="inquiries"?<Inquiries items={inquiries} openId={openInquiry} onAction={inquiryAction} onViewContact={()=>setContactsTab("list")}/>:<><div className="contact-filters"><div className="segmented-field wrap contact-filter" role="group" aria-label="Filtrar por relación">{([["all","Todos","Todos los contactos"],["client","Clientes","Contactos que son o pueden ser clientes"],["partner","Socios","Contactos que son o pueden ser socios"],["supplier","Proveedores","Contactos que son o pueden ser proveedores"],["none","Sin relación","Contactos sin ninguna relación marcada"]] as [string,string,string][]).map(([id,label,tip])=><button type="button" key={id} title={tip} className={roleFilter===id?"selected":""} aria-pressed={roleFilter===id} onClick={()=>setRoleFilter(id)}>{label}</button>)}</div><div className="segmented-field contact-filter state-filter" role="group" aria-label="Filtrar por estado">{([["any","Todos","Potenciales y confirmados"],["potential","Potenciales","Solo potenciales"],["confirmed","Confirmados","Solo confirmados"]] as [string,string,string][]).map(([id,label,tip])=><button type="button" key={id} title={tip} className={stateFilter===id?"selected":""} aria-pressed={stateFilter===id} disabled={roleFilter==="none"} onClick={()=>setStateFilter(id as "any"|RelationState)}>{label}</button>)}</div></div><div className="contact-list">{contacts.length===0?<div className="panel"><Empty text="Todavía no hay contactos. Creá el primero para empezar a organizar tus relaciones."/></div>:contacts.filter(c=>{const r=contactRelations(c.relations,c.role);if(roleFilter==="all")return stateFilter==="any"||Object.values(r).includes(stateFilter);if(roleFilter==="none")return Object.keys(r).length===0;const st=r[roleFilter as RelationKey];return !!st&&(stateFilter==="any"||st===stateFilter);}).map(c=><details className="panel contact-card" key={c.id} onToggle={e=>{if((e.currentTarget as HTMLDetailsElement).open)void autoLoadAvatar(c);}}><summary><ContactAvatar c={c}/><span className="contact-summary-main"><strong>{String(c.name)}</strong><small>{String(c.companyName|| (c.kind==="company"?"Empresa":"Persona"))}</small></span><RelationBadges relations={contactRelations(c.relations,c.role)}/><span className="contact-chevron">⌄</span></summary><div className="contact-details"><div className="contact-facts">{c.email&&<a href={"mailto:"+String(c.email)}>{String(c.email)}</a>}{String(c.phone||"").replace(/[^\d]/g,"").length>3&&<a href={"tel:"+String(c.phone).replace(/[^\d+]/g,"")}>{String(c.phone)}</a>}{waNumber(c.phone)&&!socialHref("whatsapp",c.whatsappUrl)&&<a href={"https://wa.me/"+waNumber(c.phone)} target="_blank" rel="noreferrer" title="Abrir WhatsApp con este teléfono">WhatsApp</a>}{socialHref("x",c.xUrl)&&<a href={socialHref("x",c.xUrl)||undefined} target="_blank" rel="noreferrer" title={String(c.xUrl)}>X</a>}{socialHref("instagram",c.instagramUrl)&&<a href={socialHref("instagram",c.instagramUrl)||undefined} target="_blank" rel="noreferrer" title={String(c.instagramUrl)}>Instagram</a>}{socialHref("telegram",c.telegramUrl)&&<a href={socialHref("telegram",c.telegramUrl)||undefined} target="_blank" rel="noreferrer" title={String(c.telegramUrl)}>Telegram</a>}{socialHref("whatsapp",c.whatsappUrl)&&<a href={socialHref("whatsapp",c.whatsappUrl)||undefined} target="_blank" rel="noreferrer" title={String(c.whatsappUrl)}>WhatsApp</a>}{socialHref("linkedin",c.linkedinUrl)&&<a href={socialHref("linkedin",c.linkedinUrl)||undefined} target="_blank" rel="noreferrer" title={String(c.linkedinUrl)}>LinkedIn</a>}{socialHref("github",c.githubUrl)&&<a href={socialHref("github",c.githubUrl)||undefined} target="_blank" rel="noreferrer" title={String(c.githubUrl)}>GitHub</a>}</div>{c.notes&&<p className="contact-notes">{String(c.notes)}</p>}<div className="contact-related"><strong>Tareas vinculadas</strong>{tasks.filter(t=>t.contactId===c.id).length===0?<small>Sin tareas asociadas</small>:tasks.filter(t=>t.contactId===c.id).map(t=><span key={t.id}>{String(t.title)} · {labelStatus(t.status)}</span>)}</div>{activities.filter(a=>String(a.contactIds||"").split(",").includes(String(c.id))).length>0&&<div className="contact-related"><strong>Eventos y notas</strong>{activities.filter(a=>String(a.contactIds||"").split(",").includes(String(c.id))).map(a=><span key={a.id}>{a.kind==="event"?"Evento":"Nota"} · {String(a.title)} · {dateLabel(String(a.occurredAt).slice(0,10))}</span>)}</div>}<div className="contact-actions"><button className="secondary-button compact" onClick={()=>createTaskForContact(c)}>+ Crear tarea</button><Actions onEdit={()=>openEditor("contacts",c)} onDelete={()=>void remove("contacts",c)}/></div></div></details>)}</div></>}</>}
      {section==="activity"&&<Agenda tasks={tasks} activities={activities} taskPending={taskPending} onToggleTask={t=>void toggleTask(t)} onEditTask={t=>openEditor("tasks",t)} onEditActivity={a=>{setActivityKind(a.kind==="event"?"event":"note");openEditor("activities",a);}} onDeleteTask={t=>void remove("tasks",t)} onDeleteActivity={a=>void remove("activities",a)}/>}
      {section==="finance"&&<><SectionIntro title="Finanzas" description="Cuentas, ingresos y gastos. Importes guardados en centavos para evitar errores de redondeo."/><div className="finance-summary"><div className="panel"><small>Ingresos registrados · ARS</small><strong className="positive">{money(currencyTotals("income","ARS"),"ARS")}</strong></div><div className="panel"><small>Gastos registrados · ARS</small><strong className="negative">{money(currencyTotals("expense","ARS"),"ARS")}</strong></div><div className="panel"><small>Ingresos registrados · USD</small><strong className="positive">{money(currencyTotals("income","USD"),"USD")}</strong></div><div className="panel"><small>Gastos registrados · USD</small><strong className="negative">{money(currencyTotals("expense","USD"),"USD")}</strong></div></div><div className="finance-layout"><section className="panel"><div className="panel-title"><h2>Cuentas</h2><button className="text-button" onClick={()=>openEditor("accounts")}>+ Agregar</button></div>{accounts.map(a=><div className="account-line" key={a.id}><div><strong>{String(a.name)}</strong><small>{String(a.currency)}</small></div><b>{money(Number(a.balanceMinor),String(a.currency))}</b><Actions onEdit={()=>openEditor("accounts",a)} onDelete={()=>void remove("accounts",a)}/></div>)}{accounts.length===0&&<Empty text="Creá una cuenta para registrar movimientos."/>}</section><section className="panel"><div className="panel-title"><h2>Últimos movimientos</h2></div>{transactions.map((t,i)=>{const mk=String(t.occurredAt||"").slice(0,7);const first=i===0||String(transactions[i-1].occurredAt||"").slice(0,7)!==mk;return <div key={t.id} className={toneClass(mk)}>{first&&mk&&<MonthHeading day={mk+"-01"}/>}<div className="list-line"><span className={"money-sign "+String(t.kind)}>{t.kind==="income"?"+":"−"}</span><div><strong>{String(t.category)}</strong><small>{String(t.description||t.accountName)} · {dateLabel(t.occurredAt)}</small></div><b className={t.kind==="income"?"positive":"negative"}>{money(Number(t.amountMinor),String(t.currency))}</b><Actions onEdit={()=>openEditor("transactions",t)} onDelete={()=>void remove("transactions",t)}/></div></div>;})}{transactions.length===0&&<Empty text="No hay movimientos registrados."/>}</section></div></>}
      {section==="admin"&&isAdmin&&<><SectionIntro title="Administración" description="Aprobá o rechazá solicitudes de acceso al espacio."/><AdminUsers/></>}
      </>}
    </section>
{editor&&<div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setEditor(null);}}><section className={"editor-modal"+(editor.resource==="activities"&&activityKind==="note"?" is-note":"")} role="dialog" aria-modal="true" aria-labelledby="editor-title"><div className="panel-title"><div><p className="eyebrow">{editor.item?"EDITAR REGISTRO":"NUEVO REGISTRO"}</p><h2 id="editor-title">{editor.resource==="contacts"?"Contacto":editor.resource==="projects"?"Proyecto":editor.resource==="tasks"?"Tarea":editor.resource==="accounts"?"Cuenta":editor.resource==="activities"?(activityKind==="event"?"Evento":"Nota"):"Movimiento financiero"}</h2></div><button className="icon-button" onClick={()=>setEditor(null)} aria-label="Cerrar">×</button></div>{editor.resource==="activities"&&<div className="activity-type-switch" role="group" aria-label="Tipo de registro"><button type="button" className={activityKind==="event"?"selected":""} aria-pressed={activityKind==="event"} onClick={()=>setActivityKind("event")}>Evento</button><button type="button" className={activityKind==="note"?"selected":""} aria-pressed={activityKind==="note"} onClick={()=>setActivityKind("note")}>Nota</button></div>}{editor.resource==="activities"&&activityKind==="note"&&<div className="segmented-field note-editor-tabs" role="group" aria-label="Modo de edición"><button type="button" className={noteTab==="write"?"selected":""} aria-pressed={noteTab==="write"} onClick={()=>setNoteTab("write")}>Escribir</button><button type="button" className={noteTab==="preview"?"selected":""} aria-pressed={noteTab==="preview"} onClick={()=>setNoteTab("preview")}>Vista previa</button></div>}<div className="form-grid">{fields.map(f=>f.type==="avatar"?<AvatarField key={f.key} label={f.label} item={editor.item} values={values} setValues={setValues} onError={setError}/>:f.type==="relations"?<RelationsField key={f.key} label={f.label} value={values[f.key]||"{}"} onChange={v=>setValues(vs=>({...vs,[f.key]:v}))}/>:<label className={f.type==="textarea"?"span-2":""} key={f.key}>{f.label}{f.type==="textarea"&&editor.resource==="activities"&&activityKind==="note"&&noteTab==="preview"?<div className="note-preview">{values[f.key]?<Markdown source={values[f.key]}/>:<p className="empty-copy">Nada para mostrar todavía.</p>}</div>:f.type==="textarea"?<textarea rows={editor.resource==="activities"?14:4} placeholder={editor.resource==="activities"?"Markdown: # Título, **negrita**, - listas, [enlace](https://…)":undefined} required={f.required} value={values[f.key]||""} onChange={e=>setValues(v=>({...v,[f.key]:e.target.value}))}/>:f.type==="segmented"?<span className={"segmented-field"+((f.options||[]).length>3?" wrap":"")} role="group" aria-label={f.label}>{(f.options||[]).map(o=><button type="button" key={o.value} className={values[f.key]===o.value?"selected":""} aria-pressed={values[f.key]===o.value} onClick={()=>setValues(v=>({...v,[f.key]:o.value}))}>{o.label}</button>)}</span>:f.type==="select"?<select required={f.required} value={values[f.key]||""} onChange={e=>setValues(v=>({...v,[f.key]:e.target.value}))}><option value="">— Seleccionar —</option>{(f.options||(f.key==="projectId"?projects.map(p=>({value:String(p.id),label:String(p.name)})):f.key==="contactId"?contacts.map(c=>({value:String(c.id),label:String(c.name)})):f.key==="accountId"?accounts.map(a=>({value:String(a.id),label:String(a.name)+" ("+String(a.currency)+")"})):[])).map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>:<span className="input-action"><input type={f.type||"text"} required={f.required} min={f.type==="number"?"0":undefined} step={f.type==="number"?"0.01":undefined} placeholder={f.placeholder} value={values[f.key]||""} onChange={e=>setValues(v=>({...v,[f.key]:e.target.value}))}/>{editor.resource==="contacts"&&<FieldLookup k={f.key} values={values}/>}</span>}</label>)}</div>{editor.resource==="activities"&&<div className="activity-contact-picker"><strong>Contactos relacionados</strong><div className="activity-contact-options">{contacts.map(contact=><label key={contact.id}><input type="checkbox" checked={(values.contactIds||"").split(",").includes(contact.id)} onChange={e=>setValues(v=>{const ids=new Set((v.contactIds||"").split(",").filter(Boolean));if(e.target.checked)ids.add(contact.id);else ids.delete(contact.id);return {...v,contactIds:[...ids].join(",")};})}/><span>{String(contact.name)}</span></label>)}</div></div>}<div className="modal-actions"><button className="secondary-button" onClick={()=>setEditor(null)}>Cancelar</button><button className="primary-button" disabled={saving} onClick={()=>void save()}>{saving?"Guardando…":"Guardar"}</button></div></section></div>}
  </main>;
}
function Stat({label,value,detail}:{label:string;value:number;detail:string}){return <div className="panel stat-card" title={detail}><small>{label}</small><strong>{value}</strong><span>{detail}</span></div>}
function Empty({text}:{text:string}){return <p className="empty-copy">{text}</p>}
function SectionIntro({title,description}:{title:string;description:string}){return <div className="section-intro" aria-label={title} title={description}/>;}
function Actions({onEdit,onDelete}:{onEdit:()=>void;onDelete:()=>void}){return <div className="row-actions"><button onClick={onEdit} aria-label="Editar" title="Editar">Editar</button><button onClick={onDelete} aria-label="Eliminar" title="Eliminar">Eliminar</button></div>}
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
function AvatarField({label,item,values,setValues,onError}:{label:string;item?:Item;values:Record<string,string>;setValues:React.Dispatch<React.SetStateAction<Record<string,string>>>;onError:(m:string)=>void}){
  const [busy,setBusy]=useState<string|null>(null);
  const [failed,setFailed]=useState<Record<string,string>>({});
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
        {available.map(o=><button type="button" key={o.id} className={"avatar-chip"+((source===o.id||source==="auto:"+o.id)&&current?" selected":"")} title={failed[o.id]===(values[o.field]||"")?"Sin foto disponible en "+o.label:o.tip} aria-label={o.tip} aria-pressed={(source===o.id||source==="auto:"+o.id)&&!!current} disabled={!!busy||failed[o.id]===(values[o.field]||"")} onClick={()=>void pick(o)}>{busy===o.id?"…":o.label}</button>)}
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
