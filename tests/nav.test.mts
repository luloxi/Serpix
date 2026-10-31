import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NAV, parseNav, buildSearch, buildUrl, sameNav, safeNext,
  layerOf, pushScreen, refine, openLayer, closeLayer,
  type NavState, type HistoryLike, type Layer,
} from "../lib/nav.ts";

const ORIGIN = "https://erp.example";

function nav(patch: Partial<NavState>): NavState {
  return { ...DEFAULT_NAV, ...patch };
}

test("home is an empty search and buildUrl is /dashboard", () => {
  assert.equal(buildSearch(DEFAULT_NAV), "");
  assert.equal(buildUrl(DEFAULT_NAV), "/dashboard");
  assert.deepEqual(parseNav(""), DEFAULT_NAV);
  assert.deepEqual(parseNav("?"), DEFAULT_NAV);
});

test("round trip parse(build(x)) for many screens, defaults omitted", () => {
  const states: NavState[] = [
    DEFAULT_NAV,
    nav({ section: "contacts" }),
    nav({ section: "contacts", contactsView: "inquiries" }),
    nav({ section: "contacts", contactsView: "inquiries", inquiryId: "inq_1" }),
    nav({ section: "contacts", role: "client", relState: "potential" }),
    nav({ section: "contacts", role: "none", contactId: "c-1" }),
    nav({ section: "contacts", role: "supplier", relState: "confirmed", contactId: "Ab_9" }),
    nav({ section: "activity" }),
    nav({ section: "activity", agendaTab: "calendar", month: "2026-10", day: "2026-10-30" }),
    nav({ section: "activity", agendaTab: "list", agendaKind: "note" }),
    nav({ section: "activity", agendaTab: "list", agendaKind: "task", noteId: "note1" }),
    nav({ section: "activity", agendaKind: "event", month: "2024-02", day: "2024-02-29" }),
    nav({ section: "activity", edit: { resource: "tasks", id: "t1" } }),
    nav({ section: "activity", edit: { resource: "activities", id: "a_1" } }),
    nav({ section: "contacts", edit: { resource: "contacts", id: "c1" } }),
    nav({ section: "finance" }),
    nav({ section: "finance", edit: { resource: "accounts", id: "acc" } }),
    nav({ section: "finance", edit: { resource: "transactions", id: "tx-9" } }),
    nav({ section: "admin" }),
  ];
  for (const state of states) {
    const search = buildSearch(state);
    assert.deepEqual(parseNav(search), state, search);
    assert.equal(parseNav(buildSearch(parseNav(search))).section, state.section);
  }
  assert.equal(buildSearch(nav({ section: "contacts" })), "?s=contacts");
  assert.equal(buildSearch(nav({ section: "contacts", contactsView: "inquiries", inquiryId: "abc" })), "?s=contacts&v=solicitudes&i=abc");
  assert.equal(buildSearch(nav({ section: "contacts", role: "client", relState: "confirmed", contactId: "c1" })), "?s=contacts&r=client&e=confirmed&c=c1");
  assert.equal(buildSearch(nav({ section: "activity", agendaTab: "calendar", month: "2026-10", day: "2026-10-31" })), "?s=activity&t=calendar&m=2026-10&d=2026-10-31");
  assert.equal(buildSearch(nav({ section: "activity", agendaTab: "list", agendaKind: "task" })), "?s=activity&t=list&k=task");
  assert.equal(buildSearch(nav({ section: "activity", noteId: "n1" })), "?s=activity&n=n1");
  assert.equal(buildSearch(nav({ section: "finance", edit: { resource: "accounts", id: "a1" } })), "?s=finance&edit=accounts%3Aa1");
  assert.equal(buildUrl(nav({ section: "admin" })), "/dashboard?s=admin");
  // General tab, "all" kind, "any" state and "list" view are defaults: not in the URL.
  assert.equal(buildSearch(nav({ section: "activity", agendaTab: "general", agendaKind: "all" })), "?s=activity");
  assert.equal(buildSearch(nav({ section: "contacts", contactsView: "list", role: "all", relState: "any" })), "?s=contacts");
});

