// Notifies the 4 admin WhatsApp numbers when a listing payment is verified
// (either via OnePay card or via bank transfer / manual approval).
// Fire-and-forget from other edge functions; failures never block the caller.
//
// Sends via WAHA (primary) with Wasender token fallback — same pattern the
// rest of the bot uses. The old implementation read a "session key" from
// chat_messages and used it as a Wasender Bearer token, but that row actually
// holds the WAHA session id, so every send returned 401 silently.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { wasenderSendWithFallback } from "../_shared/whatsapp.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const WASENDER_SEND_API = "https://www.wasenderapi.com/api/send-message";
const WAHA_BASE_URL = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/+$/, "");
const WAHA_API_KEY = Deno.env.get("WAHA_API_KEY") || "";

const ADMIN_NUMBERS = [
  "94711365928", // Hasini Ranasinghe
  "94760032274", // Hasini Ranasinghe
  "94769652770", // Hasini Ranasinghe
  "94760159557", // Yasiru Bandara
];

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const method = String(body?.method || "unknown");
    const sellerPhone = String(body?.seller_phone || "").replace(/\D/g, "");
    const listingTitle = String(body?.listing_title || "");
    const amount = Number(body?.amount || 0);
    const reference = String(body?.reference || "");

    if (!sellerPhone) return json({ error: "seller_phone required" }, 400);

    const methodLabel =
      method === "card" || method === "onepay"
        ? "💳 Card Payment (OnePay)"
        : method === "bank_transfer" || method === "bank_slip"
          ? "🏦 Bank Transfer"
          : method === "manual"
            ? "🧾 Manual Approval (Bank Transfer)"
            : `❓ ${method}`;

    const text =
      `✅ *Payment Verified*\n\n` +
      `📱 Via: ${methodLabel}\n` +
      `👤 Seller: +${sellerPhone}\n` +
      (listingTitle ? `📝 Listing: ${listingTitle}\n` : "") +
      (amount ? `💰 Amount: LKR ${amount.toLocaleString()}\n` : "") +
      (reference ? `🔢 Ref: ${reference}\n` : "") +
      `\n_Listing is now live._`;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const results: any[] = [];
    for (const phone of ADMIN_NUMBERS) {
      const r = await sendWhatsAppMessage(supabase, phone, text);
      results.push({ phone, ...r });
      await new Promise((res) => setTimeout(res, 6000)); // 6s throttle
    }

    console.log("notify-admins-payment results:", JSON.stringify(results));
    return json({ success: true, results });
  } catch (e) {
    console.error("notify-admins-payment error:", e);
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
  const to = phone.startsWith("+") ? phone : `+${phone}`;
  return await wasenderSendWithFallback({ to, text });
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
