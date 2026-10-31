// Browser stand-in for @/lib/session. Route handlers keep their calls; the database is the local one.
// This file must not import the engine (that would put the engine in the initial client bundle).
import { NextResponse } from "next/server";
import { boundEngineSession } from "../ambient.ts";

export const E2E_SESSION_SHIM = "serpix-e2e-session-shim";

const markerRoot = globalThis as { __serpixE2E?: string[] };
markerRoot.__serpixE2E ??= [];
markerRoot.__serpixE2E.push(E2E_SESSION_SHIM);

export const ENCRYPTED_ACCOUNT_ERROR = "Cuenta cifrada: usá el modo cifrado de la app.";

function local() {
  const session = boundEngineSession();
  if (!session) return null;
  return {
    userId: session.userId,
    db: session.db,
    env: session.env,
    name: session.name ?? "",
    email: session.email ?? "",
    role: session.role || "user",
    approvalStatus: session.approvalStatus ?? "approved",
  };
}

export async function sessionContext() {
  return local();
}

export async function approvedContext() {
  const ctx = local();
  if (!ctx || ctx.approvalStatus !== "approved") return null;
  return ctx;
}

/** The local database is already plaintext. There is no encryption_mode column to consult. */
export async function legacyDataContext() {
  return approvedContext();
}

export async function adminContext() {
  const ctx = await approvedContext();
  if (!ctx || ctx.role !== "admin") return null;
  return ctx;
}

export function encryptedAccount() {
  return NextResponse.json({ error: ENCRYPTED_ACCOUNT_ERROR }, { status: 403, headers: { "Cache-Control": "no-store" } });
}

/** Same message as the server triggers. The local database does not install those triggers. */
export const E2E_PLAINTEXT_WRITE = "e2e_account_plaintext_write";

export function isE2ePlaintextWrite(error: unknown): boolean {
  const message = error instanceof Error ? error.message + " " + String(error.cause ?? "") : String(error);
  return message.includes(E2E_PLAINTEXT_WRITE);
}

export function encryptedWriteResponse(error: unknown) {
  return isE2ePlaintextWrite(error) ? encryptedAccount() : null;
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