test("invalid values and out-of-section params fall back to defaults", () => {
  assert.deepEqual(parseNav("?s=nope"), DEFAULT_NAV);
  assert.deepEqual(parseNav("?s=home"), DEFAULT_NAV);
  assert.deepEqual(parseNav("?s=contacts&v=list&r=friend&e=maybe&c=../x&i="), nav({ section: "contacts" }));
  assert.deepEqual(parseNav("?s=contacts&c=" + "a".repeat(65)), nav({ section: "contacts" }));
  assert.deepEqual(parseNav("?s=contacts&c=ok.id"), nav({ section: "contacts" }));
  assert.deepEqual(parseNav("?s=contacts&i=bad%20id"), nav({ section: "contacts" }));
  assert.deepEqual(parseNav("?s=activity&t=grid&k=call&m=2026-13&m=2026-00&d=2026-02-31&n="), nav({ section: "activity" }));
  assert.deepEqual(parseNav("?s=activity&m=2026-1&d=2026-10-1"), nav({ section: "activity" }));
  assert.deepEqual(parseNav("?s=activity&d=2025-02-29"), nav({ section: "activity" }));
  assert.deepEqual(parseNav("?s=activity&d=1900-02-29"), nav({ section: "activity" }));
  assert.equal(parseNav("?s=activity&d=2024-02-29").day, "2024-02-29");
  assert.equal(parseNav("?s=activity&d=2000-02-29").day, "2000-02-29");
  assert.equal(parseNav("?s=activity&m=2026-10").month, "2026-10");
  assert.equal(parseNav("?s=activity&edit=tasks:").edit, null);
  assert.equal(parseNav("?s=activity&edit=:abc").edit, null);
  assert.equal(parseNav("?s=activity&edit=nope:abc").edit, null);
  assert.equal(parseNav("?s=activity&edit=projects:abc").edit, null);
  assert.equal(parseNav("?s=home&edit=tasks:abc").edit, null);

  // Params only apply inside their section.
  assert.deepEqual(
    parseNav("?r=client&e=potential&v=solicitudes&c=abc&i=iii&t=list&k=note&m=2026-10&d=2026-10-30&n=note1&edit=tasks:t1"),
    DEFAULT_NAV,
  );
  assert.deepEqual(
    parseNav("?s=finance&r=client&c=abc&t=list&n=note1&edit=contacts:c1"),
    nav({ section: "finance" }),
  );
  assert.deepEqual(
    parseNav("?s=contacts&t=calendar&m=2026-10&n=note1&k=task&edit=tasks:t1"),
    nav({ section: "contacts" }),
  );
  assert.deepEqual(
    parseNav("?s=activity&r=client&v=solicitudes&c=abc&i=iii&edit=accounts:a1"),
    nav({ section: "activity" }),
  );
  assert.deepEqual(parseNav("?s=admin&edit=tasks:t1&n=n1"), nav({ section: "admin" }));
  // Stray fields on a state are omitted when built, so the canonical URL drops them.
  assert.equal(buildSearch(nav({ section: "home", role: "client", noteId: "n", month: "2026-10", edit: { resource: "tasks", id: "t" } })), "");
  assert.equal(buildSearch(nav({ section: "finance", edit: { resource: "projects", id: "p" } })), "?s=finance");
});

test("legacy section= and solicitudes= links", () => {
  assert.deepEqual(parseNav("?section=finance"), nav({ section: "finance" }));
  assert.deepEqual(parseNav("?section=agenda"), nav({ section: "activity" }));
  assert.deepEqual(parseNav("?section=finanzas"), nav({ section: "finance" }));
  assert.deepEqual(parseNav("?section=contactos"), nav({ section: "contacts" }));
  assert.deepEqual(parseNav("?section=home"), DEFAULT_NAV);
  assert.deepEqual(parseNav("?section=admin"), nav({ section: "admin" }));
  assert.deepEqual(parseNav("?section=nope"), DEFAULT_NAV);
  // Canonical `s` wins over the alias when both are present and `s` is valid.
  assert.equal(parseNav("?s=finance&section=agenda").section, "finance");
  // Invalid `s` falls through to the alias.
  assert.equal(parseNav("?s=agenda&section=finanzas").section, "finance");
  assert.deepEqual(parseNav("?solicitudes=abc"), nav({ section: "contacts", contactsView: "inquiries", inquiryId: "abc" }));
  assert.equal(buildSearch(parseNav("?solicitudes=abc")), "?s=contacts&v=solicitudes&i=abc");
  // The push deep link overrides an explicit section.
  assert.deepEqual(parseNav("?section=finance&solicitudes=abc"), nav({ section: "contacts", contactsView: "inquiries", inquiryId: "abc" }));
  assert.deepEqual(parseNav("?s=activity&solicitudes=zzz&r=client"), nav({ section: "contacts", contactsView: "inquiries", inquiryId: "zzz", role: "client" }));
  assert.deepEqual(parseNav("?solicitudes=../no"), DEFAULT_NAV);
  assert.deepEqual(parseNav("?solicitudes="), DEFAULT_NAV);
  assert.equal(sameNav(parseNav("?section=finance"), nav({ section: "finance" })), true);
  assert.equal(sameNav(nav({ section: "finance" }), nav({ section: "activity" })), false);
  assert.equal(sameNav(
    nav({ section: "activity", edit: { resource: "tasks", id: "t" } }),
    nav({ section: "activity", edit: { resource: "tasks", id: "t" } }),
  ), true);
  assert.equal(sameNav(
    nav({ section: "activity", edit: { resource: "tasks", id: "t" } }),
    nav({ section: "activity", edit: { resource: "tasks", id: "u" } }),
  ), false);
});

