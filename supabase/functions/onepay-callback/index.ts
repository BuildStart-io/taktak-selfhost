// OnePay status callback handler.
// OnePay POSTs transaction status here.
// On success -> activate the listing, insert revenue row, send WhatsApp confirmation.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWhatsAppText, sendWhatsAppImage } from "../_shared/whatsapp.ts";
import { awardSellerReferral, sendReferralPromo } from "../_shared/referral.ts";

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
    // Verify request came from our CRM proxy.
    // CRM's existing forwarder posts without a header, so a missing header is
    // accepted (unknown references return 404 harmlessly). A WRONG header is
    // still rejected — that indicates tampering.
    const expectedSecret = Deno.env.get("CRM_PROXY_SECRET");
    const providedSecret = req.headers.get("x-proxy-secret");
    if (expectedSecret && providedSecret && providedSecret !== expectedSecret) {
      console.warn("onepay-callback: invalid X-Proxy-Secret");
      return json({ error: "Unauthorized" }, 401);
    }

    // Accept either JSON or form-encoded
    let body: any = {};
    const ctype = req.headers.get("content-type") || "";
    if (ctype.includes("application/json")) {
      body = await req.json().catch(() => ({}));
    } else {
      const text = await req.text();
      try {
        body = JSON.parse(text);
      } catch {
        const params = new URLSearchParams(text);
        body = Object.fromEntries(params.entries());
      }
    }

    console.log("OnePay callback payload:", JSON.stringify(body));

    // OnePay may nest fields; normalise
    const data = body?.data || body;
    const reference =
      data?.transaction_reference ||
      data?.reference ||
      body?.reference ||
      data?.additional_data ||
      body?.additional_data;
    const statusRaw =
      data?.transaction_status ||
      data?.status ||
      body?.status ||
      data?.payment_status;
    const providerTxnId =
      data?.transaction_id ||
      data?.ipg_transaction_id ||
      body?.transaction_id ||
      null;

    if (!reference) {
      console.error("Callback missing reference");
      return json({ error: "Missing reference" }, 400);
    }

    const status = String(statusRaw || "").toLowerCase();
    const isSuccess =
      status === "success" ||
      status === "successful" ||
      status === "completed" ||
      status === "paid" ||
      status === "1" ||
      status === "approved";

    // Find payment row
    const { data: payment } = await supabase
      .from("payments")
      .select("id, listing_id, seller_id, phone_number, amount, status")
      .eq("reference", reference)
      .maybeSingle();

    if (!payment) {
      console.error("Payment not found for reference:", reference);
      return json({ error: "Payment not found" }, 404);
    }

    // Idempotency: already processed
    if (payment.status === "paid" && isSuccess) {
      return json({ success: true, already: true });
    }

    // Update payment row
    await supabase
      .from("payments")
      .update({
        status: isSuccess ? "paid" : "failed",
        provider_transaction_id: providerTxnId,
        gateway_response: body,
      })
      .eq("id", payment.id);

    if (!isSuccess) {
      return json({ received: true, status: "failed" });
    }

    // Activate the listing
    const { data: listing } = await supabase
      .from("listings")
      .update({
        status: "active",
        payment_status: "paid",
        paid_at: new Date().toISOString(),
      })
      .eq("id", payment.listing_id)
      .select("id, title, price, city, district, condition, images, additional_details, seller_id")
      .single();

    // Record revenue
    await supabase.from("revenue").insert({
      user_id: payment.seller_id,
      type: "listing_fee",
      amount: payment.amount,
      description: `Listing fee (OnePay ref ${reference})`,
    });

    if (payment.seller_id && payment.listing_id) {
      await awardSellerReferral(supabase, payment.seller_id, payment.listing_id, Number(payment.amount));
    }

    notifyAdminsPayment({
      method: "card",
      seller_phone: payment.phone_number,
      listing_title: listing?.title || "",
      amount: Number(payment.amount),
      reference,
    });

    // Fire WhatsApp confirmation to seller (best effort)
    try {
      await sendConfirmation(supabase, payment.phone_number, listing, payment.amount);
    } catch (e) {
      console.error("Confirmation send failed:", e);
    }

    return json({ success: true });
  } catch (e) {
    console.error("onepay-callback error:", e);
    return json({ error: String(e?.message || e) }, 500);
  }
}

