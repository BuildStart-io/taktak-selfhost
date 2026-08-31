// WAHA -> TakTak bridge webhook.
// Receives WAHA "message" events, normalizes into the Wasender payload
// shape, then forwards to the existing wasender-webhook so the bot logic
// stays a single codebase.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function extractPhone(from: string | undefined): string {
  if (!from) return "";
  // WAHA uses formats like "94769652770@c.us" or "94769652770@s.whatsapp.net"
  const bare = String(from).split("@")[0];
  return bare.replace(/\D/g, "");
}

// WAHA 2026.x (WEBJS engine) delivers privacy-mode senders as LIDs and no
// longer includes remoteJidAlt/senderPn in the payload. Resolve the real phone
// number through WAHA's Lids API: GET /api/{session}/lids/{lid} -> { lid, pn }.
const lidCache = new Map<string, string>();

function normalizeRealPhone(value: unknown): string {
  const raw = String(value || "");
  if (!raw || raw.endsWith("@lid")) return "";
  const digits = raw.split("@")[0].replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : "";
}

async function resolveLidToPhone(session: string, lid: string): Promise<string> {
  const key = `${session}:${lid}`;
  const cached = lidCache.get(key);
  if (cached) return cached;
  const base = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/+$/, "");
  const apiKey = Deno.env.get("WAHA_API_KEY") || "";
  if (!base) return "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(
        `${base}/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(lid)}`,
        { headers: { "X-Api-Key": apiKey, Accept: "application/json" }, signal: ctrl.signal },
      );
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const phone = normalizeRealPhone(data?.pn || data?.phoneNumber || data?.phone);
        if (phone) {
          lidCache.set(key, phone);
          return phone;
        }
      }
      console.warn("waha-webhook: lid lookup attempt failed", { lid, attempt, status: res.status });
    } catch (e) {
      console.warn("waha-webhook: lid lookup attempt error", { lid, attempt, error: String(e) });
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 400));
  }

  // WEBJS also exposes the real PN as the contact `id`, even when the
  // contact `number` is still the privacy LID. Use it if the Lids API is
  // temporarily unavailable or has not populated yet.
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(
      `${base}/api/${encodeURIComponent(session)}/contacts/${encodeURIComponent(`${lid}@lid`)}`,
      { headers: { "X-Api-Key": apiKey, Accept: "application/json" }, signal: ctrl.signal },
    );
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const phone = normalizeRealPhone(data?.id || data?.pn || data?.phoneNumber);
      if (phone) {
        lidCache.set(key, phone);
        console.log("waha-webhook: resolved lid through contact fallback", lid);
        return phone;
      }
    }
  } catch (e) {
    console.warn("waha-webhook: contact fallback error", { lid, error: String(e) });
  }
  return "";
}

