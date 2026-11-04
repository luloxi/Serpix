/** Compose link in Malito for an address (replaces mailto: links so mail is written in Malito). */
export const MALITO_ORIGIN = "https://malito.lulox.com.ar";
export function malitoComposeUrl(email: string, extra?: { subject?: string }): string {
  const q = "to=" + encodeURIComponent(email.trim()) + (extra?.subject ? "&subject=" + encodeURIComponent(extra.subject) : "");
  return MALITO_ORIGIN + "/compose?" + q;
}
