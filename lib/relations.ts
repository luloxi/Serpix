export type RelationKey = "client" | "partner" | "supplier";
export type RelationState = "potential" | "confirmed";
export type Relations = Partial<Record<RelationKey, RelationState>>;

export const RELATION_KEYS: RelationKey[] = ["client", "partner", "supplier"];
export const RELATION_LABEL: Record<RelationKey, string> = { client: "Cliente", partner: "Socio", supplier: "Proveedor" };

const LEGACY: Record<string, Relations> = {
  client: { client: "confirmed" },
  client_potential: { client: "potential" },
  partner: { partner: "confirmed" },
  partner_potential: { partner: "potential" },
  supplier: { supplier: "confirmed" },
  potential: {}, // legacy default "Prospecto": no relationship asserted
};

/** Keep only known keys and states. */
export function sanitizeRelations(input: unknown): Relations {
  const out: Relations = {};
  if (input && typeof input === "object") {
    for (const k of RELATION_KEYS) {
      const v = (input as Record<string, unknown>)[k];
      if (v === "potential" || v === "confirmed") out[k] = v;
    }
  }
  return out;
}

/** Read the stored relations JSON; if null/invalid, derive from the legacy role. */
export function contactRelations(relationsRaw: unknown, role: unknown): Relations {
  if (typeof relationsRaw === "string" && relationsRaw) {
    try { return sanitizeRelations(JSON.parse(relationsRaw)); } catch { /* fall through to legacy */ }
  }
  return { ...(LEGACY[String(role)] ?? {}) };
}

/** Keep the old single `role` column coherent for anything that still reads it. */
export function legacyRole(r: Relations): "client" | "client_potential" | "partner" | "partner_potential" | "supplier" | "potential" {
  if (r.client) return r.client === "confirmed" ? "client" : "client_potential";
  if (r.partner) return r.partner === "confirmed" ? "partner" : "partner_potential";
  if (r.supplier) return "supplier";
  return "potential";
}
