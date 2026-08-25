// Shared, provider-aware WhatsApp sender.
//
// Why this exists: the project sends through TWO providers — Wasender (cloud API,
// bearer session key) and WAHA (self-hosted, key prefixed with "waha:"). The
// session keys of BOTH providers are stored in chat_messages rows with
// phone_number = 'SYSTEM_SESSION_KEY'. Callers used to grab an arbitrary row and
// blindly POST it to the Wasender API, which silently fails with
// "invalid API key" whenever the row happened to hold a WAHA key.
//
// This module resolves every known key, dispatches to the right provider,
// honours Wasender's 429 rate limit (1 msg / 5s) with a retry, and falls back
// to the other provider if the first one refuses.

const WASENDER_SEND_API = "https://www.wasenderapi.com/api/send-message";
const WAHA_BASE_URL = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/+$/, "");
const WAHA_API_KEY = Deno.env.get("WAHA_API_KEY") || "";

export type SendResult = { sent: boolean; provider: string; status?: number; error?: string };

export const isWahaKey = (key: string) => key.startsWith("waha:");
export const wahaSessionName = (key: string) => key.replace(/^waha:/, "").split(":")[0] || "default";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function wahaChatIdFor(phone: string) {
  const digits = String(phone).replace(/\D/g, "");
  // >13 digits means a privacy LID, not a real MSISDN.
  return digits.length > 13 ? `${digits}@lid` : `${digits}@c.us`;
}

async function sha512Hex(value: string) {
  const buf = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function wahaKeyCandidates() {
  const raw = WAHA_API_KEY.trim();
  if (!raw) return [];
  return Array.from(new Set([raw, await sha512Hex(raw)]));
}

export async function wahaFetch(path: string, init: RequestInit = {}) {
  const url = path.startsWith("http") ? path : `${WAHA_BASE_URL}${path}`;
  const base = new Headers(init.headers);
  if (!base.has("Accept")) base.set("Accept", "application/json");
  if (init.body && !base.has("Content-Type")) base.set("Content-Type", "application/json");

  let last = "Unauthorized";
  for (const key of await wahaKeyCandidates()) {
    for (const apply of [
      (h: Headers) => h.set("X-Api-Key", key),
      (h: Headers) => h.set("Authorization", `Bearer ${key}`),
      (h: Headers) => h.set("Api-Key", key),
    ]) {
      const headers = new Headers(base);
      headers.delete("X-Api-Key");
      headers.delete("Api-Key");
      headers.delete("Authorization");
      apply(headers);
      const res = await fetch(url, { ...init, headers });
      if (res.status !== 401) return res;
      last = await res.text().catch(() => "Unauthorized");
    }
  }
  return new Response(last, { status: 401 });
}

/**
 * All known session keys, most recently active first.
 * Wasender keys and WAHA keys are both returned; callers should not care.
 */
export async function resolveSessionKeys(supabase: any): Promise<string[]> {
  const { data } = await supabase
    .from("chat_messages")
    .select("message_text, metadata, created_at")
    .eq("phone_number", "SYSTEM_SESSION_KEY")
    .limit(20);

  const rows = (data || [])
    .filter((r: any) => typeof r.message_text === "string" && r.message_text.trim())
    .map((r: any) => ({
      key: r.message_text.trim(),
      at: new Date(r?.metadata?.updated_at || r.created_at || 0).getTime(),
    }))
    .sort((a: any, b: any) => b.at - a.at);

  // Wasender is the PRIMARY provider (WAHA is currently disabled), so Wasender
  // keys are always tried first; WAHA keys stay only as a last-resort fallback.
  const keys = Array.from(new Set(rows.map((r: any) => r.key))).sort(
    (a: any, b: any) => Number(isWahaKey(a)) - Number(isWahaKey(b)),
  ) as string[];

  // Env token is a Wasender credential — insert it before any WAHA key.
  const envToken = Deno.env.get("WASENDER_API_TOKEN") || Deno.env.get("WASENDER_PERSONAL_ACCESS_TOKEN") || "";
  if (envToken && !keys.includes(envToken)) {
    const firstWaha = keys.findIndex((k) => isWahaKey(k));
    if (firstWaha === -1) keys.push(envToken);
    else keys.splice(firstWaha, 0, envToken);
  }
  return keys;
}

async function wasenderPost(sessionKey: string, body: Record<string, unknown>): Promise<SendResult> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(WASENDER_SEND_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { sent: true, provider: "wasender", status: res.status };

    const errText = await res.text().catch(() => `${res.status}`);
    if (res.status === 429 && attempt < 3) {
      let waitMs = 6000;
      try {
        const parsed = JSON.parse(errText);
        if (parsed?.retry_after) waitMs = Math.max(1000, Number(parsed.retry_after) * 1000 + 1000);
      } catch { /* keep default */ }
      console.log(`Wasender 429, retrying in ${waitMs}ms (attempt ${attempt})`);
      await sleep(waitMs);
      continue;
    }
    console.error("Wasender send error:", res.status, errText);
    return { sent: false, provider: "wasender", status: res.status, error: errText };
  }
  return { sent: false, provider: "wasender", error: "rate limited" };
}

