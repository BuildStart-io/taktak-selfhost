import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const WAHA_BASE_URL = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/$/, "");
const WAHA_API_KEY = Deno.env.get("WAHA_API_KEY") || "";

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

async function safe(res: Response) {
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, body: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, body: text.substring(0, 500) };
  }
}

async function sha512Hex(value: string) {
  const hashBuffer = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function wahaApiKeyCandidates() {
  const raw = WAHA_API_KEY.trim();
  if (!raw) return [];
  const hashed = await sha512Hex(raw);
  return Array.from(new Set([raw, hashed]));
}

async function wahaFetch(path: string, init: RequestInit = {}) {
  const url = path.startsWith("http") ? path : `${WAHA_BASE_URL}${path}`;
  const baseHeaders = new Headers(init.headers);
  if (!baseHeaders.has("Accept")) baseHeaders.set("Accept", "application/json");
  if (init.body && !baseHeaders.has("Content-Type")) baseHeaders.set("Content-Type", "application/json");

  let lastUnauthorized: { ok: boolean; status: number; body: unknown } | null = null;
  const keyCandidates = await wahaApiKeyCandidates();
  const authStrategies = [
    (headers: Headers, key: string) => headers.set("X-Api-Key", key),
    (headers: Headers, key: string) => headers.set("Authorization", `Bearer ${key}`),
    (headers: Headers, key: string) => headers.set("Api-Key", key),
  ];

  for (const key of keyCandidates) {
    for (const applyAuth of authStrategies) {
      const headers = new Headers(baseHeaders);
      headers.delete("X-Api-Key");
      headers.delete("x-api-key");
      headers.delete("Api-Key");
      headers.delete("Authorization");
      applyAuth(headers, key);

      const res = await fetch(url, { ...init, headers });
      if (res.status !== 401) return res;
      lastUnauthorized = await safe(res);
    }
  }

  return new Response(JSON.stringify(lastUnauthorized?.body ?? { message: "Unauthorized", statusCode: 401 }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function isMissingSession(status: number, body: unknown) {
  const msg = JSON.stringify(body || "").toLowerCase();
  return status === 404 || msg.includes("does not exist") || msg.includes("not found");
}

function sessionWebhookConfig() {
  let supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
  if (supabaseUrl === "http://api-gw:8000") supabaseUrl = "https://supabase2.buildstart.io";
  const hookUrl = `${supabaseUrl}/functions/v1/waha-webhook-taktak`;
  return hookUrl ? [{ url: hookUrl, events: ["message", "session.status"], retries: { policy: "linear", delaySeconds: 2, attempts: 5 } }] : [];
}

async function createAndStartSession(session: string) {
  const createRes = await wahaFetch(`/api/sessions`, {
    method: "POST",
    body: JSON.stringify({
      name: session,
      start: true,
      config: { webhooks: sessionWebhookConfig() },
    }),
  });
  return await safe(createRes);
}

async function recreateFailedSession(session: string) {
  const enc = encodeURIComponent(session);
  await wahaFetch(`/api/sessions/${enc}/stop`, { method: "POST" }).catch(() => {});
  await wahaFetch(`/api/sessions/${enc}`, { method: "DELETE" }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return await createAndStartSession(session);
}

async function ensureSessionStarted(session: string) {
  const enc = encodeURIComponent(session);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const hookUrl = `${supabaseUrl}/functions/v1/waha-webhook-taktak`;

  const infoRes = await wahaFetch(`/api/sessions/${enc}`);
  const info = await safe(infoRes);

  if (isMissingSession(info.status, info.body)) {
    const created = await createAndStartSession(session);
    if (!created.ok && !String(JSON.stringify(created.body)).toLowerCase().includes("already")) {
      return created;
    }
    return { ok: true, status: 200, body: { message: "Session created", created: created.body } };
  }

  const currentStatus = String((info.body as any)?.status || "").toUpperCase();
  if (currentStatus === "FAILED") {
    const recreated = await recreateFailedSession(session);
    if (!recreated.ok) return recreated;
    return { ok: true, status: 200, body: { message: "Failed session recreated", recreated: recreated.body } };
  }

  // Session exists — make sure webhook is registered
  try {
    const existingConfig = (info.body as any)?.config || {};
    const others = (existingConfig.webhooks || []).filter((w: any) => w?.url !== hookUrl);
    if (hookUrl && (others.length !== (existingConfig.webhooks || []).length - 1 || !(existingConfig.webhooks || []).some((w: any) => w?.url === hookUrl))) {
      await wahaFetch(`/api/sessions/${enc}`, {
        method: "PUT",
        body: JSON.stringify({
          config: { ...existingConfig, webhooks: [...others, { url: hookUrl, events: ["message", "session.status"] }] },
        }),
      }).catch(() => {});
    }
  } catch (_e) { /* ignore */ }

  const startRes = await wahaFetch(`/api/sessions/${enc}/start`, {
    method: "POST",
  });
  const started = await safe(startRes);
  if (!startRes.ok && !String(JSON.stringify(started.body)).toLowerCase().includes("already")) {
    return started;
  }
  return { ok: true, status: 200, body: { message: "Session ready", session: info.body } };
}

function qrBodyFromStatus(session: string, status: string, body: unknown) {
  return {
    error: status === "STARTING"
      ? "WAHA session is still STARTING. QR is only available when the session reaches SCAN_QR_CODE. Use Force QR if this session is stuck."
      : "QR is not available for the current session state.",
    session,
    status,
    expected: ["SCAN_QR_CODE"],
    details: body,
  };
}

async function fetchQr(session: string, enc: string) {
  const res = await wahaFetch(`/api/${enc}/auth/qr?format=image`);
  if (!res.ok) return { ok: false, status: res.status, body: (await safe(res)).body };

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const r = await safe(res);
    const mime = (r.body as any)?.mimetype || "image/png";
    const raw = (r.body as any)?.qr || (r.body as any)?.value || (r.body as any)?.data;
    if (raw) (r.body as any).qr = String(raw).startsWith("data:") ? raw : `data:${mime};base64,${raw}`;
    return r;
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return { ok: true, status: 200, body: { qr: `data:${ct || "image/png"};base64,${btoa(bin)}` } };
}

async function waitForQrStatus(session: string, enc: string) {
  let last: { ok: boolean; status: number; body: unknown } | null = null;
  for (let i = 0; i < 12; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2500));
    const infoRes = await wahaFetch(`/api/sessions/${enc}`);
    const info = await safe(infoRes);
    last = info;
    const status = String((info.body as any)?.status || "").toUpperCase();
    if (status === "SCAN_QR_CODE") return { ready: true, info };
    if (status === "WORKING") return { ready: false, info, reason: "already_connected" };
  }
  const status = String((last?.body as any)?.status || "UNKNOWN").toUpperCase();
  return { ready: false, info: last, reason: status === "STARTING" ? "stuck_starting" : "not_ready" };
}


export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: jsonHeaders });
    }

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers: jsonHeaders });
    }

    if (!WAHA_BASE_URL || !WAHA_API_KEY) {
      return new Response(
        JSON.stringify({ error: "WAHA_BASE_URL or WAHA_API_KEY not configured" }),
        { status: 500, headers: jsonHeaders },
      );
    }

    const body = await req.json().catch(() => ({}));
    const action: string = body.action || "ping";
    const session: string = body.session || "default";
    const enc = encodeURIComponent(session);

    if (action === "ping") {
      const res = await wahaFetch(`/api/sessions`);
      const r = await safe(res);
      return new Response(
        JSON.stringify({ base_url: WAHA_BASE_URL, reachable: r.ok, status: r.status, sessions: r.body }),
        { headers: jsonHeaders },
      );
    }

    if (action === "list_sessions") {
      const res = await wahaFetch(`/api/sessions`);
      return new Response(JSON.stringify(await safe(res)), { headers: jsonHeaders });
    }

    if (action === "session_info") {
      const res = await wahaFetch(`/api/sessions/${enc}`);
      return new Response(JSON.stringify(await safe(res)), { headers: jsonHeaders });
    }

    if (action === "start_session") {
      const r = await ensureSessionStarted(session);
      return new Response(JSON.stringify(r), { headers: jsonHeaders });
    }

    if (action === "stop_session") {
      const res = await wahaFetch(`/api/sessions/${enc}/stop`, { method: "POST" });
      return new Response(JSON.stringify(await safe(res)), { headers: jsonHeaders });
    }

    if (action === "logout_session") {
      const res = await wahaFetch(`/api/sessions/${enc}/logout`, { method: "POST" });
      return new Response(JSON.stringify(await safe(res)), { headers: jsonHeaders });
    }

    if (action === "restart_session") {
      await wahaFetch(`/api/sessions/${enc}/stop`, { method: "POST" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      const res = await wahaFetch(`/api/sessions/${enc}/start`, { method: "POST" });
      return new Response(JSON.stringify(await safe(res)), { headers: jsonHeaders });
    }

    if (action === "qr") {
      const ready = await ensureSessionStarted(session);
      if (!ready.ok) return new Response(JSON.stringify(ready), { headers: jsonHeaders });

      const waited = await waitForQrStatus(session, enc);
      if (!waited.ready) {
        const status = String((waited.info?.body as any)?.status || "UNKNOWN").toUpperCase();
        return new Response(
          JSON.stringify({ ok: false, status: 409, body: qrBodyFromStatus(session, status, waited.info?.body), reason: waited.reason }),
          { headers: jsonHeaders },
        );
      }

      const qr = await fetchQr(session, enc);
      return new Response(JSON.stringify(qr), { headers: jsonHeaders });
    }

    if (action === "force_qr") {
      await wahaFetch(`/api/sessions/${enc}/logout`, { method: "POST" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      await ensureSessionStarted(session);

      const waited = await waitForQrStatus(session, enc);
      if (!waited.ready) {
        const status = String((waited.info?.body as any)?.status || "UNKNOWN").toUpperCase();
        return new Response(
          JSON.stringify({ ok: false, status: 409, body: qrBodyFromStatus(session, status, waited.info?.body), reason: waited.reason }),
          { headers: jsonHeaders },
        );
      }

      const qr = await fetchQr(session, enc);
      return new Response(JSON.stringify(qr), { headers: jsonHeaders });
    }

    if (action === "send_text") {
      const phone = String(body.phone || "").replace(/\D/g, "");
      const text = String(body.text || "WAHA test from TakTak");
      if (!phone) return new Response(JSON.stringify({ error: "phone required" }), { status: 400, headers: jsonHeaders });
      const chatId = `${phone}@c.us`;
      const res = await wahaFetch(`/api/sendText`, {
        method: "POST",
        body: JSON.stringify({ session, chatId, text }),
      });
      return new Response(JSON.stringify(await safe(res)), { headers: jsonHeaders });
    }

    if (action === "register_bot_webhook") {
      let supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
      if (supabaseUrl === "http://api-gw:8000") supabaseUrl = "https://supabase2.buildstart.io";
      const hookUrl = `${supabaseUrl}/functions/v1/waha-webhook-taktak`;
      const infoRes = await wahaFetch(`/api/sessions/${enc}`);
      let existingConfig: any = {};
      if (infoRes.ok) {
        const info = await infoRes.json().catch(() => ({}));
        existingConfig = info?.config || {};
      }
      const others = (existingConfig.webhooks || []).filter((w: any) => w?.url !== hookUrl);
      const newConfig = {
        ...existingConfig,
        webhooks: [...others, { url: hookUrl, events: ["message", "session.status"], retries: { policy: "linear", delaySeconds: 2, attempts: 5 } }],
      };
      const r = await wahaFetch(`/api/sessions/${enc}`, {
        method: "PUT",
        body: JSON.stringify({ config: newConfig }),
      });
      const t = await r.text();
      if (!r.ok) {
        return new Response(JSON.stringify({ error: `WAHA ${r.status}: ${t.slice(0, 300)}` }), { status: 502, headers: jsonHeaders });
      }
      let restarted = false;
      try {
        const rs = await wahaFetch(`/api/sessions/${enc}/restart`, { method: "POST" });
        restarted = rs.ok;
      } catch { /* ignore */ }
      return new Response(JSON.stringify({ ok: true, webhook_url: hookUrl, restarted }), { headers: jsonHeaders });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: jsonHeaders });
  } catch (err) {
    console.error("waha-control error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: jsonHeaders });
  }
}
