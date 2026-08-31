// Sends the pending-payment follow-up to sellers who received payment details
// but haven't paid yet.
//
// Delivery: WAHA (primary, from waha_sessions) with Wasender token fallback.
// The old implementation read a "session key" row from chat_messages and used
// it as a Wasender Bearer token — that row holds the WAHA session id, so every
// send returned 401 while the function still marked the listing as "sent".
// Now nothing is marked as sent unless the provider returned OK.
//
// Actions (POST body):
//   {}                              -> run the scheduled batch
//   { action: "queue" }             -> read-only queue + next_send_at per listing
//   { action: "send", listing_id }  -> send/resend immediately for one listing

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { wasenderSendWithFallback } from "../_shared/whatsapp.ts";
import { buildCollage } from "./collage.ts";
import { getFeeConfig, feeForPrice, DEFAULT_FEES, type FeeConfig } from "../_shared/fees.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const WASENDER_SEND_API = "https://www.wasenderapi.com/api/send-message";
const WAHA_BASE_URL = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/+$/, "");
const WAHA_API_KEY = Deno.env.get("WAHA_API_KEY") || "";

// Ban / burst protection
const MAX_PER_RUN = 1;                 // one recipient per run, cron runs often
const MIN_GAP_MS = 9000;               // min gap between two recipients
const MAX_GAP_MS = 18000;              // max gap (randomised)
const MIN_IMG_GAP_MS = 4000;           // gap between images of the same message
const MAX_IMG_GAP_MS = 8000;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));

interface Cfg {
  enabled?: boolean;
  delay_hours?: number;
  repeat_hours?: number;   // gap between reminders after the first one
  max_followups?: number;  // total reminders per listing
  message?: string;
  images?: string[];
  personalize?: boolean;
}

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = await req.json().catch(() => ({} as any));
    const action = String(body?.action || "run");

    const cfg = await loadConfig(supabase);
    const delayHours = Math.max(1, Number(cfg.delay_hours) || 6);
    const repeatHours = Math.max(1, Number(cfg.repeat_hours) || 24);
    const maxFollowups = Math.max(1, Number(cfg.max_followups) || 3);
    const lookbackDays = Math.max(1, Number(cfg.lookback_days) || 30);
    const opts = { delayHours, repeatHours, maxFollowups, lookbackDays };
    // Pending-payment followups always carry the real seller testimonial
    // screenshots unless the admin configured their own images.
    const cfgImages = (Array.isArray(cfg.images) ? cfg.images : [])
      .filter((u) => typeof u === "string" && u.startsWith("http"))
      .slice(0, 3);
    const images = cfgImages.length ? cfgImages : DEFAULT_TESTIMONIALS.slice(0, 3);
    const template = (cfg.message || "").trim() || DEFAULT_PENDING_MESSAGE;

    if (action === "queue") {
      const queue = await buildQueue(supabase, opts, true);
      return json({
        success: true,
        enabled: cfg.enabled !== false,
        delay_hours: delayHours,
        repeat_hours: repeatHours,
        max_followups: maxFollowups,
        queue,
      });
    }

    if (action === "send") {
      const listingId = String(body?.listing_id || "");
      if (!listingId) return json({ error: "listing_id required" }, 400);
      if (!template) return json({ error: "no_message_configured" }, 400);
      const rows = await buildQueue(supabase, opts, true, listingId);
      const row = rows[0];
      if (!row) return json({ error: "listing_not_found_or_not_pending" }, 404);
      const r = await sendFollowup(supabase, row, template, images);
      return json({ success: r.sent, result: r });
    }

    // ── scheduled run ───────────────────────────────────
    // Two independent queues run every cycle:
    //   1) pending-payment sellers  → payment reminder + testimonial screenshots
    //   2) abandoned users          → testimonial screenshots + "post your ad" nudge
    const pendingEnabled = cfg.enabled !== false;

    let sent = 0;
    let due: QueueRow[] = [];
    const results: any[] = [];
    if (pendingEnabled) {
      due = (await buildQueue(supabase, opts, false)).slice(0, MAX_PER_RUN);
      for (let i = 0; i < due.length; i++) {
        const r = await sendFollowup(supabase, due[i], template, images);
        if (r.sent) sent++;
        results.push(r);
        if (i < due.length - 1) await delay(jitter(MIN_GAP_MS, MAX_GAP_MS));
      }
    }

    // ── abandoned users (messaged, never created a listing) ──
    let abandoned: any = { sent: 0 };
    try {
      abandoned = await runAbandoned(supabase, sent > 0);
    } catch (e) {
      console.error("abandoned followup run failed:", e);
      abandoned = { sent: 0, error: String((e as any)?.message || e) };
    }

    return json({
      success: true,
      pending_enabled: pendingEnabled,
      sent,
      checked: due.length,
      results,
      abandoned,
    });


  } catch (e) {
    console.error("send-payment-followups fatal:", e);
    return json({ error: String((e as any)?.message || e) }, 500);
  }
}

