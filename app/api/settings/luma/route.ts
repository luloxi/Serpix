import { clearLumaLink, EMPTY_LUMA_SETTINGS, readLumaSettings, saveLumaLink } from "@/lib/luma-settings";
import { lumaJson, openLumaSettings } from "./gate.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  const opened = await openLumaSettings();
  if ("error" in opened) return opened.error;
  if ("missing" in opened) return lumaJson(EMPTY_LUMA_SETTINGS);
  return lumaJson(await readLumaSettings(opened.ctx.db, opened.ctx.userId, opened.ctx.env));
}

export async function PUT(request: Request) {
  const opened = await openLumaSettings();
  if ("error" in opened) return opened.error;
  if ("missing" in opened) return lumaJson({ error: "No disponible" }, 400);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return lumaJson({ error: "JSON inválido" }, 400);
  }
  const url = body && typeof body === "object" && "url" in body ? (body as { url?: unknown }).url : undefined;
  const saved = await saveLumaLink(opened.ctx.db, opened.ctx.userId, url, opened.ctx.env);
  if (!saved.ok) return lumaJson({ error: saved.error }, saved.status);
  return lumaJson(saved.view);
}

export async function DELETE() {
  const opened = await openLumaSettings();
  if ("error" in opened) return opened.error;
  if ("missing" in opened) return lumaJson({ error: "No disponible" }, 400);
  return lumaJson(await clearLumaLink(opened.ctx.db, opened.ctx.userId, opened.ctx.env));
}