async function sendConfirmation(
  supabase: any,
  phone: string,
  listing: any,
  amount: number,
) {
  if (!phone) return;

  // Dedupe: skip if a "Payment received" confirmation was already sent in the last 10 min
  // (protects against callback retries and WA-return reconciliation double-fire).
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("phone_number", phone)
    .eq("direction", "outgoing")
    .gte("created_at", tenMinAgo)
    .ilike("message_text", "%Payment received%")
    .limit(1)
    .maybeSingle();
  if (recent) {
    console.log("onepay-callback: skipping duplicate confirmation for", phone);
    return;
  }

  const text =
    `✅ *Payment received — LKR ${amount.toLocaleString()}*\n\n` +
    `Your listing *${listing?.title || ""}* is now *live* and visible to buyers.\n\n` +
    `📊 Reply *DASHBOARD* to track views & inquiries.`;

  const confirmResult = await sendWhatsAppText(supabase, phone, text);
  console.log("onepay-callback confirmation send:", JSON.stringify(confirmResult));

  // Log the outgoing message so the webhook's dedupe check can see it
  await supabase.from("chat_messages").insert({
    user_id: listing?.seller_id ?? null,
    phone_number: phone,
    direction: "outgoing",
    message_text: text,
    message_type: "text",
  });

  // Buyer-preview: send the listing exactly like buyers see it (image + caption).
  try {
    await sendListingPreview(supabase, phone, listing);
  } catch (e) {
    console.error("onepay-callback preview send failed:", e);
  }

  // Invite the seller to the referral program (once per user).
  if (listing?.seller_id) {
    await new Promise((r) => setTimeout(r, 7000));
    await sendReferralPromo(supabase, listing.seller_id, phone);
  }
}

function formatListingCaption(l: any, sellerPhone: string): string {
  const imagesArr = Array.isArray(l?.images) ? l.images : [];
  const details = l?.additional_details && typeof l.additional_details === "object"
    ? Object.entries(l.additional_details as Record<string, any>)
        .filter(([_, v]) => v && v !== "N/A" && v !== "")
        .map(([k, v]) => `  • ${k.replace(/_/g, " ")}: ${v}`)
        .join("\n")
    : "";
  return [
    `👀 *Buyers දකින preview එක:*`,
    ``,
    `📱 *${l?.title || ""}*`,
    `💰 LKR ${Number(l?.price || 0).toLocaleString()}`,
    `📦 Condition: ${l?.condition || "Good"}`,
    `📍 ${l?.city || ""}${l?.city && l?.district ? ", " : ""}${l?.district || ""}`,
    details ? `📋 Details:\n${details}` : "",
    imagesArr.length > 1 ? `🖼️ ${imagesArr.length} photos available` : "",
    `📞 Contact Seller: +${sellerPhone}`,
  ].filter(Boolean).join("\n");
}

async function sendListingPreview(
  supabase: any,
  phone: string,
  listing: any,
) {
  if (!listing || !phone) return;
  // small delay so preview arrives after the "Payment received" text
  await new Promise((r) => setTimeout(r, 6000));

  const caption = formatListingCaption(listing, phone);
  const images = Array.isArray(listing.images) ? listing.images : [];
  const firstImage = images.find((u: any) => typeof u === "string" && u.startsWith("http")) || null;

  const previewResult = firstImage
    ? await sendWhatsAppImage(supabase, phone, firstImage, caption)
    : await sendWhatsAppText(supabase, phone, caption);
  console.log("onepay-callback preview send:", JSON.stringify(previewResult));

  await supabase.from("chat_messages").insert({
    user_id: listing?.seller_id ?? null,
    phone_number: phone,
    direction: "outgoing",
    message_text: caption,
    message_type: firstImage ? "image" : "text",
    metadata: { action: "onepay_payment_preview", image_url: firstImage || null },
  });
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Fire-and-forget admin notification when a payment is verified.
function notifyAdminsPayment(payload: {
  method: string;
  seller_phone: string;
  listing_title?: string;
  amount?: number;
  reference?: string;
}) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/notify-admins-payment-taktak`;
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify(payload),
  }).catch((e) => console.error("notifyAdminsPayment failed:", e));
}