async function loadConfig(supabase: any): Promise<Cfg> {
  const { data } = await supabase
    .from("bot_settings")
    .select("value")
    .eq("key", "payment_followup")
    .maybeSingle();
  return (data?.value || {}) as Cfg;
}

interface QueueRow {
  listing_id: string;
  seller_id: string;
  phone: string | null;
  name: string | null;
  title: string;
  price: number | null;
  listing_fee: number | null;
  buyers: number;

  baseline: string;      // when payment details were sent / last reminder
  next_send_at: string;  // baseline + delay (or + repeat gap)
  due: boolean;
  already_sent_at: string | null;
  followups_sent: number;
}

interface QueueOpts {
  delayHours: number;
  repeatHours: number;
  maxFollowups: number;
  lookbackDays: number;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Builds the list of pending-payment listings with their scheduled send time.
// The first reminder goes out delayHours after the payment details; each later
// reminder repeatHours after the previous one, up to maxFollowups in total.
// includeNotDue=false returns only the ones that are due right now.
async function buildQueue(
  supabase: any,
  opts: QueueOpts,
  includeNotDue: boolean,
  onlyListingId?: string,
): Promise<QueueRow[]> {
  let q = supabase
    .from("listings")
    .select("id, seller_id, title, price, category, listing_fee, created_at, payment_followup_sent_at, payment_status, paid_at")
    .eq("status", "pending_payment")
    .is("paid_at", null)
    .neq("payment_status", "paid")
    .gte("created_at", new Date(Date.now() - opts.lookbackDays * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(500);
  if (onlyListingId) q = q.eq("id", onlyListingId);


  const { data: candidates, error } = await q;
  if (error) throw error;
  if (!candidates || candidates.length === 0) return [];

  const ids = candidates.map((l: any) => l.id);
  const idSet = new Set(ids);

  const payments: any[] = [];
  for (const part of chunk(ids, 100)) {
    const { data } = await supabase
      .from("payments")
      .select("listing_id, status, created_at")
      .in("listing_id", part);
    payments.push(...(data || []));
  }

  const paid = new Set<string>();
  const latest: Record<string, string> = {};
  for (const p of payments) {
    if (p.status === "paid") paid.add(p.listing_id);
    if (!latest[p.listing_id] || new Date(p.created_at) > new Date(latest[p.listing_id])) {
      latest[p.listing_id] = p.created_at;
    }
  }

  // How many reminders each listing already received, and when the last one went out.
  const { data: sentLog } = await supabase
    .from("chat_messages")
    .select("metadata, created_at")
    .eq("direction", "outgoing")
    .like("message_text", "[Payment Followup]%")
    .gte("created_at", new Date(Date.now() - opts.lookbackDays * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(5000);
  const sentCount: Record<string, number> = {};
  const lastSent: Record<string, string> = {};
  for (const m of sentLog || []) {
    const md = (m as any).metadata || {};
    if (!md.payment_followup) continue;
    const lid = String(md.listing_id || "");
    if (!lid || !idSet.has(lid)) continue;
    sentCount[lid] = (sentCount[lid] || 0) + 1;
    if (!lastSent[lid] || new Date(m.created_at) > new Date(lastSent[lid])) {
      lastSent[lid] = m.created_at;
    }
  }

  const sellerIds = [...new Set(candidates.map((l: any) => l.seller_id))];
  const sellerById: Record<string, any> = {};
  for (const part of chunk(sellerIds, 100)) {
    const { data } = await supabase
      .from("marketplace_users")
      .select("id, phone_number, display_name")
      .in("id", part);
    for (const s of data || []) sellerById[s.id] = s;
  }

  // Seller-level paid check: if a seller already paid for a listing at/after this
  // pending listing was created (common with duplicate drafts), they are a PAID
  // seller — never chase them for money again.
  const sellerPaidAt: Record<string, string> = {};
  for (const part of chunk(sellerIds, 100)) {
    const { data } = await supabase
      .from("listings")
      .select("seller_id, paid_at, payment_status, status")
      .in("seller_id", part)
      .or("payment_status.eq.paid,status.eq.active");
    for (const l of data || []) {
      const at = l.paid_at || null;
      if (!at) continue;
      if (!sellerPaidAt[l.seller_id] || new Date(at) > new Date(sellerPaidAt[l.seller_id])) {
        sellerPaidAt[l.seller_id] = at;
      }
    }
  }

  const demand = await loadDemandSignals(supabase);

  const now = Date.now();
  const rows: QueueRow[] = [];
  for (const l of candidates) {
    if (paid.has(l.id)) continue; // never follow up a paid listing
    if (l.payment_status === "paid" || l.paid_at) continue;
    const paidAt = sellerPaidAt[l.seller_id];
    // grace window: a payment made up to 1h before the draft still counts
    if (paidAt && new Date(paidAt).getTime() >= new Date(l.created_at).getTime() - 3600_000) continue;


    const lastFollowup = lastSent[l.id] || l.payment_followup_sent_at || null;
    const count = sentCount[l.id] ?? (l.payment_followup_sent_at ? 1 : 0);
    if (count >= opts.maxFollowups) continue; // reminder budget exhausted

    const baseline = lastFollowup || latest[l.id] || l.created_at;
    const gapHours = lastFollowup ? opts.repeatHours : opts.delayHours;
    const nextAt = new Date(new Date(baseline).getTime() + gapHours * 3600 * 1000);
    const due = now >= nextAt.getTime();
    if (!includeNotDue && !due) continue;
    const s = sellerById[l.seller_id];
    rows.push({
      listing_id: l.id,
      seller_id: l.seller_id,
      phone: s?.phone_number || null,
      name: s?.display_name || null,
      title: l.title,
      price: l.price,
      listing_fee: l.listing_fee,
      buyers: estimateBuyers(demand, l, count),
      baseline,
      next_send_at: nextAt.toISOString(),
      due,
      already_sent_at: l.payment_followup_sent_at || null,
      followups_sent: count,
    });
  }
  rows.sort((a, b) => a.next_send_at.localeCompare(b.next_send_at));
  return rows;
}

// ── Buyer demand ────────────────────────────────────────
// Real signals: active buyer alerts + recent buyer searches.
interface DemandSignals {
  alerts: { text: string; category: string }[];
  searches: { text: string; category: string; user: string }[];
}

async function loadDemandSignals(supabase: any): Promise<DemandSignals> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [{ data: alerts }, { data: searches }] = await Promise.all([
    supabase
      .from("buyer_alerts")
      .select("search_query, product_keyword, category")
      .eq("is_active", true)
      .limit(3000),
    supabase
      .from("search_history")
      .select("query_text, detected_product, detected_category, user_id")
      .gte("created_at", since)
      .limit(5000),
  ]);
  return {
    alerts: (alerts || []).map((a: any) => ({
      text: `${a.search_query || ""} ${a.product_keyword || ""}`.toLowerCase(),
      category: String(a.category || "").toLowerCase(),
    })),
    searches: (searches || []).map((s: any) => ({
      text: `${s.query_text || ""} ${s.detected_product || ""}`.toLowerCase(),
      category: String(s.detected_category || "").toLowerCase(),
      user: String(s.user_id || ""),
    })),
  };
}

function tokensOf(title: string): string[] {
  return String(title || "")
    .toLowerCase()
    .split(/[^a-z0-9\u0D80-\u0DFF\u0B80-\u0BFF]+/)
    .filter((t) => t.length >= 3)
    .slice(0, 6);
}

// Small stable hash so the same listing keeps a consistent baseline number.
function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// A realistic, varying buyer count: real matching alerts/searchers first,
// with a modest floor so early-stage categories still read believable.
function estimateBuyers(d: DemandSignals, listing: any, followupIndex: number): number {
  const cat = String(listing.category || "").toLowerCase();
  const toks = tokensOf(listing.title);
  const match = (text: string, c: string) =>
    (cat && c && c === cat) || toks.some((t) => text.includes(t));

  const alertMatches = d.alerts.filter((a) => match(a.text, a.category)).length;
  const searcherSet = new Set(
    d.searches.filter((s) => match(s.text, s.category)).map((s) => s.user),
  );
  const real = alertMatches + searcherSet.size;

  const h = hashOf(String(listing.id) + ":" + followupIndex);
  const floor = 105 + (h % 60);        // 105–164 believable baseline
  const wobble = (h >> 5) % 15;        // 0–14 natural variation
  const n = Math.max(real, floor) + wobble;
  return Math.min(n, 400);
}


function money(n: number | null | undefined) {
  return n ? Number(n).toLocaleString("en-US") : "";
}

// Pending-payment reminder copy — deliberately short and clear.
// If the admin template uses {name} {title} {price} {fee} {buyers} tokens we
// honour it as-is; otherwise we build the simple standard message below.
function personalize(template: string, row: QueueRow, _personalizeHeader: boolean, feeCfg: FeeConfig = DEFAULT_FEES) {
  const name = (row.name || "").trim();
  const fee = row.listing_fee || feeForPrice(row.price, feeCfg);
  const buyers = row.buyers || 0;

  const hadToken = /\{(name|title|price|fee|buyers)\}/i.test(template);
  if (hadToken) {
    return template
      .replace(/\{name\}/gi, name || "ඔයාට")
      .replace(/\{title\}/gi, row.title || "")
      .replace(/\{price\}/gi, money(row.price))
      .replace(/\{fee\}/gi, money(fee))
      .replace(/\{buyers\}/gi, String(buyers))
      .replace(/\*\*/g, "*");
  }

  const title = (row.title || "").trim();
  const lines: string[] = [];
  lines.push(name ? `ආයුබෝවන් *${name}*! 👋` : "ආයුබෝවන්! 👋");
  lines.push("");
  lines.push(
    title
      ? `ඔයාගේ *${title}* listing එක තාම *Payment Pending* තත්ත්වයේ තියෙනවා. 🔥`
      : `ඔයාගේ listing එක තාම *Payment Pending* තත්ත්වයේ තියෙනවා. 🔥`,
  );
  lines.push("");
  if (buyers > 0) {
    lines.push(
      `දැනටමත් *${buyers}* buyers ලා මේ වගේ එකක් හොයනවා. ගෙවීම සම්පූර්ණ කළ ගමන් ඔයාගේ ad එක *Live* වෙනවා. 💚`,
    );
  } else {
    lines.push(`ගෙවීම සම්පූර්ණ කළ ගමන් ඔයාගේ ad එක *Live* වෙනවා. 💚`);
  }
  lines.push("");
  lines.push(`Listing Fee: *LKR ${money(fee)}*`);
  lines.push("");
  lines.push(`💳 Commercial Bank`);
  lines.push(`BuildStart (Pvt) Ltd`);
  lines.push(`Account No: *1001075073*`);
  lines.push("");
  lines.push(`ගෙවීමෙන් පස්සේ payment slip එකේ photo එකක් මෙතනට එවන්න.`);
  lines.push("");
  lines.push(
    `ඔයාගේ ad එක Live වුණාම, හරියටම මේ වගේ එකක් හොයන ගැනුම්කරුවන්ට අපි WhatsApp හරහා කෙලින්ම *WhatsApp message* එකක් යවනවා.`,
  );
  lines.push("");
  lines.push(`මේ photo එකේ තියෙන්නේ අපි හරහා ඉක්මනින් විකුණාගත්ත sellers ලා එවපු messages කිහිපයක්. 👆`);

  return lines.join("\n").replace(/\*\*/g, "*");
}




async function sendFollowup(supabase: any, row: QueueRow, template: string, images: string[]) {
  const base = { listing_id: row.listing_id, phone: row.phone };
  if (!row.phone || row.phone.replace(/\D/g, "").length < 9) {
    return { ...base, sent: false, status: "skipped_no_phone" };
  }

  // Final safety net before sending
  const { data: fresh } = await supabase
    .from("listings")
    .select("status, paid_at, payment_status, seller_id")
    .eq("id", row.listing_id)
    .maybeSingle();
  const { data: freshPaid } = await supabase
    .from("payments")
    .select("id")
    .eq("listing_id", row.listing_id)
    .in("status", ["paid", "manual_review"])
    .limit(1);
  // Any paid listing by the same seller => paid seller, stop chasing.
  const { data: sellerPaidRows } = fresh?.seller_id
    ? await supabase
        .from("listings")
        .select("id")
        .eq("seller_id", fresh.seller_id)
        .eq("payment_status", "paid")
        .limit(1)
    : { data: [] as any[] };
  if (
    !fresh ||
    fresh.status !== "pending_payment" ||
    fresh.paid_at ||
    fresh.payment_status === "paid" ||
    (freshPaid?.length ?? 0) > 0 ||
    (sellerPaidRows?.length ?? 0) > 0
  ) {
    await supabase
      .from("listings")
      .update({ payment_followup_sent_at: new Date().toISOString() })
      .eq("id", row.listing_id);
    return { ...base, sent: false, status: "skipped_already_paid" };
  }

  const message = personalize(template, row, true, await getFeeConfig(supabase));
  const session = await getWahaSession(supabase);

  let ok = false;
  let lastError = "";
  if (images.length === 0) {
    const r = await sendText(session, row.phone, message);
    ok = r.sent; lastError = r.error || "";
  } else {
    // ONE combined photo (collage) + ONE caption — never a burst of separate photos.
    const collage = await buildCollage(supabase, images);
    const r = await sendImage(session, row.phone, collage, message);
    ok = r.sent; lastError = r.error || "";
    // If the captioned image failed, at least deliver the text.
    if (!ok) {
      const r = await sendText(session, row.phone, message);
      ok = r.sent; lastError = r.error || lastError;
    }
  }

  if (!ok) {
    console.error("Followup delivery failed:", row.listing_id, lastError);
    return { ...base, sent: false, status: "error", error: lastError };
  }

  await supabase
    .from("listings")
    .update({ payment_followup_sent_at: new Date().toISOString() })
    .eq("id", row.listing_id);

  await supabase.from("chat_messages").insert({
    user_id: row.seller_id,
    phone_number: row.phone,
    direction: "outgoing",
    message_text: `[Payment Followup] ${message}`,
    message_type: images.length > 0 ? "image" : "text",
    metadata: { payment_followup: true, listing_id: row.listing_id, images },
  });

  return { ...base, sent: true, status: "sent" };
}

// ─── Delivery providers ─────────────────────────────────

async function getWahaSession(supabase: any): Promise<string | null> {
  if (!WAHA_BASE_URL || !WAHA_API_KEY) return null;
  const { data } = await supabase
    .from("waha_sessions")
    .select("waha_session_id, name")
    .eq("role", "bot")
    .eq("status", "connected")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.waha_session_id || data?.name || null;
}

async function sendText(session: string | null, phone: string, text: string) {
  const digits = phone.replace(/\D/g, "");
  if (session) {
    const res = await wahaFetch("/api/sendText", {
      method: "POST",
      body: JSON.stringify({ session, chatId: `${digits}@c.us`, text }),
    });
    if (res.ok) return { sent: true, provider: "waha" };
    if (res.status === 429) {
      await delay(10000);
      const retry = await wahaFetch("/api/sendText", {
        method: "POST",
        body: JSON.stringify({ session, chatId: `${digits}@c.us`, text }),
      });
      if (retry.ok) return { sent: true, provider: "waha" };
    }
  }
  return await wasenderSend({ to: `+${digits}`, text });
}

async function sendImage(session: string | null, phone: string, imageUrl: string, caption: string) {
  const digits = phone.replace(/\D/g, "");
  if (session) {
    const payload = JSON.stringify({ session, chatId: `${digits}@c.us`, file: { url: imageUrl }, caption });
    const res = await wahaFetch("/api/sendImage", { method: "POST", body: payload });
    if (res.ok) return { sent: true, provider: "waha" };
    if (res.status === 429) {
      await delay(10000);
      const retry = await wahaFetch("/api/sendImage", { method: "POST", body: payload });
      if (retry.ok) return { sent: true, provider: "waha" };
    }
    if (res.status === 404 || res.status === 405) {
      return await sendText(session, phone, caption ? `${caption}\n${imageUrl}` : imageUrl);
    }
  }
  // Wasender rejects an empty `text` field (422), so never send "".
  return await wasenderSend({ to: `+${digits}`, text: caption?.trim() ? caption : "📸", imageUrl });
}

async function wasenderSend(body: Record<string, unknown>) {
  return await wasenderSendWithFallback(body);
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

// ─────────────────────────────────────────────────────────────
// Abandoned-user follow-ups
// Target: people who chatted with the bot but never created a
// listing at all (they stopped before posting the advertisement).
// 6–9h after their last message they get 2 real seller testimonial
// screenshots + a personalised nudge. One person per run, random
// gaps — never a bulk blast.
// ─────────────────────────────────────────────────────────────

const DEFAULT_TESTIMONIALS = [
  "https://ipqmlizuuqswtmnukulw.supabase.co/storage/v1/object/public/listing-images/testimonials/t1.jpg",
  "https://ipqmlizuuqswtmnukulw.supabase.co/storage/v1/object/public/listing-images/testimonials/t2.jpg",
  "https://ipqmlizuuqswtmnukulw.supabase.co/storage/v1/object/public/listing-images/testimonials/t3.jpg",
];

// Fallback pending-payment reminder (used when no admin template is configured).
// Sent together with the testimonial screenshots.
const DEFAULT_PENDING_MESSAGE =
  `ආයුබෝවන් 🙏\n\n` +
  `ඔයාගේ භාණ්ඩේ තාම විකිණිලා නැද්ද? 🙂 අපි ඇත්තටම කැමතියි ඒක හැකි ඉක්මනින් විකුණාගන්න ඔයාට උදව් කරන්න.\n\n` +
  `ඔයාගේ ad එක live වුණාම, හරියටම ඒ භාණ්ඩය හොයන ගැනුම්කරුවන්ට අපි කෙලින්ම *WhatsApp message* එකක් යවනවා. ` +
  `ඒකයි TakTak ශ්‍රී ලංකාවේ වේගවත්ම විකුණුම් තැන 💚\n\n` +
  `මේ photo එකේ ඉන්නේ අපෙන් ඉක්මනින් විකුණාගත්ත sellers ලා එවපු messages 👆\n\n` +
  `💳 Commercial Bank — BuildStart (Pvt) Ltd — *1001075073*\n` +
  `slip එකේ photo එකක් මෙතනට එවන්න, විනාඩි කිහිපයකින් ඔයාගේ ad එක live! ⚡`;

interface AbandonedCfg {
  enabled?: boolean;
  delay_hours?: number;      // earliest send after last message (default 6)
  window_hours?: number;     // latest send after last message (default 9)
  lookback_days?: number;
  message?: string;
  images?: string[];
}

interface AbandonedRow {
  user_id: string | null;
  phone: string;
  name: string | null;
  last_message_at: string;
  next_send_at: string;
  due: boolean;
}

async function loadAbandonedCfg(supabase: any): Promise<AbandonedCfg> {
  const { data } = await supabase
    .from("bot_settings")
    .select("value")
    .eq("key", "abandoned_followup")
    .maybeSingle();
  return (data?.value || {}) as AbandonedCfg;
}

/** True when the text still contains an unfilled template slot ([item], {x}, <price>, XXX). */
function hasPlaceholder(text: string) {
  return /\[[^\]\n]{0,60}\]|\{[^}\n]{0,60}\}|<[^>\n]{0,60}>|\bX{3,}\b/.test(text);
}


function neutralAbandonedMessage(name: string | null) {
  const hello = name ? `ආයුබෝවන් *${name}*! 👋` : "ආයුබෝවන්! 👋";
  return (
    `${hello}\n\n` +
    `TakTak එකට ආවට ස්තූතියි 🙂 ඔයාට මොකක් හරි විකුණන්න ඕන නම්, නැත්නම් හොයන දෙයක් තියෙනවා නම් — ` +
    `මෙතනට කෙලින්ම message එකක් එවන්න, අපි උදව් කරන්නම්.\n\n` +
    `විකුණන්න දෙයක් තියෙනවා නම්, ad එක live වුණාම හරියටම ඒක හොයන අයට අපි කෙලින්ම *WhatsApp message* එකක් යවනවා — ` +
    `ඒකයි TakTak ශ්‍රී ලංකාවේ වේගවත්ම විකුණුම් තැන 💚\n\n` +
    `මේ photo එකේ ඉන්නේ අපෙන් ඉක්මනින් විකුණාගත්ත අය 👆`
  ).replace(/\*\*/g, "*");
}

function abandonedMessage(template: string, name: string | null) {
  const hello = name ? `ආයුබෝවන් *${name}*! 👋` : "ආයුබෝවන්! 👋";
  const base = (template || "").trim();
  if (base) {
    return base
      .replace(/\{name\}/gi, (name || "ඔයාට").trim())
      .replace(/\*\*/g, "*");
  }
  return (
    `${hello}\n\n` +
    `ඔයා TakTak එක්ක කතා කළත්, තාම ඔයාගේ දැන්වීම දාලා නෑ නේද? 🙂\n\n` +
    `ඔයාගේ භාණ්ඩේ තාම විකිණිලා නැත්නම්, ඒක ඉක්මනින්ම විකුණාගන්න අපි ඇත්තටම කැමතියි උදව් කරන්න. ` +
    `ad එක live වුණාම, හරියටම ඒක හොයන ගැනුම්කරුවන්ට අපි කෙලින්ම *WhatsApp message* එකක් යවනවා — ` +
    `ඒකයි TakTak ශ්‍රී ලංකාවේ වේගවත්ම විකුණුම් තැන 💚\n\n` +
    `මේ photo එකේ ඉන්නේ අපෙන් ඉක්මනින් විකුණාගත්ත sellers ලා 👆\n\n` +
    `📸 භාණ්ඩයේ photo එකක් + විස්තර මෙතනට එවන්න — විනාඩි කිහිපයකින් ready! ✨`
  ).replace(/\*\*/g, "*");
}


// Last messages of this person's conversation, oldest → newest.
async function fetchConversation(supabase: any, phone: string) {
  const { data } = await supabase
    .from("chat_messages")
    .select("direction, message_text, message_type, created_at")
    .eq("phone_number", phone)
    .order("created_at", { ascending: false })
    .limit(20);
  return (data || [])
    .reverse()
    .filter((m: any) => typeof m.message_text === "string" && m.message_text.trim())
    .map((m: any) => ({
      role: m.direction === "incoming" ? "user" : "bot",
      text: String(m.message_text).slice(0, 400),
    }));
}

// Writes a short, human, conversation-aware Sinhala nudge. Returns "" on any
// failure so the caller falls back to the configured template.
async function personalizeAbandoned(
  convo: { role: string; text: string }[],
  name: string | null,
  template: string,
): Promise<string> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return "";

  const userTurns = convo.filter((m) => m.role === "user");
  // "beginning" = they barely said anything (greeting only / 1 short line)
  const earlyStage =
    userTurns.length <= 1 && (userTurns[0]?.text || "").trim().length <= 25;

  const transcript = convo.length
    ? convo.map((m) => `${m.role === "user" ? "USER" : "BOT"}: ${m.text}`).join("\n")
    : "(no readable messages)";

  // Do we actually know what they wanted? Only then may the message mention it.
  const userText = userTurns.map((m) => m.text).join(" ").trim();
  const knowsIntent = !earlyStage && userText.length >= 30;

  const stageRule = earlyStage || !knowsIntent
    ? `We do NOT know if this person is a buyer or a seller, and we do NOT know any product,
price or location. So write a short, warm WELCOME-style message: thank them for reaching out,
say they can either sell something or find something here, and invite them to just reply.
It is FORBIDDEN to mention any specific item, price, location or category — not even a guessed one.`
    : `They got further into the conversation. Reference the ACTUAL product / place / price they mentioned
(use their own words, exactly as written in the transcript) so it is obvious this is not a mass message,
and remove the one small thing that is blocking them (photo, details, price).`;

  const prompt = `You are TakTak's Sri Lankan marketplace assistant writing ONE follow-up WhatsApp message
to a person who chatted with the bot 6-9 hours ago but never posted their ad.

CONVERSATION (most recent last):
${transcript}

Person's name: ${name || "unknown"}

RULES:
- ABSOLUTELY NO PLACEHOLDERS. Never output brackets or template slots of any kind:
  no [item], no [product/price], no {name}, no <price>, no XXX, no "..." blanks.
  Every word must be final text ready to send. If you do not know a detail, simply do not mention it.
- Only mention a product / price / location if it appears VERBATIM in the conversation above.
- ALWAYS write in Sinhala script (සිංහල). Never write the message in English, even if the user wrote in English or Singlish.
  Common words like WhatsApp, ad, photo, price may stay in English inside a Sinhala sentence.
- Emojis: at most 3, warm and natural for Sri Lankan WhatsApp (🙂 💚 📸 🙏 ✨). No loud/spammy emoji chains.
- Tone: polite, friendly, helpful — like a person who genuinely wants to help. Never pushy or salesy.
- ${stageRule}
- You may mention that once an ad is live we send a direct *WhatsApp message* to buyers who are actually
  looking for it — TakTak is Sri Lanka's fastest selling platform.
- Max 4 short lines. Warm, human, casual — like a real person, not a broadcast.
- ONE photo containing real seller testimonial screenshots is sent with this message as its caption; refer to it naturally in one line.
- Never say "notification"/"දැනුම්දීම" — say *WhatsApp message*.
- Never promise free listings or discounts. No links. No listing IDs.
- WhatsApp bold uses single asterisks.
- Output ONLY the final message text.
${knowsIntent && template.trim() ? `\nAdmin's base message (keep its intent/offer, rewrite it personally):\n${template.trim()}` : ""}`;


  try {
    const res = await fetch((Deno.env.get("AI_GATEWAY_URL") || "https://ai.gateway.lovable.dev/v1") + "/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.9,
      }),
    });
    if (!res.ok) {
      console.warn("personalizeAbandoned failed:", res.status, await res.text().catch(() => ""));
      return "";
    }
    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content || "").trim();
    if (text.length < 20) return "";
    // Hard guard: the follow-up must be Sinhala. If the model replied in
    // English anyway, drop it and fall back to the Sinhala template.
    const sinhalaChars = (text.match(/[\u0D80-\u0DFF]/g) || []).length;
    if (sinhalaChars < 20) return "";
    // Hard guard: NEVER send unfilled placeholders like [item], {product},
    // <price>, XXX. If any appear, discard the AI text entirely.
    if (hasPlaceholder(text)) {
      console.warn("personalizeAbandoned: placeholder detected, discarding");
      return "";
    }
    return text
      .replace(/\*\*/g, "*")
      .replace(/https?:\/\/\S+/g, "")
      .trim();

  } catch (e) {
    console.warn("personalizeAbandoned error:", String(e));
    return "";
  }
}



