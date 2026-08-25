// Temporary diagnostic: checks whether the WAHA server is reachable.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BASE = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/+$/, "");
const KEY = Deno.env.get("WAHA_API_KEY") || "";

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const body = await req.json().catch(() => ({} as any));
  const session = String(body?.session || "");
  const action = String(body?.action || "list");
  const out: Record<string, unknown> = { base_url: BASE, has_key: !!KEY, action };
  const path = action === "raw" ? String(body?.path || "/api/sessions")
    : action === "info" ? `/api/sessions/${session}`
    : action === "restart" ? `/api/sessions/${session}/restart`
    : action === "start" ? `/api/sessions/${session}/start`
    : action === "qr" ? `/api/${session}/auth/qr?format=image`
    : `/api/sessions`;
  const method = (action === "restart" || action === "start") ? "POST" : "GET";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "X-Api-Key": KEY, Accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    out.status = res.status;
    out.body = (await res.text()).slice(0, 1500);
  } catch (e) {
    out.error = String((e as Error)?.message || e);
  }
  return new Response(JSON.stringify(out), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
