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
    const { phone_number, otp } = await req.json();
    if (!phone_number || !otp) {
      return jsonResponse({ error: "Phone number and OTP required" }, 400);
    }

    const cleanPhone = phone_number.replace(/\D/g, "");

    // Find valid OTP
    const { data: otpRecord } = await supabase
      .from("seller_otps")
      .select("*")
      .eq("phone_number", cleanPhone)
      .eq("otp_code", otp)
      .eq("used", false)
      .gte("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!otpRecord) {
      return jsonResponse({ error: "Invalid or expired OTP. Please request a new one." }, 401);
    }

    // Mark OTP as used
    await supabase.from("seller_otps").update({ used: true }).eq("id", otpRecord.id);

    // Generate session token
    const sessionToken = crypto.randomUUID() + "-" + crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

    // Deactivate old sessions for this phone
    await supabase
      .from("seller_sessions")
      .update({ is_active: false })
      .eq("phone_number", cleanPhone);

    // Create new session
    await supabase.from("seller_sessions").insert({
      phone_number: cleanPhone,
      session_token: sessionToken,
      expires_at: expiresAt,
      is_active: true,
    });

    // Get seller info
    const { data: user } = await supabase
      .from("marketplace_users")
      .select("id, display_name, phone_number")
      .eq("phone_number", cleanPhone)
      .single();

    return jsonResponse({
      success: true,
      session_token: sessionToken,
      seller: {
        id: user?.id,
        display_name: user?.display_name,
        phone_number: cleanPhone,
      },
    });
  } catch (error) {
    console.error("Verify OTP error:", error);
    return jsonResponse({ error: error.message }, 500);
  }
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