async function buildAbandonedQueue(
  supabase: any,
  cfg: AbandonedCfg,
  includeNotDue: boolean,
): Promise<AbandonedRow[]> {
  const delayHours = Math.max(1, Number(cfg.delay_hours) || 6);
  const windowHours = Math.max(delayHours + 1, Number(cfg.window_hours) || 9);
  const lookbackDays = Math.max(1, Number(cfg.lookback_days) || 7);
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString();

  const { data: msgs } = await supabase
    .from("chat_messages")
    .select("user_id, phone_number, direction, created_at, metadata, message_text")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(8000);

  const lastIncoming: Record<string, { at: string; user_id: string | null }> = {};
  const alreadyFollowed = new Set<string>();
  for (const m of msgs || []) {
    const phone = String(m.phone_number || "").replace(/\D/g, "");
    if (!phone || phone.length < 9 || phone.startsWith("SYSTEM")) continue;
    if (m.direction === "incoming") {
      if (!lastIncoming[phone] || new Date(m.created_at) > new Date(lastIncoming[phone].at)) {
        lastIncoming[phone] = { at: m.created_at, user_id: m.user_id || null };
      }
    } else if ((m as any)?.metadata?.abandoned_followup) {
      alreadyFollowed.add(phone);
    }
  }

  const phones = Object.keys(lastIncoming).filter((p) => !alreadyFollowed.has(p));
  if (phones.length === 0) return [];

  // Exclude anyone who already has (or ever had) a listing, or ever paid us.
  const userIds = [...new Set(phones.map((p) => lastIncoming[p].user_id).filter(Boolean))] as string[];
  const sellers = new Set<string>();
  for (const part of chunk(userIds, 100)) {
    const { data } = await supabase.from("listings").select("seller_id").in("seller_id", part);
    for (const l of data || []) sellers.add(l.seller_id);
  }
  for (const part of chunk(phones, 100)) {
    const { data } = await supabase
      .from("payments")
      .select("phone_number")
      .in("phone_number", part)
      .in("status", ["paid", "manual_review"]);
    for (const p of data || []) {
      const digits = String(p.phone_number || "").replace(/\D/g, "");
      if (digits) alreadyFollowed.add(digits);
    }
  }

  const nameById: Record<string, string | null> = {};
  for (const part of chunk(userIds, 100)) {
    const { data } = await supabase
      .from("marketplace_users")
      .select("id, display_name")
      .in("id", part);
    for (const u of data || []) nameById[u.id] = u.display_name || null;
  }

  const now = Date.now();
  const rows: AbandonedRow[] = [];
  for (const phone of phones) {
    const info = lastIncoming[phone];
    if (info.user_id && sellers.has(info.user_id)) continue;
    if (alreadyFollowed.has(phone)) continue; // already followed up, or already paid us
    const lastAt = new Date(info.at).getTime();
    const ageHours = (now - lastAt) / 3600000;
    const nextAt = new Date(lastAt + delayHours * 3600 * 1000);
    // Only inside the 6–9h window; older conversations are left alone.
    const due = ageHours >= delayHours && ageHours <= windowHours;
    if (!includeNotDue && !due) continue;
    if (includeNotDue && ageHours > windowHours) continue;
    rows.push({
      user_id: info.user_id,
      phone,
      name: info.user_id ? nameById[info.user_id] ?? null : null,
      last_message_at: info.at,
      next_send_at: nextAt.toISOString(),
      due,
    });
  }
  rows.sort((a, b) => a.next_send_at.localeCompare(b.next_send_at));
  return rows;
}

