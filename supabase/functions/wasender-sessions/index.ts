import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

const WASENDER_BASE = "https://www.wasenderapi.com/api";

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const token = Deno.env.get("WASENDER_PERSONAL_ACCESS_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ error: "WASENDER_PERSONAL_ACCESS_TOKEN not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  try {
    // LIST all sessions
    if (req.method === "GET" && action === "list") {
      const res = await fetch(`${WASENDER_BASE}/whatsapp-sessions`, { headers });
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // CREATE a new session
    if (req.method === "POST" && action === "create") {
      const body = await req.json();
      const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/wasender-webhook-taktak`;
      const res = await fetch(`${WASENDER_BASE}/whatsapp-sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: body.name,
          phone_number: body.phone_number,
          account_protection: true,
          log_messages: true,
          webhook_url: webhookUrl,
          webhook_enabled: true,
          webhook_events: ["messages.received", "session.status"],
        }),
      });
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // UPDATE session webhook settings
    if (req.method === "PUT" && action === "update-webhook") {
      const body = await req.json();
      const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/wasender-webhook-taktak`;
      const res = await fetch(`${WASENDER_BASE}/whatsapp-sessions/${body.session_id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          webhook_url: webhookUrl,
          webhook_enabled: true,
          webhook_events: ["messages.received", "session.status"],
        }),
      });
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // CONNECT a session (initiates QR code)
    if (req.method === "POST" && action === "connect") {
      const body = await req.json();
      const res = await fetch(`${WASENDER_BASE}/whatsapp-sessions/${body.session_id}/connect`, {
        method: "POST",
        headers,
      });
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET QR code
    if (req.method === "GET" && action === "qrcode") {
      const sessionId = url.searchParams.get("session_id");
      const res = await fetch(`${WASENDER_BASE}/whatsapp-sessions/${sessionId}/qrcode`, { headers });
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET session status
    if (req.method === "GET" && action === "status") {
      const sessionId = url.searchParams.get("session_id");
      const res = await fetch(`${WASENDER_BASE}/whatsapp-sessions/${sessionId}`, { headers });
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // DELETE session
    if (req.method === "DELETE" && action === "delete") {
      const sessionId = url.searchParams.get("session_id");
      const res = await fetch(`${WASENDER_BASE}/whatsapp-sessions/${sessionId}`, {
        method: "DELETE",
        headers,
      });
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Session error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
