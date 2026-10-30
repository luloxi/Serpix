"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  Bell,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  FileText,
  Handshake,
  LayoutDashboard,
  Plus,
  Search,
  Settings2,
  TrendingUp,
  Users,
  Wallet,
  X,
} from "lucide-react";

type Relationship = "Cliente" | "Socio" | "Proveedor";
type Contact = {
  id: number;
  name: string;
  company: string;
  email: string;
  phone: string;
  kind: "Persona" | "Empresa";
  relationships: Relationship[];
  potential: boolean;
  initials: string;
  color: string;
};

const initialContacts: Contact[] = [
  { id: 1, name: "Martina López", company: "Estudio Norte", email: "martina@estudionorte.com", phone: "+54 9 11 4567-8901", kind: "Persona", relationships: ["Cliente"], potential: false, initials: "ML", color: "violet" },
  { id: 2, name: "Nicolás Ferrer", company: "Ferrer & Asociados", email: "nico@ferrer.com", phone: "+54 9 11 6123-4567", kind: "Persona", relationships: ["Socio", "Cliente"], potential: true, initials: "NF", color: "blue" },
  { id: 3, name: "Insumos Delta", company: "Insumos Delta SRL", email: "hola@insumosdelta.com.ar", phone: "+54 11 4321-7788", kind: "Empresa", relationships: ["Proveedor"], potential: false, initials: "ID", color: "orange" },
  { id: 4, name: "Lucía Benítez", company: "Independiente", email: "lucia@correo.com", phone: "+54 9 11 5890-1234", kind: "Persona", relationships: ["Cliente"], potential: true, initials: "LB", color: "green" },
];

const navItems = [
  { label: "Inicio", icon: LayoutDashboard },
  { label: "Contactos", icon: Users },
  { label: "Trabajo", icon: BriefcaseBusiness },
  { label: "Finanzas", icon: Wallet },
  { label: "Facturación", icon: FileText },
];

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

