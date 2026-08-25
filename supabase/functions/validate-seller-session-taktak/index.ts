import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { session_token } = await req.json();
    if (!session_token) {
      return jsonResponse({ valid: false, error: "No session token" }, 401);
    }

    const { data: session } = await supabase
      .from("seller_sessions")
      .select("*")
      .eq("session_token", session_token)
      .eq("is_active", true)
      .gte("expires_at", new Date().toISOString())
      .single();

    if (!session) {
      return jsonResponse({ valid: false, error: "Session expired" }, 401);
    }

    // Get seller info
    const { data: user } = await supabase
      .from("marketplace_users")
      .select("id, display_name, phone_number")
      .eq("phone_number", session.phone_number)
      .single();

    return jsonResponse({
      valid: true,
      seller: {
        id: user?.id,
        display_name: user?.display_name,
        phone_number: session.phone_number,
      },
    });
  } catch (error) {
    console.error("Validate session error:", error);
    return jsonResponse({ valid: false, error: error.message }, 401);
  }
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
