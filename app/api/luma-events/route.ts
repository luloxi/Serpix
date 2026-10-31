import { NextResponse } from "next/server";
import { approvedContext, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Visible while the event ended (or started) at most 7 days ago, or a contact of this user
 * still names it. Compared in UTC. The contact match is trim + lower, same user only.
 * Rows are never deleted; this filter only hides them from the suggestion list.
 */
const LIST_SQL = `SELECT e.id, e.name, e.starts_at AS startsAt, e.ends_at AS endsAt, e.url, e.location
FROM luma_events e
WHERE e.user_id = ?
AND (
  datetime(replace(replace(COALESCE(NULLIF(e.ends_at, ''), e.starts_at), 'Z', ''), 'T', ' ')) >= datetime('now', '-7 days')
  OR EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.user_id = e.user_id
      AND c.met_event IS NOT NULL
      AND trim(c.met_event) <> ''
      AND lower(trim(c.met_event)) = lower(trim(e.name))
  )
)
ORDER BY e.starts_at DESC
LIMIT 200`;

const noStore = { "Cache-Control": "no-store" };

type Row = { id: string; name: string; startsAt: string; endsAt: string | null; url: string | null; location: string | null };

/** Approved session, any encryption mode. Reads only luma_events (plus the contact name, never returned). */
export async function GET() {
  const ctx = await approvedContext();
  if (!ctx) return unauthorized();
  const present = await ctx.db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'luma_events'").bind().first<{ n: number }>();
  if (!present) return NextResponse.json({ items: [] }, { headers: noStore });
  const result = await ctx.db.prepare(LIST_SQL).bind(ctx.userId).all<Row>();
  const items = (result.results ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    startsAt: String(row.startsAt),
    endsAt: row.endsAt == null || row.endsAt === "" ? null : String(row.endsAt),
    url: row.url == null || row.url === "" ? null : String(row.url),
    location: row.location == null || row.location === "" ? null : String(row.location),
  }));
  return NextResponse.json({ items }, { headers: noStore });
}
