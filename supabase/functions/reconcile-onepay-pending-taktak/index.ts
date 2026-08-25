// Polling reconciler for pending OnePay payments.
// Runs on a cron; for every pending payment younger than 24h, asks the CRM
// proxy for the OnePay status. If the gateway says success, forwards the
// status to onepay-callback so it goes through the exact same activation flow
// (mark paid, activate listing, insert revenue, notify seller + admins).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_PROXY_URL = Deno.env.get("CRM_PROXY_URL")!;
const CRM_PROXY_SECRET = Deno.env.get("CRM_PROXY_SECRET")!;

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
  const results: any[] = [];

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: pending, error } = await supabase
      .from("payments")
      .select("id, reference, status, created_at")
      .eq("status", "pending")
      .eq("provider", "onepay")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(25);

    if (error) throw error;
    if (!pending || pending.length === 0) {
      return json({ checked: 0, reconciled: 0, results });
    }

    let reconciled = 0;
    // Status endpoint — prefer explicit ONEPAY_STATUS_URL, fallback to {CRM_PROXY_URL}/status
    const statusUrl = Deno.env.get("ONEPAY_STATUS_URL") ||
      `${CRM_PROXY_URL.replace(/\/+$/, "")}/status`;

    const settled = await Promise.allSettled(pending.map(async (p) => {
      const url = `${statusUrl}?reference=${encodeURIComponent(p.reference)}`;
      const resp = await fetch(url, {
        method: "GET",
        headers: { "X-Proxy-Secret": CRM_PROXY_SECRET },
      });
      const text = await resp.text();
      let payload: any = {};
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }

      if (!resp.ok) {
        return { reference: p.reference, http: resp.status, skipped: true, details: payload };
      }

      const data = payload?.data || payload;
      const statusRaw = String(
        payload?.status ||
        data?.transaction_status ||
        data?.status ||
        data?.payment_status ||
        "",
      ).toLowerCase();
      const txId = data?.transaction_id || data?.ipg_transaction_id || payload?.transaction_id || null;

      const isSuccess = ["success", "successful", "completed", "paid", "1", "approved"].includes(statusRaw);
      const isFailed = ["failed", "failure", "declined", "cancelled", "canceled", "error", "0"].includes(statusRaw);

      if (!isSuccess && !isFailed) {
        return { reference: p.reference, gateway_status: statusRaw || "pending", skipped: true };
      }

      const cbResp = await fetch(`${SUPABASE_URL}/functions/v1/onepay-callback-taktak`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-proxy-secret": CRM_PROXY_SECRET,
        },
        body: JSON.stringify({
          reference: p.reference,
          status: isSuccess ? "success" : "failed",
          transaction_id: txId,
          source: "reconciler",
        }),
      });
      const cbText = await cbResp.text();
      if (cbResp.ok && isSuccess) reconciled++;
      return {
        reference: p.reference,
        gateway_status: statusRaw,
        callback_http: cbResp.status,
        callback_body: safeParse(cbText),
      };
    }));

    for (const r of settled) {
      if (r.status === "fulfilled") results.push(r.value);
      else results.push({ error: String(r.reason?.message || r.reason) });
    }



    return json({ checked: pending.length, reconciled, results });
  } catch (e) {
    console.error("reconcile-onepay-pending error:", e);
    return json({ error: String(e?.message || e), results }, 500);
  }
}

function safeParse(s: string) {
  try { return JSON.parse(s); } catch { return s; }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
