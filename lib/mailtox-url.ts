/** Compose link in Mailtox for an address (replaces mailto: links so mail is written in Mailtox). */
export const MAILTOX_ORIGIN = "https://mailtox.lulox.com.ar";
export function mailtoxComposeUrl(email: string, extra?: { subject?: string }): string {
  const q = "to=" + encodeURIComponent(email.trim()) + (extra?.subject ? "&subject=" + encodeURIComponent(extra.subject) : "");
  return MAILTOX_ORIGIN + "/compose?" + q;
}
