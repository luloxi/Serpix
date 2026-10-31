import test from "node:test";
import assert from "node:assert/strict";
import { homeQuery, homeTarget, landingLang } from "../lib/home.ts";
import { LANDING_LANG_STORAGE_KEY, landingCopy } from "../lib/landing-copy.ts";

test("signed-out plain / is the landing", () => {
  assert.deepEqual(homeTarget({ session: null, approvalStatus: null, query: "" }), { kind: "landing" });
  assert.deepEqual(homeTarget({ session: false, approvalStatus: null, query: "" }), { kind: "landing" });
  assert.deepEqual(homeTarget({ session: undefined, approvalStatus: undefined, query: undefined }), { kind: "landing" });
  assert.deepEqual(homeTarget({ session: null, approvalStatus: null, query: "?" }), { kind: "landing" });
});

test("signed-out with a query goes to login and keeps next", () => {
  assert.deepEqual(
    homeTarget({ session: null, approvalStatus: null, query: "?section=contacts" }),
    { redirect: "/login?next=%2F%3Fsection%3Dcontacts" },
  );
  assert.deepEqual(
    homeTarget({ session: false, approvalStatus: null, query: "?section=finance" }),
    { redirect: "/login?next=" + encodeURIComponent("/?section=finance") },
  );
  const query = homeQuery({ section: "contacts", s: "activity" });
  assert.deepEqual(
    homeTarget({ session: null, approvalStatus: null, query }),
    { redirect: "/login?next=" + encodeURIComponent("/" + query) },
  );
});

test("signed-in approved goes to /dashboard plus the query", () => {
  assert.deepEqual(homeTarget({ session: true, approvalStatus: "approved", query: "" }), { redirect: "/dashboard" });
  assert.deepEqual(
    homeTarget({ session: { user: { id: "u" } }, approvalStatus: "approved", query: "?section=finance" }),
    { redirect: "/dashboard?section=finance" },
  );
  assert.deepEqual(
    homeTarget({ session: true, approvalStatus: "approved", query: "?section=contacts&lang=en" }),
    { redirect: "/dashboard?section=contacts&lang=en" },
  );
  assert.deepEqual(homeTarget({ session: true, approvalStatus: "approved", query: homeQuery({}) }), { redirect: "/dashboard" });
});

test("pending and rejected go to /pending and drop the query", () => {
  assert.deepEqual(homeTarget({ session: true, approvalStatus: "pending", query: "?section=contacts" }), { redirect: "/pending" });
  assert.deepEqual(homeTarget({ session: true, approvalStatus: "rejected", query: "" }), { redirect: "/pending" });
  assert.deepEqual(homeTarget({ session: true, approvalStatus: "rejected", query: "?section=finance" }), { redirect: "/pending" });
  assert.deepEqual(homeTarget({ session: true, approvalStatus: null, query: "?a=1" }), { redirect: "/pending" });
});

test("lang alone stays on the landing; any other key still logs in", () => {
  assert.deepEqual(homeTarget({ session: null, approvalStatus: null, query: "?lang=en" }), { kind: "landing" });
  assert.deepEqual(homeTarget({ session: null, approvalStatus: null, query: "?lang=es" }), { kind: "landing" });
  assert.deepEqual(
    homeTarget({ session: null, approvalStatus: null, query: "?lang=en&section=finance" }),
    { redirect: "/login?next=" + encodeURIComponent("/?lang=en&section=finance") },
  );
});

test("homeQuery matches the previous search suffix and landingLang reads ?lang=en", () => {
  assert.equal(homeQuery({}), "");
  assert.equal(homeQuery({ section: "contacts" }), "?section=contacts");
  assert.equal(homeQuery({ section: ["a", "b"] }), "?section=a&section=b");
  assert.equal(homeQuery({ section: undefined, lang: "en" }), "?lang=en");
  assert.equal(landingLang({}), "es");
  assert.equal(landingLang({ lang: "en" }), "en");
  assert.equal(landingLang({ lang: "es" }), "es");
  assert.equal(landingLang({ lang: "EN" }), "es");
  assert.equal(landingLang({ lang: ["en", "es"] }), "en");
  assert.equal(LANDING_LANG_STORAGE_KEY, "serpix-lang");
});

test("Spanish and English landing copy share a shape and avoid the blocked words", () => {
  assert.deepEqual(Object.keys(landingCopy.es).sort(), Object.keys(landingCopy.en).sort());
  assert.equal(sameShape(landingCopy.es, landingCopy.en), true);
  // Phase D will ship end-to-end encryption and should update this pattern.
  // Until then the landing must not claim encryption (or the other words below).
  const blocked = /precio|price|checkout|waitlist|lista de espera|Mercado Pago|inhackeable|unhackable|cifrad|encrypt/i;
  const strings: string[] = [];
  collect(landingCopy, strings);
  assert.ok(strings.length > 10);
  for (const text of strings) assert.equal(blocked.test(text), false, text);
  assert.equal(landingCopy.es.enter, "Entrar con Google");
  assert.equal(landingCopy.es.inviteNote, "Si tenés una invitación, abrí el link que te pasaron.");
  assert.equal(landingCopy.es.inviteOnly, "Es gratis y solo se entra por invitación.");
  assert.equal(landingCopy.es.limitsTitle, "Lo que Serpix no es");
  assert.match(landingCopy.es.limits.join(" "), /comprobante interno, no es factura ARCA/);
  assert.equal(landingCopy.es.license, "Código abierto (AGPL-3.0)");
  assert.equal(landingCopy.es.madeBy, "Hecho por Luciano");
  assert.equal(landingCopy.es.langButton, "EN");
  assert.equal(landingCopy.en.langButton, "ES");
});

function sameShape(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameShape(item, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length || ak.some((key, i) => key !== bk[i])) return false;
    return ak.every((key) => sameShape((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return typeof a === typeof b;
}

function collect(value: unknown, out: string[]) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collect(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collect(item, out);
}
