// Self-healing WAHA watchdog (runs on a 5-minute cron).
//
// For every session TakTak knows about (DB) plus every session the WAHA server
// reports, it:
//   1. reads the real status from the WAHA server
//   2. recreates sessions that no longer exist on the server
//   3. auto-starts STOPPED sessions and repairs FAILED ones (stop -> start,
//      then delete -> recreate -> start as a last resort)
//   4. repairs webhook configuration (message + session.status) and restarts
//      the session once so WAHA actually applies it
//   5. writes the resulting status (and phone number) back to waha_sessions
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const BASE = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/+$/, "");
const KEY = Deno.env.get("WAHA_API_KEY") || "";

async function waha(path: string, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        "X-Api-Key": KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { ok: res.ok, status: res.status, body: body as any };
  } catch (e) {
    return { ok: false, status: 0, body: { error: String(e) } as any };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const hookUrl = `${(Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "")}/functions/v1/waha-webhook-taktak`;
const REQUIRED_EVENTS = ["message", "session.status"];

function webhookConfig(existing: any = {}) {
  const hooks: any[] = Array.isArray(existing?.webhooks) ? existing.webhooks : [];
  const others = hooks.filter((w) => String(w?.url || "").replace(/\/$/, "") !== hookUrl.replace(/\/$/, ""));
  return { ...existing, webhooks: [...others, { url: hookUrl, events: REQUIRED_EVENTS }] };
}

function webhookIsHealthy(config: any) {
  const hooks: any[] = Array.isArray(config?.webhooks) ? config.webhooks : [];
  const mine = hooks.find((w) => String(w?.url || "").replace(/\/$/, "") === hookUrl.replace(/\/$/, ""));
  const events: string[] = Array.isArray(mine?.events) ? mine.events : [];
  return Boolean(mine) && REQUIRED_EVENTS.every((e) => events.includes(e));
}

function toDbStatus(state: string) {
  if (state === "WORKING") return "connected";
  if (state === "STOPPED" || state === "FAILED" || state === "UNKNOWN" || state === "MISSING") return "disconnected";
  return "connecting";
}

async function sessionState(name: string) {
  const info = await waha(`/api/sessions/${encodeURIComponent(name)}`);
  if (info.status === 404) return { state: "MISSING", info };
  return { state: String(info.body?.status || "UNKNOWN").toUpperCase(), info };
}

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const report: any[] = [];

  try {
    if (!BASE || !KEY) {
      return new Response(JSON.stringify({ ok: false, error: "WAHA_BASE_URL / WAHA_API_KEY not configured" }), {
        status: 500, headers: jsonHeaders,
      });
    }

    // Sessions the dashboard tracks. Anything explicitly logged out by an admin
    // (status 'disconnected' AND never connected) is still healed only if it
    // exists on the server, so we look at every row and let WAHA decide.
    const { data: rows } = await supabase
      .from("waha_sessions")
      .select("id, waha_session_id, name, status, phone_number, role, updated_at")
      .order("updated_at", { ascending: false });

    for (const s of rows || []) {
      const name = s.waha_session_id || s.name;
      if (!name) continue;
      const enc = encodeURIComponent(name);
      const actions: string[] = [];

      let { state, info } = await sessionState(name);

      // 1. Session vanished from the WAHA server -> recreate it.
      if (state === "MISSING") {
        const created = await waha(`/api/sessions`, {
          method: "POST",
          body: JSON.stringify({ name, start: true, config: webhookConfig({}) }),
        });
        actions.push(`recreate:${created.status}`);
        await sleep(1500);
        ({ state, info } = await sessionState(name));
      }

      // 2. Dead session -> start it. If it comes back FAILED, do the hard reset.
      if (state === "STOPPED" || state === "FAILED") {
        if (state === "FAILED") {
          await waha(`/api/sessions/${enc}/stop`, { method: "POST" });
          await sleep(1200);
        }
        const started = await waha(`/api/sessions/${enc}/start`, { method: "POST" });
        actions.push(`start:${started.status}`);
        await sleep(2000);
        ({ state, info } = await sessionState(name));

        if (state === "FAILED") {
          await waha(`/api/sessions/${enc}`, { method: "DELETE" });
          await sleep(1200);
          const recreated = await waha(`/api/sessions`, {
            method: "POST",
            body: JSON.stringify({ name, start: true, config: webhookConfig({}) }),
          });
          actions.push(`hard-reset:${recreated.status}`);
          await sleep(2000);
          ({ state, info } = await sessionState(name));
        }
      }

      // 3. Repair webhook configuration so inbound messages keep flowing.
      if (info.ok) {
        const config = info.body?.config || {};
        if (!webhookIsHealthy(config)) {
          const put = await waha(`/api/sessions/${enc}`, {
            method: "PUT",
            body: JSON.stringify({ config: webhookConfig(config) }),
          });
          actions.push(`webhook:${put.status}`);

          // WAHA only applies webhook config on restart.
          if (put.ok && state === "WORKING") {
            const restarted = await waha(`/api/sessions/${enc}/restart`, { method: "POST" });
            if (!restarted.ok && restarted.status === 404) {
              await waha(`/api/sessions/${enc}/stop`, { method: "POST" });
              await sleep(1000);
              const started = await waha(`/api/sessions/${enc}/start`, { method: "POST" });
              actions.push(`restart-fallback:${started.status}`);
            } else {
              actions.push(`restart:${restarted.status}`);
            }
            await sleep(1500);
            ({ state, info } = await sessionState(name));
          }
        }
      }

      // 4. Sync the dashboard row (status + phone number).
      const dbStatus = toDbStatus(state);
      const rawPhone = info.body?.me?.id || info.body?.session?.me?.id || null;
      const phone = rawPhone ? String(rawPhone).split("@")[0].replace(/\D/g, "") : null;
      const patch: Record<string, unknown> = {};
      if (dbStatus !== s.status) patch.status = dbStatus;
      if (phone && phone !== s.phone_number) patch.phone_number = phone;
      if (Object.keys(patch).length > 0) {
        patch.updated_at = new Date().toISOString();
        await supabase.from("waha_sessions").update(patch).eq("id", s.id);
        actions.push(`db:${s.status}->${dbStatus}`);
      }

      report.push({ session: name, waha_status: state, actions });
    }

    console.log("waha-health", JSON.stringify(report));
    return new Response(
      JSON.stringify({ ok: true, checked: report.length, healed: report.filter((r) => r.actions.length).length, report }),
      { headers: jsonHeaders },
    );
  } catch (err) {
    console.error("waha-health error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: jsonHeaders });
  }
}
