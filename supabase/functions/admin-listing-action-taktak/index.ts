import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { wasenderSendWithFallback } from "../_shared/whatsapp.ts";
import { awardSellerReferral, sendReferralPromo } from "../_shared/referral.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const WASENDER_SEND_API = "https://www.wasenderapi.com/api/send-message";
const WAHA_BASE_URL = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/+$/, "");
const WAHA_API_KEY = Deno.env.get("WAHA_API_KEY") || "";

type ListingAction = "approve_payment" | "pause_listing" | "activate_listing";

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const listingId = String(body?.listing_id || "").trim();
    const action = String(body?.action || "").trim() as ListingAction;
    if (!listingId) return jsonResponse({ error: "listing_id required" }, 400);
    if (!["approve_payment", "pause_listing", "activate_listing"].includes(action)) {
      return jsonResponse({ error: "Invalid action" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: listing, error: listingError } = await supabase
      .from("listings")
      .select("id, title, price, status, payment_status, listing_fee, seller_id, city, district, condition, images, additional_details, marketplace_users!listings_seller_id_fkey(phone_number, bot_state)")
      .eq("id", listingId)
      .single();

    if (listingError || !listing) return jsonResponse({ error: "Listing not found" }, 404);

    const seller = Array.isArray((listing as any).marketplace_users)
      ? (listing as any).marketplace_users[0]
      : (listing as any).marketplace_users;
    const phone = String(seller?.phone_number || "").replace(/\D/g, "");
    if (!phone) return jsonResponse({ error: "Seller phone not found" }, 400);

    if (action === "approve_payment") {
      const result = await approvePayment(supabase, listing, seller?.bot_state || {}, phone);
      return jsonResponse(result);
    }

    if (action === "pause_listing") {
      await supabase
        .from("listings")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", listingId);

      const msg = `⏸️ *Listing Paused*\n\nඔබගේ *"${listing.title}"* listing එක admin review සඳහා තාවකාලිකව pause කර ඇත. Review අවසන් වූ පසු නැවත active කරනු ලැබේ.`;
      const sent = await sendWhatsAppMessage(supabase, phone, msg);
      await storeOutgoingMessage(supabase, listing.seller_id, phone, msg, "admin_pause_listing", sent);
      return jsonResponse({ success: true, status: "pending", whatsapp_sent: sent.sent });
    }

    await supabase
      .from("listings")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", listingId);

    const msg = `▶️ *Listing Active Again*\n\nඔබගේ *"${listing.title}"* listing එක නැවත live කර ඇත. Buyers ට දැන් එය සෙවිය හැක.`;
    const sent = await sendWhatsAppMessage(supabase, phone, msg);
    await storeOutgoingMessage(supabase, listing.seller_id, phone, msg, "admin_activate_listing", sent);
    return jsonResponse({ success: true, status: "active", whatsapp_sent: sent.sent });
  } catch (error) {
    console.error("admin-listing-action error", error);
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function approvePayment(supabase: any, listing: any, botState: Record<string, any>, phone: string) {
  const alreadyPaid = listing.payment_status === "paid";
  const fee = Number(listing.listing_fee || 0) || (Number(listing.price) >= 1_000_000 ? 500 : 300);
  const reference = `MANUAL-${Date.now()}`;
  const paidAt = new Date().toISOString();

  const { data: payment } = await supabase
    .from("payments")
    .select("id, status")
    .eq("listing_id", listing.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (payment?.id) {
    await supabase
      .from("payments")
      .update({
        status: "paid",
        amount: fee,
        currency: "LKR",
        provider: "manual_bank_transfer",
        gateway_response: { source: "superadmin_manual_approval", reference, approved_at: paidAt },
        updated_at: paidAt,
      })
      .eq("id", payment.id);
  } else {
    await supabase.from("payments").insert({
      reference,
      listing_id: listing.id,
      seller_id: listing.seller_id,
      phone_number: phone,
      amount: fee,
      currency: "LKR",
      status: "paid",
      provider: "manual_bank_transfer",
      gateway_response: { source: "superadmin_manual_approval", approved_at: paidAt },
    });
  }

  await supabase
    .from("listings")
    .update({
      status: "active",
      payment_status: "paid",
      payment_reference: reference,
      listing_fee: fee,
      paid_at: paidAt,
      updated_at: paidAt,
    })
    .eq("id", listing.id);

  if (!alreadyPaid) {
    await supabase.from("revenue").insert({
      user_id: listing.seller_id,
      type: "listing_fee",
      amount: fee,
      description: `Manual bank transfer approval for ${listing.title} (${reference})`,
    });
    await awardSellerReferral(supabase, listing.seller_id, listing.id, fee);
    notifyAdminsPayment({
      method: "manual",
      seller_phone: phone,
      listing_title: listing.title,
      amount: fee,
      reference,
    });
  }

  await supabase
    .from("marketplace_users")
    .update({
      bot_state: {
        ...(botState || {}),
        mode: "idle",
        pending_listing_id: null,
        last_question: null,
        updated_at: paidAt,
      },
      updated_at: paidAt,
    })
    .eq("id", listing.seller_id);

  const msg = `✅ *Payment Verified!*\n\n📝 *Listing:* ${listing.title}\n💰 *Amount:* LKR ${fee.toLocaleString()}\n🔢 Ref: ${reference}\n\n🎉 ඔබගේ Listing එක දැන් ක්‍රියාත්මකයි! Buyers ට එය සෙවිය හැක.\n\n📊 Reply *DASHBOARD* to track views & inquiries.`;
  const sent = await sendWhatsAppMessage(supabase, phone, msg);
  await storeOutgoingMessage(supabase, listing.seller_id, phone, msg, "admin_approve_payment", sent);

  // Buyer-preview of the listing (image + caption) so the seller sees exactly
  // what buyers will see. Best-effort — never blocks approval.
  try {
    await sendListingPreview(supabase, listing, phone);
  } catch (e) {
    console.error("preview send failed", e);
  }

  // Invite the seller to the referral program (once per user).
  try {
    await new Promise((r) => setTimeout(r, 7000));
    await sendReferralPromo(supabase, listing.seller_id, phone);
  } catch (e) {
    console.error("referral promo send failed", e);
  }

  return { success: true, status: "active", payment_status: "paid", whatsapp_sent: sent.sent, whatsapp_error: sent.error || null };
}

async function storeOutgoingMessage(supabase: any, userId: string, phone: string, text: string, action: string, sent: { sent: boolean; provider?: string; error?: string }) {
  await supabase.from("chat_messages").insert({
    user_id: userId,
    phone_number: phone,
    direction: "outgoing",
    message_text: text,
    message_type: "text",
    metadata: { action, provider: sent.provider || null, sent: sent.sent, error: sent.error || null },
  });
}

async function sendWhatsAppMessage(supabase: any, phone: string, text: string): Promise<{ sent: boolean; provider?: string; error?: string }> {
  const waha = await sendWithWaha(supabase, phone, text);
  if (waha.sent) return waha;

  const wasender = await sendWithWasender(phone, text);
  if (wasender.sent) return wasender;

  return { sent: false, error: waha.error || wasender.error || "No WhatsApp provider accepted the message" };
}

async function sendWithWaha(supabase: any, phone: string, text: string): Promise<{ sent: boolean; provider: string; error?: string }> {
  if (!WAHA_BASE_URL || !WAHA_API_KEY) return { sent: false, provider: "waha", error: "WAHA is not configured" };

  const { data: session } = await supabase
    .from("waha_sessions")
    .select("waha_session_id, name")
    .eq("role", "bot")
    .eq("status", "connected")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const sessionName = session?.waha_session_id || session?.name;
  if (!sessionName) return { sent: false, provider: "waha", error: "No connected bot session" };

  const res = await wahaFetch("/api/sendText", {
    method: "POST",
    body: JSON.stringify({ session: sessionName, chatId: `${phone}@c.us`, text }),
  });
  if (res.ok) return { sent: true, provider: "waha" };
  return { sent: false, provider: "waha", error: await res.text().catch(() => `WAHA ${res.status}`) };
}

async function sendWithWasender(phone: string, text: string): Promise<{ sent: boolean; provider: string; error?: string }> {
  const to = phone.startsWith("+") ? phone : `+${phone}`;
  return await wasenderSendWithFallback({ to, text });
}

async function sha512Hex(value: string) {
  const hashBuffer = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

  let lastUnauthorized = "Unauthorized";
  const authStrategies = [
    (headers: Headers, key: string) => headers.set("X-Api-Key", key),
    (headers: Headers, key: string) => headers.set("Authorization", `Bearer ${key}`),
    (headers: Headers, key: string) => headers.set("Api-Key", key),
  ];

  for (const key of await wahaApiKeyCandidates()) {
    for (const applyAuth of authStrategies) {
      const headers = new Headers(baseHeaders);
      headers.delete("X-Api-Key");
      headers.delete("x-api-key");
      headers.delete("Api-Key");
      headers.delete("Authorization");
      applyAuth(headers, key);

      const res = await fetch(url, { ...init, headers });
      if (res.status !== 401) return res;
      lastUnauthorized = await res.text().catch(() => "Unauthorized");
    }
  }

  return new Response(lastUnauthorized, { status: 401, headers: { "Content-Type": "application/json" } });
}

// ─── Listing preview (image + caption, buyer view) ────────

function formatListingCaption(l: any, sellerPhone: string): string {
  const imagesArr = Array.isArray(l.images) ? l.images : [];
  const details = l.additional_details && typeof l.additional_details === "object"
    ? Object.entries(l.additional_details as Record<string, any>)
        .filter(([_, v]) => v && v !== "N/A" && v !== "")
        .map(([k, v]) => `  • ${k.replace(/_/g, " ")}: ${v}`)
        .join("\n")
    : "";
  return [
    `👀 *Buyers දකින preview එක:*`,
    ``,
    `📱 *${l.title}*`,
    `💰 LKR ${Number(l.price).toLocaleString()}`,
    `📦 Condition: ${l.condition || "Good"}`,
    `📍 ${l.city || ""}${l.city && l.district ? ", " : ""}${l.district || ""}`,
    details ? `📋 Details:\n${details}` : "",
    imagesArr.length > 1 ? `🖼️ ${imagesArr.length} photos available` : "",
    `📞 Contact Seller: +${sellerPhone}`,
  ].filter(Boolean).join("\n");
}

async function sendListingPreview(supabase: any, listing: any, phone: string) {
  // small delay so it arrives after the "Payment Verified" text
  await new Promise((r) => setTimeout(r, 6000));

  const caption = formatListingCaption(listing, phone);
  const images = Array.isArray(listing.images) ? listing.images : [];
  const firstImage = images.find((u: any) => typeof u === "string" && u.startsWith("http")) || null;

  let sent: { sent: boolean; provider?: string; error?: string };
  if (firstImage) {
    sent = await sendWhatsAppImage(supabase, phone, firstImage, caption);
    if (!sent.sent) {
      // fallback to text-only preview so seller always sees it
      sent = await sendWhatsAppMessage(supabase, phone, `${caption}\n${firstImage}`);
    }
  } else {
    sent = await sendWhatsAppMessage(supabase, phone, caption);
  }
  await storeOutgoingMessage(supabase, listing.seller_id, phone, caption, "admin_approve_payment_preview", sent);
}

async function sendWhatsAppImage(supabase: any, phone: string, imageUrl: string, caption: string): Promise<{ sent: boolean; provider?: string; error?: string }> {
  // Try WAHA first
  if (WAHA_BASE_URL && WAHA_API_KEY) {
    const { data: session } = await supabase
      .from("waha_sessions")
      .select("waha_session_id, name")
      .eq("role", "bot")
      .eq("status", "connected")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const sessionName = session?.waha_session_id || session?.name;
    if (sessionName) {
      const res = await wahaFetch("/api/sendImage", {
        method: "POST",
        body: JSON.stringify({ session: sessionName, chatId: `${phone}@c.us`, file: { url: imageUrl }, caption }),
      });
      if (res.ok) return { sent: true, provider: "waha" };
    }
  }
  // Wasender fallback
  const to = phone.startsWith("+") ? phone : `+${phone}`;
  return await wasenderSendWithFallback({ to, text: caption, imageUrl });
}

function jsonResponse(data: any, status = 200) {
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
