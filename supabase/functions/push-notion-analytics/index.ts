// Pushes daily metrics to the TakTak Analytics Notion database.
// Defaults to "yesterday" in Asia/Colombo. Accepts { date: "YYYY-MM-DD" } body override.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DB_ID = "b6486521-1304-416d-994e-1e0882189f00";
const GATEWAY = "https://connector-gateway.lovable.dev/notion/v1";

function colomboDateString(offsetDays = 0): string {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000 - offsetDays * 86400 * 1000);
  return now.toISOString().slice(0, 10);
}

async function pushRow(date: string, metric: string, value: number) {
  const res = await fetch(`${GATEWAY}/pages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("LOVABLE_API_KEY")}`,
      "X-Connection-Api-Key": Deno.env.get("NOTION_API_KEY")!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: DB_ID },
      properties: {
        Name: { title: [{ text: { content: `${date} — ${metric}` } }] },
        Date: { date: { start: date } },
        Metric: { select: { name: metric } },
        Value: { number: value },
      },
    }),
  });
  const ok = res.ok;
  const body = ok ? null : await res.text();
  return { metric, value, ok, status: res.status, body };
}

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let date = colomboDateString(1); // yesterday Colombo
  try {
    const body = await req.json();
    if (body?.date) date = body.date;
  } catch { /* no body */ }

  // Bounds: [date 00:00 Colombo, date+1 00:00 Colombo) as UTC
  const startUtc = new Date(`${date}T00:00:00+05:30`).toISOString();
  const endUtc = new Date(new Date(`${date}T00:00:00+05:30`).getTime() + 86400000).toISOString();

  const [listings, users, outgoing, allMsgs, paid] = await Promise.all([
    supabase.from("listings").select("id", { count: "exact", head: true }).gte("created_at", startUtc).lt("created_at", endUtc),
    supabase.from("marketplace_users").select("id", { count: "exact", head: true }).gte("created_at", startUtc).lt("created_at", endUtc),
    supabase.from("chat_messages").select("id", { count: "exact", head: true }).eq("direction", "outgoing").gte("created_at", startUtc).lt("created_at", endUtc),
    supabase.from("chat_messages").select("phone_number").gte("created_at", startUtc).lt("created_at", endUtc),
    supabase.from("payments").select("id", { count: "exact", head: true }).eq("status", "paid").gte("created_at", startUtc).lt("created_at", endUtc),
  ]);

  const activeUsers = new Set((allMsgs.data || []).map((r: any) => r.phone_number)).size;

  const metrics: Array<[string, number]> = [
    ["New Listings", listings.count || 0],
    ["Signups", users.count || 0],
    ["Messages Sent", outgoing.count || 0],
    ["Active Users", activeUsers],
    ["Conversions", paid.count || 0],
  ].filter(([_, v]) => v > 0) as Array<[string, number]>;

  const results = [];
  for (const [m, v] of metrics) results.push(await pushRow(date, m, v));

  return new Response(JSON.stringify({ date, pushed: results.length, results }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
