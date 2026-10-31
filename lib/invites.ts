import type { D1Bound, D1Like } from "./finance.ts";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CODE_BYTES = 32;

export type InviteStatus = "pending" | "used" | "expired" | "revoked";
export type RedeemStatus = "ok" | "already_approved" | "invalid" | "expired" | "used" | "revoked" | "full" | "rejected";

export type InvitePublic = {
  id: string;
  status: InviteStatus;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
  note: string | null;
};

type InviteRow = {
  id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  note: string | null;
};

const CLAIM_SQL = "UPDATE invites SET used_at=?, used_by=? WHERE code_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND (SELECT COUNT(*) FROM user WHERE approvalStatus='approved') < (SELECT CAST(value AS INTEGER) FROM app_settings WHERE key='max_users')";
const APPROVE_SQL = "UPDATE user SET approvalStatus='approved', updatedAt=? WHERE id=? AND approvalStatus='pending' AND EXISTS (SELECT 1 FROM invites WHERE code_hash=? AND used_by=? AND used_at=?)";

function changes(result: { meta?: { changes?: number } } | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

export function inviteStatus(row: { used_at: number | null; revoked_at: number | null; expires_at: number }, now: number): InviteStatus {
  if (row.revoked_at != null) return "revoked";
  if (row.used_at != null) return "used";
  if (row.expires_at <= now) return "expired";
  return "pending";
}

function encodeCode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function hashInviteCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function generateInvite(db: D1Like, adminId: string, now: number, note?: string): Promise<{ code: string; expiresAt: number; id: string }> {
  const bytes = new Uint8Array(CODE_BYTES);
  crypto.getRandomValues(bytes);
  const code = encodeCode(bytes);
  const id = crypto.randomUUID();
  const codeHash = await hashInviteCode(code);
  const expiresAt = now + INVITE_TTL_MS;
  const clean = typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : null;
  await db.prepare("INSERT INTO invites (id, code_hash, created_by, created_at, expires_at, note) VALUES (?,?,?,?,?,?)")
    .bind(id, codeHash, adminId, now, expiresAt, clean).run();
  return { code, expiresAt, id };
}

function publish(row: InviteRow, now: number): InvitePublic {
  return {
    id: row.id,
    status: inviteStatus(row, now),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    note: row.note,
  };
}

export async function listInvites(db: D1Like, now = Date.now()): Promise<InvitePublic[]> {
  const result = await db.prepare("SELECT id, created_at, expires_at, used_at, revoked_at, note FROM invites ORDER BY created_at DESC").bind().all<InviteRow>();
  return (result.results ?? []).map((row) => publish(row, now));
}

/** Revokes a still-unused invite. False when it is missing, already used, or already revoked. */
export async function revokeInvite(db: D1Like, id: string, now: number): Promise<boolean> {
  const result = await db.prepare("UPDATE invites SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL").bind(now, id).run();
  return changes(result) === 1;
}

async function diagnose(db: D1Like, codeHash: string, now: number): Promise<RedeemStatus> {
  const row = await db.prepare("SELECT used_at, revoked_at, expires_at FROM invites WHERE code_hash=?").bind(codeHash).first<{ used_at: number | null; revoked_at: number | null; expires_at: number }>();
  if (!row) return "invalid";
  if (row.revoked_at != null) return "revoked";
  if (row.used_at != null) return "used";
  if (row.expires_at <= now) return "expired";
  return "full";
}

export async function redeemInvite(db: D1Like, userId: string, code: string, now: number): Promise<{ status: RedeemStatus }> {
  const user = await db.prepare("SELECT approvalStatus FROM user WHERE id=?").bind(userId).first<{ approvalStatus: string }>();
  if (!user) return { status: "invalid" };
  if (user.approvalStatus === "approved") return { status: "already_approved" };
  if (user.approvalStatus !== "pending") return { status: "rejected" };
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) return { status: "invalid" };

  if (typeof db.batch !== "function") throw new Error("batch required");
  const codeHash = await hashInviteCode(code);
  const claim: D1Bound = db.prepare(CLAIM_SQL).bind(now, userId, codeHash, now);
  const approve: D1Bound = db.prepare(APPROVE_SQL).bind(now, userId, codeHash, userId, now);
  const results = await db.batch([claim, approve]);
  const claimed = changes(results[0]) === 1;
  const approved = changes(results[1]) === 1;
  if (claimed && approved) return { status: "ok" };
  if (!claimed) return { status: await diagnose(db, codeHash, now) };

  await db.prepare("UPDATE invites SET used_at=NULL, used_by=NULL WHERE code_hash=? AND used_by=? AND used_at=?").bind(codeHash, userId, now).run();
  const again = await db.prepare("SELECT approvalStatus FROM user WHERE id=?").bind(userId).first<{ approvalStatus: string }>();
  if (again?.approvalStatus === "approved") return { status: "already_approved" };
  if (again?.approvalStatus === "rejected") return { status: "rejected" };
  return { status: "invalid" };
}