async function wahaPost(sessionKey: string, path: string, body: Record<string, unknown>): Promise<SendResult> {
  if (!WAHA_BASE_URL) return { sent: false, provider: "waha", error: "WAHA not configured" };
  const payload = { session: wahaSessionName(sessionKey), ...body };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await wahaFetch(path, { method: "POST", body: JSON.stringify(payload) });
    if (res.ok) return { sent: true, provider: "waha", status: res.status };
    const errText = await res.text().catch(() => `${res.status}`);
    if (res.status === 429 && attempt < 2) {
      await sleep(6000);
      continue;
    }
    console.error("WAHA send error:", res.status, errText);
    return { sent: false, provider: "waha", status: res.status, error: errText };
  }
  return { sent: false, provider: "waha", error: "rate limited" };
}

async function sendWithKey(key: string, phone: string, text: string, imageUrl?: string | null): Promise<SendResult> {
  if (isWahaKey(key)) {
    const chatId = wahaChatIdFor(phone);
    return imageUrl
      ? await wahaPost(key, "/api/sendImage", { chatId, file: { url: imageUrl }, caption: text })
      : await wahaPost(key, "/api/sendText", { chatId, text });
  }
  const to = phone.startsWith("+") ? phone : `+${phone}`;
  return await wasenderPost(key, imageUrl ? { to, text, imageUrl } : { to, text });
}

/**
 * Show the "typing…" (or "paused") indicator in the user's chat.
 * Best-effort: never throws, never blocks the reply path.
 * Wasender: POST /api/send-presence-update { jid, type }
 * WAHA:     POST /api/startTyping | /api/stopTyping
 */
export async function sendTypingIndicator(
  sessionKey: string | null | undefined,
  phone: string,
  state: "composing" | "paused" = "composing",
): Promise<void> {
  try {
    const key = sessionKey || "";
    if (!key) return;
    if (isWahaKey(key)) {
      await wahaPost(key, state === "composing" ? "/api/startTyping" : "/api/stopTyping", {
        chatId: wahaChatIdFor(phone),
      });
      return;
    }
    const digits = String(phone).replace(/\D/g, "");
    if (!digits) return;
    // Presence is cosmetic and Wasender occasionally leaves this request open.
    // Never let it hold the inbound webhook before the actual reply is generated.
    const response = await fetch("https://www.wasenderapi.com/api/send-presence-update", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jid: `${digits}@s.whatsapp.net`, type: state }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      console.log("typing indicator rejected:", response.status);
    }
  } catch (e) {
    console.log("typing indicator skipped:", String(e));
  }
}

/** Send text, trying every known session key (most recent provider first). */
export async function sendWhatsAppText(supabase: any, phone: string, text: string): Promise<SendResult> {
  const keys = await resolveSessionKeys(supabase);
  if (keys.length === 0) return { sent: false, provider: "none", error: "no session key configured" };
  let last: SendResult = { sent: false, provider: "none", error: "no attempt" };
  for (const key of keys) {
    last = await sendWithKey(key, phone, text);
    if (last.sent) return last;
  }
  return last;
}

/** Send an image with caption, trying every known session key. */
export async function sendWhatsAppImage(
  supabase: any,
  phone: string,
  imageUrl: string,
  caption: string,
): Promise<SendResult> {
  const keys = await resolveSessionKeys(supabase);
  if (keys.length === 0) return { sent: false, provider: "none", error: "no session key configured" };
  let last: SendResult = { sent: false, provider: "none", error: "no attempt" };
  for (const key of keys) {
    last = await sendWithKey(key, phone, caption, imageUrl);
    if (last.sent) return last;
  }
  // Last resort: send the caption + link as plain text so the user still gets it.
  const fallback = await sendWhatsAppText(supabase, phone, `${caption}\n${imageUrl}`);
  return fallback.sent ? fallback : last;
}

// ── Token-based Wasender send (for functions without a stored key context) ──
// The env WASENDER_API_TOKEN can go stale ("invalid API key"); the live session
// key captured from inbound webhooks is the reliable one. Try both, with 429
// retries so account-protection throttling never drops a message.
let cachedDbWasenderKey: string | null | undefined;

async function dbWasenderKey(): Promise<string | null> {
  if (cachedDbWasenderKey !== undefined) return cachedDbWasenderKey;
  cachedDbWasenderKey = null;
  try {
    const url = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!url || !key) return null;
    const res = await fetch(
      `${url}/rest/v1/chat_messages?phone_number=eq.SYSTEM_SESSION_KEY&select=message_text,metadata,created_at&limit=20`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    const wasender = (rows || [])
      .filter((r: any) => typeof r.message_text === "string" && r.message_text.trim() && !r.message_text.startsWith("waha:"))
      .sort((a: any, b: any) =>
        new Date(b?.metadata?.updated_at || b.created_at || 0).getTime() -
        new Date(a?.metadata?.updated_at || a.created_at || 0).getTime());
    cachedDbWasenderKey = wasender[0]?.message_text?.trim() || null;
  } catch (e) {
    console.warn("dbWasenderKey lookup failed", String(e));
  }
  return cachedDbWasenderKey;
}

export async function wasenderSendWithFallback(body: Record<string, unknown>): Promise<SendResult> {
  const envToken = Deno.env.get("WASENDER_API_TOKEN") || Deno.env.get("WASENDER_PERSONAL_ACCESS_TOKEN") || "";
  const tokens = Array.from(new Set([envToken, await dbWasenderKey()].filter(Boolean) as string[]));
  if (tokens.length === 0) return { sent: false, provider: "wasender", error: "wasender not configured" };
  let last: SendResult = { sent: false, provider: "wasender", error: "no attempt" };
  for (const token of tokens) {
    last = await wasenderPost(token, body);
    if (last.sent) return last;
  }
  return last;
}