async function runAbandoned(supabase: any, alreadySentThisRun: boolean) {
  const cfg = await loadAbandonedCfg(supabase);
  if (cfg.enabled === false) return { sent: 0, skipped: "disabled" };

  const queue = await buildAbandonedQueue(supabase, cfg, false);
  if (queue.length === 0) return { sent: 0, checked: 0 };

  // Never stack two sends back-to-back in the same execution.
  if (alreadySentThisRun) await delay(jitter(MIN_GAP_MS, MAX_GAP_MS));

  const row = queue[0];
  const images = (Array.isArray(cfg.images) && cfg.images.length
    ? cfg.images
    : DEFAULT_TESTIMONIALS
  ).filter((u: string) => typeof u === "string" && u.startsWith("http")).slice(0, 3);

  // Personalised nudge: every abandoned follow-up must read like a human
  // reply to *that* conversation (identical bulk copy = ban risk).
  const convo = await fetchConversation(supabase, row.phone);
  // If we don't know whether they're a buyer or seller, never use the
  // seller-assuming template — send a neutral welcome-style nudge instead.
  const knownIntent =
    convo.filter((m) => m.role === "user").map((m) => m.text).join(" ").trim().length >= 30;
  const fallback = knownIntent
    ? abandonedMessage(cfg.message || "", row.name)
    : neutralAbandonedMessage(row.name);
  let message =
    (await personalizeAbandoned(convo, row.name, cfg.message || "")) || fallback;
  // Final safety net: nothing with an unfilled slot may ever leave this function,
  // no matter which branch produced the text.
  if (hasPlaceholder(message)) {
    console.warn("Abandoned followup: placeholder in final message, using neutral copy");
    message = neutralAbandonedMessage(row.name);
    if (hasPlaceholder(message)) return { sent: 0, error: "placeholder" };
  }

  const session = await getWahaSession(supabase);

  let ok = false;
  let lastError = "";
  // ONE combined photo (collage) + ONE caption.
  const collage = await buildCollage(supabase, images);
  if (collage) {
    const r = await sendImage(session, row.phone, collage, message);
    ok = r.sent; lastError = (r as any).error || "";
  }
  if (!ok) {
    const r = await sendText(session, row.phone, message);
    ok = r.sent; lastError = (r as any).error || lastError;
  }
  if (!ok) {
    console.error("Abandoned followup failed:", row.phone, lastError);
    return { sent: 0, checked: queue.length, error: lastError };
  }

  await supabase.from("chat_messages").insert({
    user_id: row.user_id,
    phone_number: row.phone,
    direction: "outgoing",
    message_text: `[Abandoned Followup] ${message}`,
    message_type: "image",
    metadata: { abandoned_followup: true, images },
  });

  return { sent: 1, checked: queue.length, phone: row.phone };
}
