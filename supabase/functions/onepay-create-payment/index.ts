// Creates a OnePay checkout link for a listing — via CRM (buildstart.io) proxy.
// OnePay merchant is registered on crm.buildstart.io, so all requests must
// originate from that domain. We call CRM's /create endpoint; CRM signs and
// forwards to OnePay, then returns the redirect URL to us.
//
// POST body: { listing_id: string }
// Returns: { redirect_url, reference, amount }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getFeeConfig, feeForPrice } from "../_shared/fees.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { listing_id } = await req.json();
    if (!listing_id) return json({ error: "listing_id required" }, 400);

    const proxyUrl = Deno.env.get("CRM_PROXY_URL");
    const proxySecret = Deno.env.get("CRM_PROXY_SECRET");
    if (!proxyUrl || !proxySecret) {
      return json({ error: "CRM proxy not configured" }, 500);
    }

    // Load listing + seller
    const { data: listing, error: lErr } = await supabase
      .from("listings")
      .select("id, title, price, seller_id, payment_reference, payment_status")
      .eq("id", listing_id)
      .single();
    if (lErr || !listing) return json({ error: "Listing not found" }, 404);

    if (listing.payment_status === "paid") {
      return json({ error: "Already paid", paid: true }, 400);
    }

    const { data: seller } = await supabase
      .from("marketplace_users")
      .select("id, display_name, phone_number")
      .eq("id", listing.seller_id)
      .single();
    if (!seller) return json({ error: "Seller not found" }, 404);

    // Fee tiers are admin-configurable (bot_settings.listing_fee)
    const listingPrice = Number(listing.price) || 0;
    const feeAmount = feeForPrice(listingPrice, await getFeeConfig(supabase));
    const currency = "LKR";

    // Reference: >=10 chars, unique per attempt
    const reference = `TAK${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, "0")}`;

    // Split display name
    const rawName = (seller.display_name || "TakTak Seller").trim();
    const nameParts = rawName.split(/\s+/);
    const firstName = (nameParts[0] || "Seller").slice(0, 50);
    const lastName = (nameParts.slice(1).join(" ") || "TakTak").slice(0, 50);

    const phone = seller.phone_number.startsWith("+")
      ? seller.phone_number
      : `+${seller.phone_number}`;
    const email = `${seller.phone_number.replace(/[^0-9]/g, "")}@sellers.taktak.lk`;

    // The callback we want CRM to forward OnePay's status to
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const callbackUrl = `${supabaseUrl}/functions/v1/onepay-callback-taktak`;
    // TakTak payments redirect back to WhatsApp bot; CRM payments use CRM's own flow.
    const botNumber = "94722756169";
    const whatsAppText = encodeURIComponent(`Payment done — ref ${reference}`);
    const redirectUrl = `https://wa.me/${botNumber}?text=${whatsAppText}`;

    // Call CRM proxy — CRM owns OnePay credentials + hashing
    const proxyResp = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Secret": proxySecret,
      },
      body: JSON.stringify({
        reference,
        amount: feeAmount,
        currency,
        customer: {
          first_name: firstName,
          last_name: lastName,
          phone,
          email,
        },
        redirect_url: redirectUrl,
        callback_url: callbackUrl,
        additional_data: listing.id,
      }),
    });

    const proxyText = await proxyResp.text();
    let proxyJson: any = {};
    try {
      proxyJson = JSON.parse(proxyText);
    } catch {
      proxyJson = { raw: proxyText };
    }

    if (!proxyResp.ok) {
      console.error("CRM proxy error", proxyResp.status, proxyText);
      return json(
        { error: "CRM proxy error", status: proxyResp.status, details: proxyJson },
        502,
      );
    }

    const gatewayRedirect =
      proxyJson?.redirect_url ||
      proxyJson?.data?.redirect_url ||
      proxyJson?.data?.gateway?.redirect_url ||
      null;

    if (!gatewayRedirect) {
      console.error("CRM proxy returned no redirect_url", proxyJson);
      return json({ error: "No redirect URL from CRM", details: proxyJson }, 502);
    }

    // Persist payment intent
    await supabase.from("payments").insert({
      reference,
      listing_id: listing.id,
      seller_id: seller.id,
      phone_number: seller.phone_number,
      amount: feeAmount,
      currency,
      status: "pending",
      provider: "onepay",
      redirect_url: gatewayRedirect,
      gateway_response: proxyJson,
    });

    await supabase
      .from("listings")
      .update({
        payment_reference: reference,
        listing_fee: feeAmount,
      })
      .eq("id", listing.id);

    return json({
      success: true,
      redirect_url: gatewayRedirect,
      reference,
      amount: feeAmount,
    });
  } catch (e) {
    console.error("onepay-create-payment error:", e);
    return json({ error: String((e as any)?.message || e) }, 500);
  }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