test("safeNext allows same-origin paths and rejects open redirects", () => {
  const cases: [string | null | undefined, string][] = [
    [null, "/dashboard"],
    [undefined, "/dashboard"],
    ["", "/dashboard"],
    ["/dashboard", "/dashboard"],
    ["/dashboard?s=finance", "/dashboard?s=finance"],
    ["/dashboard?s=finance&edit=accounts%3Aa1", "/dashboard?s=finance&edit=accounts%3Aa1"],
    ["/dashboard?s=contacts&v=solicitudes&i=abc", "/dashboard?s=contacts&v=solicitudes&i=abc"],
    ["/dashboard?s=finance#hash", "/dashboard?s=finance"],
    ["/", "/"],
    ["/pending", "/pending"],
    ["/invite/abc_def-XYZ0123456789", "/invite/abc_def-XYZ0123456789"],
    ["/loginish", "/loginish"],
    ["https://erp.example/dashboard?s=activity", "/dashboard?s=activity"],
    ["https://erp.example/dashboard?s=activity#x", "/dashboard?s=activity"],
    ["https://ERP.example/dashboard?s=finance", "/dashboard?s=finance"],
    ["https://erp.example:443/pending", "/pending"],
    ["https://user:pass@erp.example/dashboard?s=1", "/dashboard?s=1"],
    ["//evil.com", "/dashboard"],
    ["//erp.example/dashboard", "/dashboard"],
    ["///evil.com", "/dashboard"],
    ["/\\evil.com", "/dashboard"],
    ["/\\evil.com/dashboard", "/dashboard"],
    ["\\\\evil.com", "/dashboard"],
    ["/dashboard\\", "/dashboard"],
    ["https://evil.com", "/dashboard"],
    ["https://evil.com/dashboard", "/dashboard"],
    ["http://erp.example/dashboard", "/dashboard"],
    ["https://erp.example.evil.com/dashboard", "/dashboard"],
    ["javascript:alert(1)", "/dashboard"],
    ["JavaScript:alert(1)", "/dashboard"],
    ["javascript://erp.example/%0aalert(1)", "/dashboard"],
    ["%2F%2Fevil.com", "/dashboard"],
    ["/%2F/evil.com", "/dashboard"],
    ["/%5Cevil.com", "/dashboard"],
    ["%5Cevil.com", "/dashboard"],
    ["/dashboard%0a", "/dashboard"],
    ["/dashboard\n", "/dashboard"],
    ["/dashboard\r\nSet-Cookie:x", "/dashboard"],
    ["/\t/evil.com", "/dashboard"],
    ["%09/evil.com", "/dashboard"],
    ["/%09/evil.com", "/dashboard"],
    ["/dashboard?%0a", "/dashboard"],
    [" /dashboard", "/dashboard"],
    ["dashboard", "/dashboard"],
    ["?s=finance", "/dashboard"],
    ["../dashboard", "/dashboard"],
    ["https:evil.com", "/dashboard"],
    ["/login", "/dashboard"],
    ["/login?next=/", "/dashboard"],
    ["/login/reset", "/dashboard"],
    ["/./login", "/dashboard"],
    ["/dashboard/../login", "/dashboard"],
    ["/%2e%2e/login", "/dashboard"],
    ["/foo/../../login", "/dashboard"],
    ["https://erp.example/login", "/dashboard"],
    ["/api", "/dashboard"],
    ["/api/", "/dashboard"],
    ["/api/data", "/dashboard"],
    ["https://erp.example/api/x", "/dashboard"],
    ["%2flogin", "/dashboard"],
    ["%", "/dashboard"],
    ["/dashboard?next=https://evil.com", "/dashboard?next=https://evil.com"],
    ["https://evil.com\\@erp.example/dashboard", "/dashboard"],
  ];
  assert.ok(cases.length >= 20);
  for (const [raw, expected] of cases) {
    assert.equal(safeNext(raw, ORIGIN), expected, JSON.stringify(raw));
  }
});

function makeHistory(url = "/dashboard"): HistoryLike & { index: number; entries: { state: unknown; url: string }[] } {
  const entries: { state: unknown; url: string }[] = [{ state: null, url }];
  let index = 0;
  return {
    get state() { return entries[index].state; },
    get index() { return index; },
    entries,
    pushState(s: unknown, _t: string, next?: string) {
      const urlNow = next ?? entries[index].url;
      entries.splice(index + 1);
      entries.push({ state: s, url: urlNow });
      index++;
    },
    replaceState(s: unknown, _t: string, next?: string) {
      entries[index] = { state: s, url: next ?? entries[index].url };
    },
    back() { if (index > 0) index--; },
  };
}