function getWahaImageMessage(p: any, caption: string, replyJid: string) {
  const media = p?.media || null;
  const dataMessage = p?._data?.message || {};
  const rawImageMessage =
    dataMessage?.imageMessage ||
    dataMessage?.viewOnceMessage?.message?.imageMessage ||
    dataMessage?.viewOnceMessageV2?.message?.imageMessage ||
    dataMessage?.documentWithCaptionMessage?.message?.documentMessage ||
    dataMessage?.documentMessage ||
    null;

  const mimetype = media?.mimetype || rawImageMessage?.mimetype || "";
  const hasRawImage = Boolean(
    dataMessage?.imageMessage ||
    dataMessage?.viewOnceMessage?.message?.imageMessage ||
    dataMessage?.viewOnceMessageV2?.message?.imageMessage,
  );
  const hasImageDocument = Boolean(rawImageMessage) && mimetype.startsWith("image/");
  const isImage = hasRawImage || hasImageDocument || (Boolean(p?.hasMedia) && mimetype.startsWith("image/"));

  if (!isImage) return null;

  return {
    ...(rawImageMessage || {}),
    caption,
    url: media?.url || rawImageMessage?.url || "",
    mimetype: mimetype || "image/jpeg",
    fileSha256: rawImageMessage?.fileSha256,
    fileLength: rawImageMessage?.fileLength,
    mediaKey: rawImageMessage?.mediaKey,
    _wahaDirect: true,
    _wahaMediaUrl: media?.url || null,
    _wahaMessageId: p?.id || null,
    _wahaChatId: replyJid,
    _wahaFilename: media?.filename || null,
    _wahaMediaError: media?.error || null,
  };
}

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const raw = await req.json().catch(() => ({}));
    console.log("waha-webhook received:", JSON.stringify(raw).slice(0, 800));

    // WAHA payload shape (message event):
    // { event: "message", session: "default", payload: { id, from, fromMe, body, hasMedia, ... } }
    const event = raw?.event || "";
    const session = raw?.session || "default";
    const p = raw?.payload || {};

    // Session lifecycle events: keep the dashboard in sync and revive dead sessions.
    if (event === "session.status" || event === "session.state") {
      const state = String(p?.status || p?.state || raw?.status || "").toUpperCase();
      console.log("waha-webhook session status", session, state);
      try {
        const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
        const dbStatus =
          state === "WORKING" ? "connected"
            : state === "STOPPED" || state === "FAILED" ? "disconnected"
              : "connecting";
        await fetch(`${supabaseUrl}/rest/v1/waha_sessions?waha_session_id=eq.${encodeURIComponent(session)}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ status: dbStatus, updated_at: new Date().toISOString() }),
        });

        if (state === "STOPPED" || state === "FAILED") {
          const wahaBase = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/+$/, "");
          await fetch(`${wahaBase}/api/sessions/${encodeURIComponent(session)}/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Api-Key": Deno.env.get("WAHA_API_KEY") || "" },
          });
          console.log("waha-webhook: auto-restarted session", session);
        }
      } catch (e) {
        console.error("waha-webhook: session.status handling failed", e);
      }
      return new Response(JSON.stringify({ ok: true, handled: "session.status" }), { headers: jsonHeaders });
    }

    if (!event.startsWith("message") || p?.fromMe) {
      return new Response(JSON.stringify({ ignored: true }), { headers: jsonHeaders });
    }

    // Ignore group chats and status updates
    const from: string = p?.from || "";
    if (!from || from.endsWith("@g.us") || from.includes("status")) {
      return new Response(JSON.stringify({ ignored: true }), { headers: jsonHeaders });
    }

    // Privacy-mode contacts arrive as LIDs (e.g. 131941596667956@lid) whose
    // digits are NOT the real phone. Older WAHA builds exposed the phone in
    // _data.key.remoteJidAlt / senderPn; newer ones (2026.x WEBJS) do not, so
    // fall back to WAHA's Lids API to map the LID back to the phone number.
    const payloadPhone = normalizeRealPhone(
      p?._data?.key?.remoteJidAlt ||
        p?._data?.key?.senderPn ||
        p?.senderPn ||
        p?.remoteJidAlt ||
        p?.authorPn ||
        p?._data?.senderPn ||
        p?._data?.authorPn ||
        p?._data?.author,
    );
    let remoteJidAlt = payloadPhone ? `${payloadPhone}@c.us` : "";
    const isLid = from.endsWith("@lid");
    if (isLid && !remoteJidAlt) {
      const resolved = await resolveLidToPhone(session, from.split("@")[0]);
      if (resolved) {
        remoteJidAlt = `${resolved}@c.us`;
        console.log("waha-webhook: resolved lid", from, "->", remoteJidAlt);
      }
    }
    const phoneSource = isLid && remoteJidAlt ? remoteJidAlt : from;
    const phone = extractPhone(phoneSource);
    if (!phone || (isLid && !remoteJidAlt)) {
      console.log("waha-webhook: could not resolve real phone for lid", { from, remoteJidAlt });
      return new Response(JSON.stringify({ ignored: true, reason: "unresolved_lid" }), { headers: jsonHeaders });
    }
    // Route replies back to the real number when known.
    const replyJid = isLid && remoteJidAlt ? remoteJidAlt : from;

    const text: string = p?.body || p?.text || "";

    // Detect PDFs (payment slips sent as documents). Never download/store — just
    // ask the sender to resend as a screenshot.
    const dataMessage = p?._data?.message || {};
    const docMsg =
      dataMessage?.documentMessage ||
      dataMessage?.documentWithCaptionMessage?.message?.documentMessage ||
      null;
    const docMime: string =
      p?.media?.mimetype || docMsg?.mimetype || "";
    const docName: string =
      p?.media?.filename || docMsg?.fileName || docMsg?.title || "";
    const isPdf =
      docMime.toLowerCase().includes("pdf") ||
      /\.pdf($|\?)/i.test(docName) ||
      /\.pdf($|\?)/i.test(String(p?.media?.url || ""));

    if (isPdf) {
      console.log("waha-webhook: PDF detected, asking for screenshot", { phone, docName, docMime });
      const wahaBase = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/$/, "");
      const wahaKey = Deno.env.get("WAHA_API_KEY") || "";
      const reply =
        "🙏 ස්තූතියි! ඔබ එවා ඇත්තේ PDF ගොනුවක්. කරුණාකර *bank slip එකේ screenshot එකක් (image එකක්)* එවන්න — එවිට අපට ඉක්මනින් verify කර ගන්න පුළුවන්. 📸\n\n" +
        "🙏 Thanks! You sent a PDF. Please send a *screenshot (image)* of the bank slip instead so we can verify it quickly. 📸";
      try {
        await fetch(`${wahaBase}/api/sendText`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": wahaKey,
          },
          body: JSON.stringify({ session, chatId: replyJid, text: reply }),
        });
      } catch (e) {
        console.error("waha-webhook: failed to send PDF reply", e);
      }
      return new Response(
        JSON.stringify({ ok: true, ignored: "pdf", asked_for_screenshot: true }),
        { headers: jsonHeaders },
      );
    }

    const imageMessage = getWahaImageMessage(p, text, replyJid);


    // Translate into the Wasender webhook shape that wasender-webhook expects.
    const wasenderPayload = {
      event: "messages.received",
      // Prefix with waha: so downstream storeSessionKey can distinguish provider.
      sessionId: `waha:${session}`,
      data: {
        messages: {
          key: {
            remoteJid: replyJid,
            remoteJidAlt: remoteJidAlt || undefined,
            cleanedSenderPn: phone,
            fromMe: false,
            id: p?.id || `waha-${Date.now()}`,
          },
          message: imageMessage ? { imageMessage } : { conversation: text },
          messageTimestamp: p?.timestamp || Math.floor(Date.now() / 1000),
          pushName: p?.notifyName || p?._data?.notifyName || null,
        },
      },
      _via: "waha",
    };

    const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const forwardUrl = `${supabaseUrl}/functions/v1/wasender-webhook-taktak`;

    const forwarded = await fetch(forwardUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify(wasenderPayload),
    });
    const fwdText = await forwarded.text();
    console.log("forward status", forwarded.status, fwdText.slice(0, 300));

    return new Response(
      JSON.stringify({ ok: true, forwarded_status: forwarded.status }),
      { headers: jsonHeaders },
    );
  } catch (err) {
    console.error("waha-webhook error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: jsonHeaders });
  }
}
