export type AvatarSource = "x" | "telegram" | "github" | "linkedin" | "email";

const RULES: Record<Exclude<AvatarSource, "email">, { hosts: RegExp; pathPrefix?: string; valid: RegExp; provider: string }> = {
  x: { hosts: /^(www\.)?(x|twitter)\.com$/i, valid: /^[A-Za-z0-9_]{1,30}$/, provider: "x" },
  telegram: { hosts: /^(www\.)?(t\.me|telegram\.me)$/i, valid: /^[A-Za-z0-9_]{3,64}$/, provider: "telegram" },
  github: { hosts: /^(www\.)?github\.com$/i, valid: /^[A-Za-z0-9-]{1,39}$/, provider: "github" },
  linkedin: { hosts: /^(www\.)?linkedin\.com$/i, pathPrefix: "in", valid: /^[A-Za-z0-9\-_.%]{3,100}$/, provider: "linkedin" },
};

/** "@user", "user" or a profile URL -> the bare handle, or null when it does not look like one. */
export function handleOf(source: Exclude<AvatarSource, "email">, raw: string | undefined): string | null {
  const v = (raw || "").trim();
  if (!v) return null;
  const rule = RULES[source];
  let candidate = v.replace(/^@/, "");
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (!rule.hosts.test(u.hostname)) return null;
      const parts = u.pathname.split("/").filter(Boolean);
      candidate = rule.pathPrefix ? (parts[0] === rule.pathPrefix ? parts[1] : "") : parts[0];
    } catch { return null; }
  }
  candidate = (candidate || "").replace(/\/$/, "");
  return rule.valid.test(candidate) ? candidate : null;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Public, key-less URL for the profile photo of a source. Returns null if there is nothing to look up. */
export async function avatarUrl(source: AvatarSource, value: string | undefined): Promise<string | null> {
  if (source === "email") {
    const email = (value || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
    return `https://gravatar.com/avatar/${await sha256Hex(email)}?d=404&s=256`;
  }
  const handle = handleOf(source, value);
  return handle ? `https://unavatar.io/${RULES[source].provider}/${encodeURIComponent(handle)}?fallback=false` : null;
}

/** Center-crop to a square, resize to 256px and encode as a small WebP data URL (a few KB). */
export async function toSmallWebp(blob: Blob, size = 256): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Sin soporte de imagen");
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close?.();
  for (const q of [0.82, 0.7, 0.55, 0.4]) {
    const out: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/webp", q));
    if (out && out.type === "image/webp" && out.size <= 48000) {
      return await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsDataURL(out); });
    }
  }
  throw new Error("La imagen es demasiado pesada");
}

/** Download a source photo (CORS) and return it as a small WebP data URL; throws if the source has no photo. */
export async function fetchAvatar(source: AvatarSource, value: string | undefined): Promise<string> {
  const url = await avatarUrl(source, value);
  if (!url) throw new Error("Falta un usuario o email válido");
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(res.status === 429 ? "Límite diario del servicio de fotos, probá mañana" : "No hay foto pública para este perfil");
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error("No hay foto pública para este perfil");
  return toSmallWebp(blob);
}
