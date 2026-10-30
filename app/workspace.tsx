"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AdminUsers from "@/app/admin/users";
import { House, Users, FolderKanban, ListTodo, Wallet, ShieldCheck, RefreshCw, Sun, Moon, Plus, ContactRound, FolderPlus, ListPlus, WalletCards, ArrowLeftRight } from "lucide-react";

const NavIcons = { home: House, contacts: Users, projects: FolderKanban, tasks: ListTodo, finance: Wallet, admin: ShieldCheck };
import SignOutButton from "@/app/sign-out-button";

type Item = Record<string, string | number | boolean | null | undefined> & { id: string };
type Section = "home" | "contacts" | "projects" | "tasks" | "finance" | "admin";
type Field = { key:string; label:string; type?:"text"|"textarea"|"select"|"date"|"number"|"email"|"tel"; required?:boolean; options?:{value:string;label:string}[]; placeholder?:string };
const sections:{id:Section;label:string;short:string}[]=[
  {id:"home",label:"Resumen",short:"Inicio"},{id:"contacts",label:"Contactos",short:"CRM"},
  {id:"projects",label:"Proyectos",short:"Proyectos"},{id:"tasks",label:"Tareas",short:"Tareas"},
  {id:"finance",label:"Finanzas",short:"Finanzas"},{id:"admin",label:"Accesos",short:"Admin"}
];
const empty:Record<string,string>={};
const contactFields:Field[]=[{key:"name",label:"Nombre",required:true},{key:"kind",label:"Tipo",type:"select",options:[{value:"person",label:"Persona"},{value:"company",label:"Empresa"}]},{key:"companyName",label:"Empresa / organización"},{key:"email",label:"Email",type:"email"},{key:"phone",label:"Teléfono",type:"tel",placeholder:"+54 9 ..."},{key:"notes",label:"Notas",type:"textarea"},{key:"isPotential",label:"Oportunidad",type:"select",options:[{value:"false",label:"No"},{value:"true",label:"Sí"}]}];
const projectFields:Field[]=[{key:"name",label:"Nombre",required:true},{key:"description",label:"Descripción",type:"textarea"},{key:"status",label:"Estado",type:"select",options:[{value:"active",label:"Activo"},{value:"paused",label:"Pausado"},{value:"completed",label:"Completado"},{value:"archived",label:"Archivado"}]},{key:"startDate",label:"Inicio",type:"date"},{key:"dueDate",label:"Fecha límite",type:"date"}];
const taskFields:Field[]=[{key:"title",label:"Tarea",required:true},{key:"description",label:"Descripción",type:"textarea"},{key:"status",label:"Estado",type:"select",options:[{value:"todo",label:"Pendiente"},{value:"in_progress",label:"En curso"},{value:"done",label:"Hecha"},{value:"cancelled",label:"Cancelada"}]},{key:"priority",label:"Prioridad",type:"select",options:[{value:"low",label:"Baja"},{value:"normal",label:"Normal"},{value:"high",label:"Alta"},{value:"urgent",label:"Urgente"}]},{key:"projectId",label:"Proyecto",type:"select"},{key:"contactId",label:"Contacto",type:"select"},{key:"dueDate",label:"Vencimiento",type:"date"}];
const accountFields:Field[]=[{key:"name",label:"Nombre de la cuenta",required:true},{key:"currency",label:"Moneda",type:"select",options:[{value:"ARS",label:"ARS"},{value:"USD",label:"USD"}]},{key:"openingBalance",label:"Saldo inicial",type:"number",placeholder:"0,00"}];
const transactionFields:Field[]=[{key:"kind",label:"Tipo",type:"select",options:[{value:"expense",label:"Gasto"},{value:"income",label:"Ingreso"}]},{key:"amount",label:"Importe",type:"number",required:true,placeholder:"0,00"},{key:"category",label:"Categoría",required:true,placeholder:"Ej. Servicios, ventas, alquiler"},{key:"accountId",label:"Cuenta",type:"select",required:true},{key:"contactId",label:"Contacto",type:"select"},{key:"occurredAt",label:"Fecha",type:"date"},{key:"description",label:"Detalle",type:"textarea"}];
const money=(minor:number,currency:string)=>new Intl.NumberFormat("es-AR",{style:"currency",currency,maximumFractionDigits:2}).format(minor/100);
const dateLabel=(value:unknown)=>typeof value==="string"&&value?new Date(value+"T12:00:00").toLocaleDateString("es-AR"):"Sin fecha";
const labelStatus=(value:unknown)=>({active:"Activo",paused:"Pausado",completed:"Completado",archived:"Archivado",todo:"Pendiente",in_progress:"En curso",done:"Hecha",cancelled:"Cancelada",low:"Baja",normal:"Normal",high:"Alta",urgent:"Urgente"} as Record<string,string>)[String(value)]??String(value??"—");