export default function Home() {
  const [section, setSection] = useState("Inicio");
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const [search, setSearch] = useState("");
  const [relationship, setRelationship] = useState("Todos");
  const [potential, setPotential] = useState("Todos");
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [kind, setKind] = useState<"Persona" | "Empresa">("Persona");
  const [relationships, setRelationships] = useState<Relationship[]>(["Cliente"]);
  const [isPotential, setIsPotential] = useState(true);

  const filteredContacts = useMemo(() => contacts.filter((contact) => {
    const query = search.toLowerCase();
    const matchesSearch = [contact.name, contact.company, contact.email].some((value) => value.toLowerCase().includes(query));
    const matchesRelationship = relationship === "Todos" || contact.relationships.includes(relationship as Relationship);
    const matchesPotential = potential === "Todos" || (potential === "Potenciales" ? contact.potential : !contact.potential);
    return matchesSearch && matchesRelationship && matchesPotential;
  }), [contacts, search, relationship, potential]);

  function toggleRelationship(value: Relationship) {
    setRelationships((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  function addContact(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || relationships.length === 0) return;
    const newContact: Contact = {
      id: Date.now(),
      name: name.trim(),
      company: company.trim() || (kind === "Persona" ? "Independiente" : "Sin razón social"),
      email: email.trim(),
      phone: phone.trim(),
      kind,
      relationships,
      potential: isPotential,
      initials: initials(name),
      color: "blue",
    };
    setContacts((current) => [newContact, ...current]);
    setName(""); setCompany(""); setEmail(""); setPhone("");
    setKind("Persona"); setRelationships(["Cliente"]); setIsPotential(true);
    setShowForm(false);
  }

  const isContacts = section === "Contactos";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setSection("Inicio"); }}>
          <span className="brand-mark">S</span>
          <span>serpix<span className="brand-dot">.</span></span>
        </a>
        <div className="workspace-label">ESPACIO DE TRABAJO</div>
        <nav className="main-nav" aria-label="Navegación principal">
          {navItems.map(({ label, icon: Icon }) => (
            <button key={label} className={section === label ? "nav-item active" : "nav-item"} onClick={() => setSection(label)}>
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
              {label === "Contactos" && <span className="nav-count">{contacts.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item"><Settings2 size={18} /><span>Preferencias</span></button>
          <div className="profile">
            <div className="avatar avatar-dark">LO</div>
            <div className="profile-copy"><strong>Mi espacio</strong><span>Cuenta personal</span></div>
            <ChevronDown size={15} />
          </div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">Mi espacio <span>/</span> {section}</div>
          <div className="top-actions">
            <span className="local-badge"><span /> Datos de ejemplo</span>
            <button className="icon-button" aria-label="Notificaciones"><Bell size={18} /></button>
            <button className="help-button"><CircleHelp size={17} /><span>Ayuda</span></button>
          </div>
        </header>

        <div className="content">
          {isContacts ? (
            <>
              <div className="page-heading">
                <div><div className="eyebrow">CRM</div><h1>Contactos</h1><p>Personas y organizaciones con las que trabajás.</p></div>
                <button className="primary-button" onClick={() => setShowForm(true)}><Plus size={17} /> Nuevo contacto</button>
              </div>
              <div className="contact-stats">
                <div className="stat-card"><span>Total de contactos</span><strong>{contacts.length}</strong><small>En tu agenda</small></div>
                <div className="stat-card"><span>Potenciales</span><strong>{contacts.filter((contact) => contact.potential).length}</strong><small>Oportunidades abiertas</small></div>
                <div className="stat-card"><span>Clientes</span><strong>{contacts.filter((contact) => contact.relationships.includes("Cliente")).length}</strong><small>Relaciones comerciales</small></div>
                <div className="stat-card"><span>Proveedores</span><strong>{contacts.filter((contact) => contact.relationships.includes("Proveedor")).length}</strong><small>Red de trabajo</small></div>
              </div>
              <div className="toolbar">
                <label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nombre, empresa o email..." /></label>
                <select aria-label="Filtrar por relación" value={relationship} onChange={(event) => setRelationship(event.target.value)}><option>Todos</option><option>Cliente</option><option>Socio</option><option>Proveedor</option></select>
                <select aria-label="Filtrar por potencial" value={potential} onChange={(event) => setPotential(event.target.value)}><option>Todos</option><option>Potenciales</option><option>No potenciales</option></select>
              </div>
              <div className="table-card">
                <div className="table-head"><div><strong>Tu agenda</strong><span>{filteredContacts.length} contactos</span></div><button className="subtle-button">Última actividad <ChevronDown size={14} /></button></div>
                <div className="contact-table-wrap">
                  <table className="contact-table">
                    <thead><tr><th>CONTACTO</th><th>RELACIÓN</th><th>ESTADO COMERCIAL</th><th>CONTACTO</th><th /></tr></thead>
                    <tbody>
                      {filteredContacts.map((contact) => (
                        <tr key={contact.id}>
                          <td><div className="contact-person"><div className={`avatar avatar-${contact.color}`}>{contact.initials}</div><div><strong>{contact.name}</strong><span>{contact.company}</span></div></div></td>
                          <td><div className="tag-list">{contact.relationships.map((item) => <span className={`relation-tag relation-${item.toLowerCase()}`} key={item}>{item}</span>)}</div></td>
                          <td><span className={contact.potential ? "status status-potential" : "status status-current"}><i />{contact.potential ? "Potencial" : "No potencial"}</span></td>
                          <td><div className="contact-details"><span>{contact.email || "Sin email"}</span><span>{contact.phone || "Sin teléfono"}</span></div></td>
                          <td><button className="row-action" aria-label={`Ver ${contact.name}`}><ArrowRight size={17} /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredContacts.length === 0 && <div className="empty-state"><Users size={24} /><strong>No encontramos contactos</strong><span>Probá cambiar los filtros o agregá uno nuevo.</span></div>}
                </div>
              </div>
              <p className="footnote">Una persona u organización puede tener más de una relación. El estado potencial se administra por separado.</p>
            </>
          ) : section === "Inicio" ? (
            <>
              <div className="page-heading"><div><div className="eyebrow">JUEVES · 29 OCTUBRE 2026</div><h1>Buen día.</h1><p>Esto es lo importante de tu actividad.</p></div><button className="primary-button" onClick={() => setShowForm(true)}><Plus size={17} /> Nuevo contacto</button></div>
              <div className="welcome-card"><div><span className="welcome-kicker">RESUMEN DEL NEGOCIO</span><h2>Todo en orden, paso a paso.</h2><p>Un lugar simple para llevar tus relaciones, trabajo y números.</p></div><div className="welcome-art"><Activity size={76} strokeWidth={1.1} /></div></div>
              <div className="overview-grid">
                <div className="overview-card"><div className="overview-label"><span>Contactos</span><Users size={18} /></div><strong>{contacts.length}</strong><small><span className="positive">+2</span> este mes</small></div>
                <div className="overview-card"><div className="overview-label"><span>Por cobrar</span><Wallet size={18} /></div><strong>$ 450.000</strong><small>2 comprobantes pendientes</small></div>
                <div className="overview-card"><div className="overview-label"><span>Ingresos del mes</span><TrendingUp size={18} /></div><strong>$ 1.280.000</strong><small>Pesos argentinos</small></div>
                <div className="overview-card"><div className="overview-label"><span>Tareas abiertas</span><Check size={18} /></div><strong>4</strong><small>2 para hoy</small></div>
              </div>
              <div className="dashboard-columns">
                <div className="panel-card"><div className="panel-title"><div><h3>Próximos pasos</h3><p>Pequeñas cosas que mueven el negocio.</p></div><button className="text-button">Ver trabajo <ArrowRight size={15} /></button></div><div className="task-row"><div className="task-icon task-violet"><CalendarDays size={18} /></div><div className="task-copy"><strong>Enviar propuesta comercial</strong><span>Estudio Norte · Hoy, 11:00</span></div><span className="priority">Hoy</span></div><div className="task-row"><div className="task-icon task-blue"><Clock3 size={18} /></div><div className="task-copy"><strong>Retomar conversación</strong><span>Lucía Benítez · Mañana</span></div><span className="priority priority-soft">Seguimiento</span></div><div className="task-row"><div className="task-icon task-orange"><ArrowDownLeft size={18} /></div><div className="task-copy"><strong>Factura pendiente de cobro</strong><span>Factura C-0002 · Vence el viernes</span></div><span className="priority priority-soft">Cobro</span></div></div>
                <div className="panel-card"><div className="panel-title"><div><h3>Actividad reciente</h3><p>Lo último que pasó.</p></div></div><div className="activity-row"><div className="activity-dot dot-green" /><div><strong>Contacto agregado</strong><span>Lucía Benítez · Hace 2 horas</span></div></div><div className="activity-row"><div className="activity-dot dot-blue" /><div><strong>Pago registrado</strong><span>$ 180.000 · Ayer</span></div></div><div className="activity-row"><div className="activity-dot dot-violet" /><div><strong>Proyecto actualizado</strong><span>Web institucional · Hace 2 días</span></div></div></div>
              </div>
            </>
          ) : (
            <div className="coming-soon"><div className="coming-icon"><BriefcaseBusiness size={25} /></div><div className="eyebrow">EN CONSTRUCCIÓN</div><h1>{section}</h1><p>Este módulo va a mantener el mismo criterio: lo esencial, bien resuelto y conectado con tus contactos.</p><button className="secondary-button" onClick={() => setSection("Inicio")}>Volver al inicio <ArrowRight size={16} /></button></div>
          )}
        </div>
      </section>

      {showForm && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowForm(false); }}><section className="contact-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-heading"><div><div className="eyebrow">CRM · NUEVO REGISTRO</div><h2 id="modal-title">Agregar contacto</h2><p>Guardá una persona u organización y definí cómo se relaciona con tu actividad.</p></div><button className="icon-button" onClick={() => setShowForm(false)} aria-label="Cerrar"><X size={19} /></button></div><form onSubmit={addContact}><div className="form-grid"><label className="field full"><span>Nombre o razón social *</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Ej. Martina López" /></label><label className="field"><span>Tipo de registro</span><select value={kind} onChange={(event) => setKind(event.target.value as "Persona" | "Empresa")}><option>Persona</option><option>Empresa</option></select></label><label className="field"><span>Empresa / actividad</span><input value={company} onChange={(event) => setCompany(event.target.value)} placeholder="Ej. Estudio Norte" /></label><label className="field"><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="nombre@empresa.com" /></label><label className="field"><span>Teléfono</span><input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+54 9 ..." /></label></div><div className="field"><span>Tipo de relación *</span><div className="choice-row">{(["Cliente", "Socio", "Proveedor"] as Relationship[]).map((item) => <label className={relationships.includes(item) ? "choice selected" : "choice"} key={item}><input type="checkbox" checked={relationships.includes(item)} onChange={() => toggleRelationship(item)} />{item}</label>)}</div><small className="field-hint">Podés seleccionar más de una. No hace falta crear el contacto dos veces.</small></div><div className="potential-toggle"><div><strong>¿Es un contacto potencial?</strong><span>Marcá si existe una oportunidad comercial por desarrollar.</span></div><button type="button" className={isPotential ? "switch on" : "switch"} role="switch" aria-checked={isPotential} onClick={() => setIsPotential(!isPotential)}><i /></button></div><div className="modal-footer"><button type="button" className="secondary-button" onClick={() => setShowForm(false)}>Cancelar</button><button type="submit" className="primary-button" disabled={relationships.length === 0}><Plus size={16} /> Guardar contacto</button></div></form></section></div>}
    </main>
  );
}
