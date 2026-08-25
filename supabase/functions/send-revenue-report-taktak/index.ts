// Daily revenue report — sends today's revenue + month-to-date total to
// the configured admin phone numbers. Triggered by pg_cron daily at 00:00
// Asia/Colombo (= 18:30 UTC), or manually via POST.
//
// Uses WAHA (primary) + Wasender token fallback, same as the rest of the bot.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const WASENDER_SEND_API = "https://www.wasenderapi.com/api/send-message";
const WAHA_BASE_URL = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/+$/, "");
const WAHA_API_KEY = Deno.env.get("WAHA_API_KEY") || "";

const ADMIN_NUMBERS = [
  "94711365928",
  "94760032274",
  "94769652770",
  "94760159557",
];

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // Optional `date` (YYYY-MM-DD, Asia/Colombo) or `daysBack` (int) to
    // regenerate a past report. Default: the day that just ended, i.e. the
    // Colombo date 30 min before "now" (cron fires 18:30 UTC = 00:00 Colombo).
    let overrideBody: any = {};
    try { overrideBody = await req.clone().json(); } catch { /* ignore */ }
    const dateParam = String(overrideBody?.date || "").trim();
    const daysBack = Number(overrideBody?.daysBack || 0);

    let y: number, m: number, d: number;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      [y, m, d] = dateParam.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))) as [number, number, number];
    } else {
      const base = new Date(Date.now() - 30 * 60 * 1000 - daysBack * 86400_000);
      const colombo = new Date(base.getTime() + 5.5 * 60 * 60 * 1000);
      y = colombo.getUTCFullYear(); m = colombo.getUTCMonth(); d = colombo.getUTCDate();
    }
    const colombo = new Date(Date.UTC(y, m, d));

    const startOfDayUtc = new Date(Date.UTC(y, m, d) - 5.5 * 60 * 60 * 1000);
    const endOfDayUtc = new Date(startOfDayUtc.getTime() + 24 * 60 * 60 * 1000);
    const startOfMonthUtc = new Date(Date.UTC(y, m, 1) - 5.5 * 60 * 60 * 1000);

    const { data: rows } = await supabase
      .from("revenue")
      .select("amount, type, created_at")
      .gte("created_at", startOfMonthUtc.toISOString())
      .lt("created_at", endOfDayUtc.toISOString());

    const monthTotal = (rows || []).reduce((s, r) => s + Number(r.amount), 0);
    const todayRows = (rows || []).filter((r) => new Date(r.created_at).getTime() >= startOfDayUtc.getTime());
    const todayTotal = todayRows.reduce((s, r) => s + Number(r.amount), 0);
    const todayCount = todayRows.length;

    const { data: allRows } = await supabase.from("revenue").select("amount");
    const allTimeTotal = (allRows || []).reduce((s, r) => s + Number(r.amount), 0);

    const dateStr = colombo.toISOString().slice(0, 10);
    const monthStr = colombo.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

    const text =
      `📊 *TakTak Revenue Report*\n` +
      `📅 ${dateStr}\n\n` +
      `💰 *Today:* LKR ${todayTotal.toLocaleString()} (${todayCount} txn)\n` +
      `📈 *${monthStr}:* LKR ${monthTotal.toLocaleString()}\n` +
      `🏆 *All-time:* LKR ${allTimeTotal.toLocaleString()}`;

    const results: any[] = [];
    for (const phone of ADMIN_NUMBERS) {
      const r = await sendWhatsAppMessage(supabase, phone, text);
      results.push({ phone, ...r });
      await new Promise((res) => setTimeout(res, 6000));
    }

    console.log("send-revenue-report results:", JSON.stringify(results));
    return json({ success: true, todayTotal, monthTotal, allTimeTotal, results });
  } catch (e) {
    console.error("send-revenue-report error:", e);
    return json({ error: String((e as any)?.message || e) }, 500);
  }
}

async function sendWhatsAppMessage(supabase: any, phone: string, text: string) {
  const waha = await sendWithWaha(supabase, phone, text);
  if (waha.sent) return waha;
  const wasender = await sendWithWasender(phone, text);
  if (wasender.sent) return wasender;
  return { sent: false, error: waha.error || wasender.error || "no provider" };
}

async function sendWithWaha(supabase: any, phone: string, text: string) {
  if (!WAHA_BASE_URL || !WAHA_API_KEY) return { sent: false, provider: "waha", error: "waha not configured" };
  const { data: session } = await supabase
    .from("waha_sessions")
    .select("waha_session_id, name")
    .eq("role", "bot")
    .eq("status", "connected")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sessionName = session?.waha_session_id || session?.name;
  if (!sessionName) return { sent: false, provider: "waha", error: "no connected bot session" };
  const res = await wahaFetch("/api/sendText", {
    method: "POST",
    body: JSON.stringify({ session: sessionName, chatId: `${phone}@c.us`, text }),
  });
  if (res.ok) return { sent: true, provider: "waha" };
  return { sent: false, provider: "waha", error: await res.text().catch(() => `waha ${res.status}`) };
}

async function sendWithWasender(phone: string, text: string) {
  const token = Deno.env.get("WASENDER_API_TOKEN") || Deno.env.get("WASENDER_PERSONAL_ACCESS_TOKEN") || "";
  if (!token) return { sent: false, provider: "wasender", error: "wasender not configured" };
  const to = phone.startsWith("+") ? phone : `+${phone}`;
  const res = await fetch(WASENDER_SEND_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to, text }),
  });
  if (res.ok) return { sent: true, provider: "wasender" };
  return { sent: false, provider: "wasender", error: await res.text().catch(() => `wasender ${res.status}`) };
}

async function sha512Hex(value: string) {
  const buf = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function wahaKeys() {
  const raw = WAHA_API_KEY.trim();
  if (!raw) return [];
  return Array.from(new Set([raw, await sha512Hex(raw)]));
}
async function wahaFetch(path: string, init: RequestInit = {}) {
  const url = path.startsWith("http") ? path : `${WAHA_BASE_URL}${path}`;
  const base = new Headers(init.headers);
  if (!base.has("Accept")) base.set("Accept", "application/json");
  if (init.body && !base.has("Content-Type")) base.set("Content-Type", "application/json");
  const strategies = [
    (h: Headers, k: string) => h.set("X-Api-Key", k),
    (h: Headers, k: string) => h.set("Authorization", `Bearer ${k}`),
    (h: Headers, k: string) => h.set("Api-Key", k),
  ];
  let last = "Unauthorized";
  for (const k of await wahaKeys()) {
    for (const apply of strategies) {
      const h = new Headers(base);
      h.delete("X-Api-Key"); h.delete("Authorization"); h.delete("Api-Key");
      apply(h, k);
      const res = await fetch(url, { ...init, headers: h });
      if (res.status !== 401) return res;
      last = await res.text().catch(() => "Unauthorized");
    }
  }
  return new Response(last, { status: 401 });
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