export default function Workspace({name,email,image,isAdmin}:{name:string;email:string;image:string|null;isAdmin:boolean}) {
  const [section,setSection]=useState<Section>("home");
  const [theme,setTheme]=useState<"light"|"dark">("light");
  const [addMenuOpen,setAddMenuOpen]=useState(false);\n  const [profileMenuOpen,setProfileMenuOpen]=useState(false);\n  const profileMenuRef=useRef<HTMLDivElement>(null);
  const [contacts,setContacts]=useState<Item[]>([]),[projects,setProjects]=useState<Item[]>([]),[tasks,setTasks]=useState<Item[]>([]),[accounts,setAccounts]=useState<Item[]>([]),[transactions,setTransactions]=useState<Item[]>([]);
  const [loading,setLoading]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [editor,setEditor]=useState<{resource:string;item?:Item}|null>(null),[saving,setSaving]=useState(false),[values,setValues]=useState<Record<string,string>>(empty);
  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const names=["contacts","projects","tasks","accounts","transactions"];
      const results=await Promise.all(names.map(async n=>{const r=await fetch("/api/data/"+n,{cache:"no-store"});if(!r.ok)throw new Error("No se pudieron cargar los datos");return (await r.json() as {items:Item[]}).items;}));
      setContacts(results[0]);setProjects(results[1]);setTasks(results[2]);setAccounts(results[3]);setTransactions(results[4]);
    }catch(e){setError(e instanceof Error?e.message:"Error cargando datos");}finally{setLoading(false);}
  },[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{const saved=window.localStorage.getItem("serpix-theme");const initial=saved==="dark"?"dark":"light";setTheme(initial);document.documentElement.dataset.theme=initial;document.documentElement.style.colorScheme=initial;},[]);
  useEffect(()=>{if(!notice)return;const timer=window.setTimeout(()=>setNotice(""),3200);return()=>window.clearTimeout(timer);},[notice]);
  useEffect(()=>{if(!error)return;const timer=window.setTimeout(()=>setError(""),4500);return()=>window.clearTimeout(timer);},[error]);
  useEffect(()=>{if(!addMenuOpen&&!profileMenuOpen)return;const closeOnEscape=(event:KeyboardEvent)=>{if(event.key==="Escape"){setAddMenuOpen(false);setProfileMenuOpen(false);}};const closeOnOutside=(event:PointerEvent)=>{if(profileMenuOpen&&profileMenuRef.current&&!profileMenuRef.current.contains(event.target as Node))setProfileMenuOpen(false);};window.addEventListener("keydown",closeOnEscape);document.addEventListener("pointerdown",closeOnOutside);return()=>{window.removeEventListener("keydown",closeOnEscape);document.removeEventListener("pointerdown",closeOnOutside);};},[addMenuOpen,profileMenuOpen]);
  const toggleTheme=()=>{const next=theme==="light"?"dark":"light";setTheme(next);document.documentElement.dataset.theme=next;document.documentElement.style.colorScheme=next;window.localStorage.setItem("serpix-theme",next);};
  const totals=useMemo(()=>({openTasks:tasks.filter(t=>t.status!=="done"&&t.status!=="cancelled").length,activeProjects:projects.filter(p=>p.status==="active").length,income:transactions.filter(t=>t.kind==="income"),expense:transactions.filter(t=>t.kind==="expense")}),[tasks,projects,transactions]);
  const openEditor=(resource:string,item?:Item)=>{
    const fields=resource==="contacts"?contactFields:resource==="projects"?projectFields:resource==="tasks"?taskFields:resource==="accounts"?accountFields:transactionFields;
    const initial:Record<string,string>={};
    for(const f of fields){const v=item?.[f.key];initial[f.key]=v===undefined||v===null?"":String(v);}
    if(resource==="contacts"&&item)initial.isPotential=String(Boolean(item.isPotential));
    if(resource==="transactions"&&item)initial.amount=(Number(item.amountMinor||0)/100).toFixed(2);
    if(resource==="contacts"&&!item){initial.kind="person";initial.isPotential="false";}
    if(resource==="projects"&&!item)initial.status="active";
    if(resource==="tasks"&&!item){initial.status="todo";initial.priority="normal";}
    if(resource==="accounts"&&!item){initial.currency="ARS";initial.openingBalance="0";}
    if(resource==="transactions"&&!item){initial.kind="expense";initial.occurredAt=new Date().toISOString().slice(0,10);initial.accountId=String(accounts[0]?.id??"");}
    setValues(initial);setEditor({resource,item});
  };
  const save=async()=>{
    if(!editor)return;setSaving(true);setError("");
    const payload:Record<string,unknown>={...values};
    if(editor.resource==="contacts")payload.isPotential=values.isPotential==="true";
    if(editor.resource==="accounts")payload.openingBalanceMinor=Math.round(Number(values.openingBalance||0)*100);
    if(editor.resource==="transactions")payload.amountMinor=Math.round(Number(values.amount||0)*100);
    if(editor.resource==="tasks"){payload.projectId=values.projectId||null;payload.contactId=values.contactId||null;}
    if(editor.resource==="transactions")payload.contactId=values.contactId||null;
    try{
      const url="/api/data/"+editor.resource+(editor.item?"/"+encodeURIComponent(editor.item.id):"");
      const response=await fetch(url,{method:editor.item?"PATCH":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      if(!response.ok){const body=await response.json() as {error?:string};throw new Error(body.error||"No se pudo guardar");}
      setEditor(null);setNotice(editor.item?"Cambios guardados":"Registro creado");await load();
    }catch(e){setError(e instanceof Error?e.message:"Error guardando");}finally{setSaving(false);}
  };
  const remove=async(resource:string,item:Item)=>{
    if(!window.confirm("¿Eliminar este registro? Esta acción no se puede deshacer."))return;
    const r=await fetch("/api/data/"+resource+"/"+encodeURIComponent(item.id),{method:"DELETE"});
    if(!r.ok){const body=await r.json() as {error?:string};setError(body.error||"No se pudo eliminar");return;}
    setNotice("Registro eliminado");await load();
  };
  const fields=editor?(editor.resource==="contacts"?contactFields:editor.resource==="projects"?projectFields:editor.resource==="tasks"?taskFields:editor.resource==="accounts"?accountFields:transactionFields):[];
  const visibleSections=sections.filter(s=>s.id!=="admin"||isAdmin);
  const activeAddType=({contacts:"contacts",projects:"projects",tasks:"tasks",finance:"transactions"} as Partial<Record<Section,string>>)[section];
  const addOptions=[
    {id:"contacts",label:"Contacto",icon:ContactRound},
    {id:"projects",label:"Proyecto",icon:FolderPlus},
    {id:"tasks",label:"Tarea",icon:ListPlus},
    {id:"accounts",label:"Cuenta",icon:WalletCards},
    {id:"transactions",label:"Movimiento",icon:ArrowLeftRight},
  ];
  const chooseAdd=(resource:string)=>{setAddMenuOpen(false);openEditor(resource);};
  const currencyTotals=(kind:"income"|"expense",currency:"ARS"|"USD")=>transactions.filter(t=>t.kind===kind&&t.currency===currency).reduce((sum,t)=>sum+Number(t.amountMinor||0),0);
  return <main className="app-shell">
    <aside className="sidebar"><a className="logo" href="/dashboard"><span className="brand-mark small"><img src="/serpix-mark-v2.svg" alt="" /></span><span>serpix</span></a><div className="side-caption">ESPACIO DE TRABAJO</div><nav aria-label="Secciones principales">{visibleSections.map(s=>{const Icon=NavIcons[s.id];return <button key={s.id} className={"nav-item "+(section===s.id?"active":"")} aria-current={section===s.id?"page":undefined} aria-label={s.label} title={s.label} onClick={()=>{setSection(s.id);setEditor(null);setError("");setAddMenuOpen(false);}}><span className="nav-symbol"><Icon size={17} strokeWidth={1.9}/></span>{s.label}</button>;})}</nav></aside>
    <section className="main-area" aria-busy={loading}><header className="topbar"><div><span className="eyebrow">SERPIX</span><h1>{section==="home"?"Resumen general":sections.find(s=>s.id===section)?.label}</h1></div><div className="topbar-actions"><div className="add-menu-wrap"><button className={"add-trigger "+(addMenuOpen?"is-open":"")} onClick={()=>setAddMenuOpen(v=>!v)} aria-label="Agregar" aria-controls="serpix-add-options" aria-expanded={addMenuOpen} title="Agregar"><Plus size={23} strokeWidth={2.7}/></button>{addMenuOpen&&<div className="add-menu" id="serpix-add-options" role="group" aria-label="Qué querés agregar">{addOptions.map(option=>{const Icon=option.icon;const active=activeAddType===option.id;return <button key={option.id} type="button" className={"add-menu-item "+(active?"context-active":"")} aria-pressed={active} onClick={()=>chooseAdd(option.id)}><Icon size={18} strokeWidth={2}/><span>Agregar {option.label.toLowerCase()}</span>{active&&<span className="context-indicator">En esta sección</span>}</button>;})}</div>}</div><button className="icon-button" onClick={toggleTheme} aria-label={theme==="light"?"Activar tema oscuro":"Activar tema claro"} aria-pressed={theme==="dark"} title={theme==="light"?"Tema oscuro":"Tema claro"}>{theme==="light"?<Moon size={17}/>:<Sun size={17}/>}</button><button className="icon-button" onClick={()=>void load()} aria-label="Actualizar datos" title="Actualizar"><RefreshCw size={16}/></button></div></header>
      {error&&<div className="toast error" role="alert" aria-live="assertive">{error}<button onClick={()=>setError("")} aria-label="Cerrar notificación">×</button></div>}{notice&&<div className="toast success" role="status" aria-live="polite">{notice}<button onClick={()=>setNotice("")} aria-label="Cerrar notificación">×</button></div>}
      {loading?<div className="loading" role="status" aria-live="polite">Cargando tu espacio…</div>:<>
      {section==="home"&&<><div className="welcome"><div><p className="eyebrow">TU OPERACIÓN, EN UN SOLO LUGAR</p><h2>Buen día, {name.split(" ")[0]}.</h2><p>Este es el estado actual de tu espacio de trabajo.</p></div><span className="today">{new Date().toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long"})}</span></div><div className="stat-grid"><Stat label="Contactos" value={contacts.length} detail="En tu CRM"/><Stat label="Proyectos activos" value={totals.activeProjects} detail="En ejecución"/><Stat label="Tareas abiertas" value={totals.openTasks} detail="Pendientes o en curso"/><Stat label="Movimientos" value={transactions.length} detail="Registros financieros"/></div><div className="dashboard-grid"><section className="panel"><div className="panel-title"><h2>Próximas tareas</h2><button className="text-button" onClick={()=>setSection("tasks")}>Ver todas →</button></div>{tasks.filter(t=>t.status!=="done"&&t.status!=="cancelled").slice(0,5).map(t=><div className="list-line" key={t.id}><span className={"task-dot "+String(t.priority)}/><div><strong>{String(t.title)}</strong><small>{String(t.projectName||"Sin proyecto")} · {dateLabel(t.dueDate)}</small></div><span className="tag">{labelStatus(t.status)}</span></div>)}{tasks.filter(t=>t.status!=="done"&&t.status!=="cancelled").length===0&&<Empty text="No tenés tareas abiertas. Podés crear una desde la sección Tareas."/>}</section><section className="panel"><div className="panel-title"><h2>Actividad reciente</h2><button className="text-button" onClick={()=>setSection("finance")}>Finanzas →</button></div>{transactions.slice(0,5).map(t=><div className="list-line" key={t.id}><span className={"money-sign "+String(t.kind)}>{t.kind==="income"?"+":"−"}</span><div><strong>{String(t.category)}</strong><small>{String(t.accountName)} · {dateLabel(t.occurredAt)}</small></div><b className={t.kind==="income"?"positive":"negative"}>{money(Number(t.amountMinor),String(t.currency))}</b></div>)}{transactions.length===0&&<Empty text="Todavía no hay movimientos financieros registrados."/>}</section></div></>}
      {section==="contacts"&&<><SectionIntro title="CRM" description="Personas, empresas y oportunidades. Los datos son privados de tu cuenta."/><div className="panel table-panel">{contacts.length===0?<Empty text="Todavía no hay contactos. Creá el primero para empezar a organizar tus relaciones."/>:<div className="data-table"><div className="table-head contacts-cols"><span>Nombre</span><span>Tipo</span><span>Contacto</span><span>Oportunidad</span><span/></div>{contacts.map(c=><div className="table-row contacts-cols" key={c.id}><div><strong>{String(c.name)}</strong><small>{String(c.companyName||"")}</small></div><span>{c.kind==="company"?"Empresa":"Persona"}</span><span>{String(c.email||c.phone||"—")}</span><span>{c.isPotential?"Sí":"—"}</span><Actions onEdit={()=>openEditor("contacts",c)} onDelete={()=>void remove("contacts",c)}/></div>)}</div>}</div></>}
      {section==="projects"&&<><SectionIntro title="Proyectos" description="Organizá iniciativas, fechas y estado de ejecución."/><div className="card-grid">{projects.map(p=><article className="panel project-card" key={p.id}><div className="card-top"><span className={"tag status-"+String(p.status)}>{labelStatus(p.status)}</span><Actions onEdit={()=>openEditor("projects",p)} onDelete={()=>void remove("projects",p)}/></div><h3>{String(p.name)}</h3><p>{String(p.description||"Sin descripción")}</p><div className="card-meta"><span>Inicio: {dateLabel(p.startDate)}</span><span>Entrega: {dateLabel(p.dueDate)}</span></div><small>{tasks.filter(t=>t.projectId===p.id&&t.status==="done").length} / {tasks.filter(t=>t.projectId===p.id).length} tareas completadas</small></article>)}{projects.length===0&&<div className="panel"><Empty text="No hay proyectos todavía. Creá uno para agrupar tareas y fechas."/> </div>}</div></>}
      {section==="tasks"&&<><SectionIntro title="Tareas" description="Seguimiento de pendientes, prioridades y fechas límite."/><div className="task-board">{(["todo","in_progress","done"] as const).map(status=><section className="task-column" key={status}><div className="column-heading"><h3>{labelStatus(status)}</h3><span>{tasks.filter(t=>t.status===status).length}</span></div>{tasks.filter(t=>t.status===status).map(t=><article className="task-card" key={t.id}><div className="card-top"><span className={"priority priority-"+String(t.priority)}>{labelStatus(t.priority)}</span><Actions onEdit={()=>openEditor("tasks",t)} onDelete={()=>void remove("tasks",t)}/></div><strong>{String(t.title)}</strong><p>{String(t.description||"")}</p><small>{String(t.projectName||"Sin proyecto")} · {dateLabel(t.dueDate)}</small></article>)}</section>)}</div></>}
      {section==="finance"&&<><SectionIntro title="Finanzas" description="Cuentas, ingresos y gastos. Importes guardados en centavos para evitar errores de redondeo."/><div className="finance-summary"><div className="panel"><small>Ingresos registrados · ARS</small><strong className="positive">{money(currencyTotals("income","ARS"),"ARS")}</strong></div><div className="panel"><small>Gastos registrados · ARS</small><strong className="negative">{money(currencyTotals("expense","ARS"),"ARS")}</strong></div><div className="panel"><small>Ingresos registrados · USD</small><strong className="positive">{money(currencyTotals("income","USD"),"USD")}</strong></div><div className="panel"><small>Gastos registrados · USD</small><strong className="negative">{money(currencyTotals("expense","USD"),"USD")}</strong></div></div><div className="finance-layout"><section className="panel"><div className="panel-title"><h2>Cuentas</h2><button className="text-button" onClick={()=>openEditor("accounts")}>+ Agregar</button></div>{accounts.map(a=><div className="account-line" key={a.id}><div><strong>{String(a.name)}</strong><small>{String(a.currency)}</small></div><b>{money(Number(a.balanceMinor),String(a.currency))}</b><Actions onEdit={()=>openEditor("accounts",a)} onDelete={()=>void remove("accounts",a)}/></div>)}{accounts.length===0&&<Empty text="Creá una cuenta para registrar movimientos."/>}</section><section className="panel"><div className="panel-title"><h2>Últimos movimientos</h2></div>{transactions.map(t=><div className="list-line" key={t.id}><span className={"money-sign "+String(t.kind)}>{t.kind==="income"?"+":"−"}</span><div><strong>{String(t.category)}</strong><small>{String(t.description||t.accountName)} · {dateLabel(t.occurredAt)}</small></div><b className={t.kind==="income"?"positive":"negative"}>{money(Number(t.amountMinor),String(t.currency))}</b><Actions onEdit={()=>openEditor("transactions",t)} onDelete={()=>void remove("transactions",t)}/></div>)}{transactions.length===0&&<Empty text="No hay movimientos registrados."/>}</section></div></>}
      {section==="admin"&&isAdmin&&<><SectionIntro title="Administración" description="Aprobá o rechazá solicitudes de acceso al espacio."/><AdminUsers/></>}
      </>}
    </section>
    <div className="profile-menu-wrap" ref={profileMenuRef}>
      {profileMenuOpen&&<div className="profile-menu" id="serpix-profile-menu" role="group" aria-label="Menú de cuenta">
        <div className="profile-menu-heading"><strong>{name}</strong><small>{email}</small><span>{isAdmin?"Administrador":"Usuario"}</span></div>
        {isAdmin&&<button type="button" className="profile-menu-item" onClick={()=>{setSection("admin");setEditor(null);setProfileMenuOpen(false);window.scrollTo({top:0,behavior:"smooth"});}}><ShieldCheck size={17}/> Administración</button>}
        <div className="profile-menu-divider"/>
        <SignOutButton/>
      </div>}
      <button type="button" className="profile-avatar-button" aria-label="Abrir menú de cuenta" aria-controls="serpix-profile-menu" aria-expanded={profileMenuOpen} title="Cuenta" onClick={()=>setProfileMenuOpen(v=>!v)}>
        <span className="profile-avatar-fallback">{name.trim().slice(0,1).toUpperCase()}</span>
        {image&&<img src={image} alt="" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.style.display="none";}}/>}
      </button>
    </div>
    {editor&&<div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setEditor(null);}}><section className="editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title"><div className="panel-title"><div><p className="eyebrow">{editor.item?"EDITAR REGISTRO":"NUEVO REGISTRO"}</p><h2 id="editor-title">{editor.resource==="contacts"?"Contacto":editor.resource==="projects"?"Proyecto":editor.resource==="tasks"?"Tarea":editor.resource==="accounts"?"Cuenta":"Movimiento financiero"}</h2></div><button className="icon-button" onClick={()=>setEditor(null)} aria-label="Cerrar">×</button></div><div className="form-grid">{fields.map(f=><label className={f.type==="textarea"?"span-2":""} key={f.key}>{f.label}{f.type==="textarea"?<textarea required={f.required} value={values[f.key]||""} onChange={e=>setValues(v=>({...v,[f.key]:e.target.value}))}/>:f.type==="select"?<select required={f.required} value={values[f.key]||""} onChange={e=>setValues(v=>({...v,[f.key]:e.target.value}))}><option value="">— Seleccionar —</option>{(f.options||(f.key==="projectId"?projects.map(p=>({value:String(p.id),label:String(p.name)})):f.key==="contactId"?contacts.map(c=>({value:String(c.id),label:String(c.name)})):f.key==="accountId"?accounts.map(a=>({value:String(a.id),label:String(a.name)+" ("+String(a.currency)+")"})):[])).map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>:<input type={f.type||"text"} required={f.required} min={f.type==="number"?"0":undefined} step={f.type==="number"?"0.01":undefined} placeholder={f.placeholder} value={values[f.key]||""} onChange={e=>setValues(v=>({...v,[f.key]:e.target.value}))}/>}</label>)}</div><div className="modal-actions"><button className="secondary-button" onClick={()=>setEditor(null)}>Cancelar</button><button className="primary-button" disabled={saving} onClick={()=>void save()}>{saving?"Guardando…":"Guardar"}</button></div></section></div>}
  </main>;
}
function Stat({label,value,detail}:{label:string;value:number;detail:string}){return <div className="panel stat-card" title={detail}><small>{label}</small><strong>{value}</strong><span>{detail}</span></div>}
function Empty({text}:{text:string}){return <p className="empty-copy">{text}</p>}
function SectionIntro({title,description}:{title:string;description:string}){return <div className="section-intro" aria-label={title} title={description}/>;}
function Actions({onEdit,onDelete}:{onEdit:()=>void;onDelete:()=>void}){return <div className="row-actions"><button onClick={onEdit} aria-label="Editar" title="Editar">Editar</button><button onClick={onDelete} aria-label="Eliminar" title="Eliminar">Eliminar</button></div>}
