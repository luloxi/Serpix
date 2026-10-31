// Where `/` sends this request. Pure: no Next.js, no headers, so node:test can call it.
// Signed-in behaviour matches the previous page exactly (dashboard keeps the query; anyone
// not approved goes to /pending). Signed-out `/` with an empty query is the public landing.
// A non-empty query is an old bookmark (`/?section=contacts`) and still goes to
// `/login?next=…`. `lang` alone is the landing's own switch (`?lang=en`), not an app deep link.

export type HomeSearchParams = { [key: string]: string | string[] | undefined };

export type HomeTarget = { kind: "landing" } | { redirect: string };

export type HomeTargetInput = {
  /** Truthy when a session exists. The object itself is enough; approval is separate. */
  session: unknown;
  approvalStatus?: string | null;
  /** `""` or a search suffix such as `"?section=finance"`. A missing `?` is added. */
  query?: string | null;
};

/** Same suffix the old home page built: `""` or `"?a=b"`, with repeated keys kept. */
export function homeQuery(searchParams: HomeSearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") params.append(key, value);
    else if (Array.isArray(value)) for (const item of value) params.append(key, item);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** `?lang=en` on the landing. Anything else stays Spanish, including a missing param. */
export function landingLang(searchParams: HomeSearchParams): "es" | "en" {
  const value = searchParams.lang;
  const lang = typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
  return lang === "en" ? "en" : "es";
}

function querySuffix(query: string | null | undefined): string {
  if (!query) return "";
  const raw = query.startsWith("?") ? query.slice(1) : query;
  if (!raw) return "";
  return query.startsWith("?") ? query : "?" + raw;
}

/** True when the query carries an app deep link, not only the landing language switch. */
function hasAppQuery(suffix: string): boolean {
  if (!suffix) return false;
  const raw = suffix.startsWith("?") ? suffix.slice(1) : suffix;
  if (!raw) return false;
  const keys = [...new URLSearchParams(raw).keys()];
  if (keys.length === 0) return true;
  return keys.some((key) => key !== "lang");
}

export function homeTarget({ session, approvalStatus, query }: HomeTargetInput): HomeTarget {
  const suffix = querySuffix(query);
  if (session) {
    if (approvalStatus !== "approved") return { redirect: "/pending" };
    return { redirect: "/dashboard" + suffix };
  }
  if (hasAppQuery(suffix)) return { redirect: "/login?next=" + encodeURIComponent("/" + suffix) };
  return { kind: "landing" };
}
