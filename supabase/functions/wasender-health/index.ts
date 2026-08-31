import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const WASENDER_BASE = "https://www.wasenderapi.com/api";
const jsonHeaders = { "Content-Type": "application/json" };

async function readJson(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

export default async function(req: Request) {
  const token = Deno.env.get("WASENDER_PERSONAL_ACCESS_TOKEN") || "";
  const backendUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
  if (!token || !backendUrl) {
    return new Response(JSON.stringify({ ok: false, error: "missing configuration" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const webhookUrl = `${backendUrl}/functions/v1/wasender-webhook-taktak`;

  try {
    const listRes = await fetch(`${WASENDER_BASE}/whatsapp-sessions`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const listBody = await readJson(listRes);
    if (!listRes.ok) {
      console.error("wasender-health list failed", listRes.status, listBody);
      return new Response(JSON.stringify({ ok: false, status: listRes.status }), {
        status: 502,
        headers: jsonHeaders,
      });
    }

    const sessions = Array.isArray(listBody?.data) ? listBody.data : [];
    const results: Array<Record<string, unknown>> = [];

    for (const session of sessions) {
      const id = Number(session?.id);
      if (!id || session?.status !== "connected") continue;

      // Refresh registration even when the provider's stored fields look right.
      // Wasender can show a correct webhook while silently ceasing deliveries;
      // re-saving it restores the provider-side subscription.
      const repairRes = await fetch(`${WASENDER_BASE}/whatsapp-sessions/${id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          webhook_url: webhookUrl,
          webhook_enabled: true,
          webhook_events: ["messages.received", "session.status"],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const repairBody = await readJson(repairRes);
      results.push({ id, repaired: repairRes.ok, status: repairRes.status });
      if (!repairRes.ok) console.error("wasender-health repair failed", id, repairBody);
    }

    console.log("wasender-health", JSON.stringify(results));
    return new Response(JSON.stringify({ ok: results.every((r) => r.repaired), results }), {
      status: results.every((r) => r.repaired) ? 200 : 502,
      headers: jsonHeaders,
    });
  } catch (error) {
    console.error("wasender-health error", String(error));
    return new Response(JSON.stringify({ ok: false, error: String(error) }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}