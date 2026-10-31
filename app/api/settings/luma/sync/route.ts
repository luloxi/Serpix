import { syncLumaSettings } from "@/lib/luma-settings";
import { lumaJson, openLumaSettings } from "../gate.ts";

export const dynamic = "force-dynamic";

export async function POST() {
  const opened = await openLumaSettings();
  if ("error" in opened) return opened.error;
  if ("missing" in opened) return lumaJson({ error: "No disponible" }, 400);
  const result = await syncLumaSettings(opened.ctx.db, opened.ctx.userId, opened.ctx.email, opened.ctx.env, { rateLimit: true, fetchImpl: fetch });
  if (result.status !== 200) return lumaJson({ error: result.error ?? "No se pudo sincronizar" }, result.status);
  return lumaJson(result.view);
}
