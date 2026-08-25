import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const WASENDER_SEND_API = "https://www.wasenderapi.com/api/send-message";
const WAHA_BASE_URL = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/+$/, "");
const WAHA_API_KEY = Deno.env.get("WAHA_API_KEY") || "";

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { phone_number } = await req.json();
    if (!phone_number) {
      return jsonResponse({ error: "Phone number required", code: "MISSING_PHONE" }, 400);
    }

    const cleanPhone = String(phone_number).replace(/\D/g, "");
    if (cleanPhone.length < 10 || cleanPhone.length > 13) {
      return jsonResponse({ error: "Invalid phone number.", code: "INVALID_PHONE" }, 400);
    }

    // Verify this phone has an account with at least one listing.
    // Use maybeSingle so duplicate rows never throw a 500.
    const { data: users, error: userErr } = await supabase
      .from("marketplace_users")
      .select("id")
      .eq("phone_number", cleanPhone)
      .limit(1);

    if (userErr) {
      console.error("marketplace_users lookup error:", userErr);
      return jsonResponse({ error: "Lookup failed. Please try again.", code: "LOOKUP_FAILED" }, 500);
    }

    const user = users?.[0];
    if (!user) {
      return jsonResponse({ error: "No account found for this number. Please list a product first by messaging our WhatsApp bot at +94771100789.", code: "NO_ACCOUNT" }, 404);
    }

    // NOTE: Having a listing is NOT required. Users without listings can log in
    // to manage their payout/bank account and view their referral balance.


    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString(); // 3 minutes

    // Insert the NEW OTP first. If insert fails, keep any existing OTP valid
    // so the seller isn't locked out with no code at all.
    const { data: inserted, error: insertErr } = await supabase
      .from("seller_otps")
      .insert({ phone_number: cleanPhone, otp_code: otp, expires_at: expiresAt })
      .select("id")
      .single();

    if (insertErr || !inserted) {
      console.error("seller_otps insert failed:", insertErr);
      return jsonResponse({ error: "Couldn't create OTP. Please try again.", code: "OTP_INSERT_FAILED" }, 500);
    }

    // Send via WhatsApp. Try @c.us first, then @lid fallback for LID-migrated numbers.
    const message = `🔐 Your TakTak AI Marketplace seller dashboard OTP is: *${otp}*\n\nThis code expires in 3 minutes.\n\n⚠️ Do not share this code with anyone.`;
    const sendResult = await sendOtpMessage(supabase, cleanPhone, message, inserted.id);

    if (!sendResult.ok) {
      console.error("OTP send failed for", cleanPhone, sendResult.error);
      // Roll back the OTP row we just created so it can't be brute-forced later.
      await supabase.from("seller_otps").update({ used: true }).eq("id", inserted.id);
      const notOnWhatsApp = /not.*whatsapp|not.*registered|no.*such|404/i.test(sendResult.error || "");
      return jsonResponse({
        error: notOnWhatsApp
          ? "This number doesn't appear to be on WhatsApp."
          : "Couldn't send OTP via WhatsApp right now. Please try again in a moment.",
        code: notOnWhatsApp ? "NOT_ON_WHATSAPP" : "SEND_FAILED",
      }, notOnWhatsApp ? 400 : 503);
    }

    // Success — invalidate any older, still-active OTPs so only the new one works.
    await supabase
      .from("seller_otps")
      .update({ used: true })
      .eq("phone_number", cleanPhone)
      .eq("used", false)
      .neq("id", inserted.id);

    return jsonResponse({ success: true, message: "OTP sent to your WhatsApp" });
  } catch (error: any) {
    console.error("Send OTP error:", error);
    return jsonResponse({ error: "Unexpected error. Please try again.", code: "UNEXPECTED" }, 500);
  }
}

async function logAttempt(
  supabase: any,
  phone: string,
  otpId: string,
  provider: string,
  chatId: string | null,
  status: "sent" | "failed",
  httpStatus: number | null,
  error: string | null,
) {
  try {
    await supabase.from("seller_otp_log").insert({
      phone_number: phone,
      otp_id: otpId,
      provider,
      chat_id: chatId,
      status,
      http_status: httpStatus,
      error,
    });
  } catch (e) {
    console.error("seller_otp_log insert failed:", e);
  }
}

