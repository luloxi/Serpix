// Public landing copy. Spanish is the default. Every claim is a feature that exists today:
// contactos (CRM), agenda (tareas, eventos, notas), cuentas y movimientos en ARS/USD,
// registro de tiempo, presupuestos y facturas en PDF, fotos de tickets, gastos recurrentes.
// No prices, no checkout, no encryption claim (that is not live).

export const LANDING_LANG_STORAGE_KEY = "serpix-lang";

export type LandingLang = "es" | "en";

export type LandingCopy = {
  title: string;
  description: string;
  inviteOnly: string;
  enter: string;
  inviteNote: string;
  featuresLabel: string;
  features: readonly string[];
  limitsTitle: string;
  limits: readonly string[];
  license: string;
  madeBy: string;
  langButton: string;
  langLabel: string;
};

export const landingCopy: { es: LandingCopy; en: LandingCopy } = {
  es: {
    title: "Serpix",
    description: "Una herramienta gratis que Luciano armó para él y sus amigos.",
    inviteOnly: "Es gratis y solo se entra por invitación.",
    enter: "Entrar con Google",
    inviteNote: "Si tenés una invitación, abrí el link que te pasaron.",
    featuresLabel: "Qué incluye",
    features: [
      "Contactos (CRM)",
      "Agenda: tareas, eventos y notas",
      "Cuentas y movimientos en ARS y USD",
      "Registro de tiempo",
      "Presupuestos y facturas en PDF",
      "Fotos de tickets",
      "Gastos recurrentes",
    ],
    limitsTitle: "Lo que Serpix no es",
    limits: [
      "Los PDF son un comprobante interno, no es factura ARCA.",
      "No procesa pagos.",
      "No publica un tarifario.",
    ],
    license: "Código abierto (AGPL-3.0)",
    madeBy: "Hecho por Luciano",
    langButton: "EN",
    langLabel: "Cambiar a inglés",
  },
  en: {
    title: "Serpix",
    description: "A free tool Luciano built for himself and his friends.",
    inviteOnly: "It is free and entry is by invitation only.",
    enter: "Sign in with Google",
    inviteNote: "If you have an invitation, open the link you were sent.",
    featuresLabel: "What it includes",
    features: [
      "Contacts (CRM)",
      "Agenda: tasks, events and notes",
      "Accounts and movements in ARS and USD",
      "Time tracking",
      "Quotes and invoices as PDF",
      "Ticket photos",
      "Recurring expenses",
    ],
    limitsTitle: "What Serpix is not",
    limits: [
      "PDFs are an internal receipt, not an ARCA invoice.",
      "It does not process payments.",
      "It does not publish a rate card.",
    ],
    license: "Open source (AGPL-3.0)",
    madeBy: "Made by Luciano",
    langButton: "ES",
    langLabel: "Switch to Spanish",
  },
};
