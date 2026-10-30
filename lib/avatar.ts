const AVATAR_RE = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/;
export const AVATAR_SOURCES = ["x", "telegram", "github", "linkedin", "email", "custom"] as const;
export type AvatarChange = undefined | null | { data: string; source: string };

/** undefined = leave the avatar untouched; null = clear it; otherwise a validated data URL + source. */
export function avatarChange(body: Record<string, unknown>): AvatarChange {
  if (!("avatarData" in body)) return undefined;
  if (!body.avatarData) return null;
  const data = typeof body.avatarData === "string" ? body.avatarData : "";
  if (data.length > 90000 || !AVATAR_RE.test(data)) return undefined;
  const source = (AVATAR_SOURCES as readonly string[]).includes(String(body.avatarSource)) ? String(body.avatarSource) : "custom";
  return { data, source };
}