async function sha512Hex(value: string) {
  const buf = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function wahaFetch(path: string, init: RequestInit = {}) {
  if (!WAHA_BASE_URL) return new Response("WAHA_BASE_URL missing", { status: 500 });
  const url = `${WAHA_BASE_URL}${path}`;
  const raw = WAHA_API_KEY.trim();
  const keys = raw ? Array.from(new Set([raw, await sha512Hex(raw)])) : [""];
  const strategies = [
    (h: Headers, k: string) => h.set("X-Api-Key", k),
    (h: Headers, k: string) => h.set("Authorization", `Bearer ${k}`),
    (h: Headers, k: string) => h.set("Api-Key", k),
  ];
  let lastRes: Response | null = null;
  for (const k of keys) {
    for (const apply of strategies) {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      apply(headers, k);
      const res = await fetch(url, { ...init, headers });
      if (res.status !== 401) return res;
      lastRes = res;
    }
  }
  return lastRes ?? new Response("Unauthorized", { status: 401 });
}

async function sendViaWahaChatId(session: string, chatId: string, text: string) {
  const res = await wahaFetch("/api/sendText", {
    method: "POST",
    body: JSON.stringify({ session, chatId, text }),
  });
  const bodyText = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false as const, status: res.status, error: `WAHA ${res.status}: ${bodyText.slice(0, 200)}` };
  }
  return { ok: true as const, status: res.status };
}

async function sendViaWasender(sessionKey: string, phone: string, text: string) {
  const to = phone.startsWith("+") ? phone : `+${phone}`;
  const res = await fetch(WASENDER_SEND_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to, text }),
  });
  const bodyText = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false as const, status: res.status, error: `Wasender ${res.status}: ${bodyText.slice(0, 200)}` };
  }
  return { ok: true as const, status: res.status };
}

async function sendOtpMessage(
  supabase: any,
  phone: string,
  text: string,
  otpId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data: keys } = await supabase
    .from("chat_messages")
    .select("message_text, created_at")
    .eq("phone_number", "SYSTEM_SESSION_KEY")
    .order("created_at", { ascending: false })
    .limit(5);

  const list: string[] = (keys || []).map((r: any) => r.message_text).filter(Boolean);
  if (list.length === 0) {
    await logAttempt(supabase, phone, otpId, "none", null, "failed", null, "No WhatsApp session key configured");
    return { ok: false, error: "No WhatsApp session key configured" };
  }

  const uniq = Array.from(new Set(list));
  uniq.sort((a, b) => Number(b.startsWith("waha:")) - Number(a.startsWith("waha:")));

  let lastError = "";
  for (const key of uniq) {
    if (key.startsWith("waha:")) {
      const session = key.replace(/^waha:/, "").split(":")[0] || "default";
      // Try @c.us first, then @lid fallback (numbers migrated to LID-only).
      const digits = phone.replace(/\D/g, "");
      const chatIds = digits.length > 13
        ? [`${digits}@lid`, `${digits}@c.us`]
        : [`${digits}@c.us`, `${digits}@lid`];
      for (const chatId of chatIds) {
        const r = await sendViaWahaChatId(session, chatId, text);
        await logAttempt(supabase, phone, otpId, "waha", chatId, r.ok ? "sent" : "failed", r.status, r.ok ? null : r.error);
        if (r.ok) {
          console.log("OTP sent via WAHA to", chatId);
          return { ok: true };
        }
        lastError = r.error;
      }
    } else {
      const r = await sendViaWasender(key, phone, text);
      await logAttempt(supabase, phone, otpId, "wasender", phone, r.ok ? "sent" : "failed", r.status, r.ok ? null : r.error);
      if (r.ok) {
        console.log("OTP sent via Wasender");
        return { ok: true };
      }
      lastError = r.error;
    }
  }
  return { ok: false, error: lastError };
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