test("history helpers: screens push, layers replace, back only closes a layer", () => {
  const h = makeHistory();
  assert.equal(layerOf(h.state), null);

  pushScreen(h, "/dashboard?s=contacts");
  assert.equal(h.index, 1);
  assert.equal(h.entries[1].url, "/dashboard?s=contacts");
  assert.equal(h.entries[1].state, null);
  assert.equal(h.entries.length, 2);

  pushScreen(h, "/dashboard?s=activity");
  assert.equal(h.index, 2);
  assert.equal(h.entries.length, 3);

  openLayer(h, "add");
  assert.equal(h.index, 3);
  assert.equal(h.entries.length, 4);
  assert.deepEqual(h.state, { serpixLayer: "add" });
  assert.equal(h.entries[3].url, "/dashboard?s=activity");

  // Sheet → editor replaces the layer entry. No extra history row.
  openLayer(h, "editor");
  assert.equal(h.index, 3);
  assert.equal(h.entries.length, 4);
  assert.deepEqual(h.state, { serpixLayer: "editor" });
  assert.equal(h.entries[3].url, "/dashboard?s=activity");

  // Closing by the app goes back one entry and does not push.
  assert.equal(closeLayer(h), true);
  assert.equal(h.index, 2);
  assert.equal(h.entries.length, 4);
  assert.equal(layerOf(h.state), null);
  assert.equal(closeLayer(h), false);
  assert.equal(h.index, 2);

  // A screen change while a layer is on top replaces that entry (state null, new url).
  openLayer(h, "timer");
  assert.equal(h.index, 3);
  const before = h.entries.length;
  pushScreen(h, "/dashboard?s=finance");
  assert.equal(h.entries.length, before);
  assert.equal(h.index, 3);
  assert.equal(h.state, null);
  assert.equal(h.entries[3].url, "/dashboard?s=finance");

  // Note → edit replaces, and the URL follows the layer.
  openLayer(h, "note", "/dashboard?s=activity&n=n1");
  assert.deepEqual(h.state, { serpixLayer: "note" });
  assert.equal(h.entries[h.index].url, "/dashboard?s=activity&n=n1");
  const len = h.entries.length;
  openLayer(h, "edit", "/dashboard?s=activity&edit=activities%3An1");
  assert.equal(h.entries.length, len);
  assert.deepEqual(h.state, { serpixLayer: "edit" });
  assert.equal(h.entries[h.index].url, "/dashboard?s=activity&edit=activities%3An1");
  assert.equal(closeLayer(h), true);
  assert.equal(layerOf(h.state), null);

  // refine keeps the layer marker and only swaps the URL.
  openLayer(h, "note", "/dashboard?s=activity&n=n1");
  const marker = h.state;
  refine(h, "/dashboard?s=activity&n=n1&t=list");
  assert.equal(h.state, marker);
  assert.equal(h.entries[h.index].url, "/dashboard?s=activity&n=n1&t=list");
  refine(h, "/dashboard?s=contacts&r=client");
  assert.equal(h.state, marker);

  // openLayer without a url keeps the current one.
  const kept = h.entries[h.index].url;
  openLayer(h, "timer-stop");
  assert.equal(h.entries[h.index].url, kept);
  assert.deepEqual(h.state, { serpixLayer: "timer-stop" });

  // push after back drops the forward entries (same as the browser).
  assert.equal(closeLayer(h), true);
  const idx = h.index;
  pushScreen(h, "/dashboard?s=admin");
  assert.equal(h.index, idx + 1);
  assert.equal(h.entries[h.index].url, "/dashboard?s=admin");
  assert.equal(h.entries[h.index].state, null);
  assert.equal(h.entries.at(-1)?.url, "/dashboard?s=admin");
});

test("layerOf ignores garbage and accepts only the six markers", () => {
  assert.equal(layerOf(null), null);
  assert.equal(layerOf(undefined), null);
  assert.equal(layerOf(1), null);
  assert.equal(layerOf("add"), null);
  assert.equal(layerOf({}), null);
  assert.equal(layerOf([]), null);
  assert.equal(layerOf({ serpixLayer: "nope" }), null);
  assert.equal(layerOf({ serpixLayer: "ADD" }), null);
  assert.equal(layerOf({ serpixLayer: 1 }), null);
  assert.equal(layerOf({ other: "add" }), null);
  const layers: Layer[] = ["add", "editor", "timer", "timer-stop", "note", "edit"];
  for (const layer of layers) assert.equal(layerOf({ serpixLayer: layer }), layer);
});
