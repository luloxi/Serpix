import { NextResponse } from "next/server";
import { approvedContext } from "@/lib/session";
import { lumaOwnerAllowed, lumaSettingsTable } from "@/lib/luma-settings";

export const noStore = { "Cache-Control": "no-store" };

type Approved = NonNullable<Awaited<ReturnType<typeof approvedContext>>>;

export function lumaJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

/** Approved admin, and the MCP owner when that email is configured. 401 without a session, 403 otherwise. */
export async function openLumaSettings(): Promise<{ ctx: Approved } | { error: Response } | { missing: true }> {
  const ctx = await approvedContext();
  if (!ctx) return { error: lumaJson({ error: "Unauthorized" }, 401) };
  if (ctx.role !== "admin") return { error: lumaJson({ error: "Forbidden" }, 403) };
  if (!(await lumaSettingsTable(ctx.db))) return { missing: true };
  if (!(await lumaOwnerAllowed(ctx.db, ctx.userId, ctx.env.MCP_OWNER_EMAIL))) return { error: lumaJson({ error: "Forbidden" }, 403) };
  return { ctx };
}
