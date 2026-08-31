import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWhatsAppText, sendWhatsAppImage, resolveSessionKeys } from "../_shared/whatsapp.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const WASENDER_SEND_API = "https://www.wasenderapi.com/api/send-message";

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // Check if notifications are enabled
    const { data: notifSetting } = await supabase
      .from("bot_settings")
      .select("value")
      .eq("key", "notifications_enabled")
      .single();

    if (notifSetting?.value && (notifSetting.value as any).enabled === false) {
      console.log("Notifications are disabled by admin, skipping");
      return jsonResponse({ skipped: true, reason: "notifications_disabled" });
    }

    // Get the stored session key for sending WhatsApp messages
    const sessionApiKey = await getSessionKey(supabase);
    if (!sessionApiKey) {
      console.log("No session key available, skipping notification run");
      return jsonResponse({ skipped: true, reason: "no_session_key" });
    }

    // Find new listings created in the last 10 minutes that haven't been notified yet
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: newListings, error: listingsError } = await supabase
      .from("listings")
      .select("id, title, price, city, district, condition, category, images, seller_id, additional_details, created_at")
      .eq("status", "active")
      .gte("created_at", tenMinutesAgo)
      .order("created_at", { ascending: true });

    if (listingsError) {
      console.error("Error fetching new listings:", listingsError);
      return jsonResponse({ error: listingsError.message }, 500);
    }

    if (!newListings || newListings.length === 0) {
      console.log("No new listings to notify about");
      return jsonResponse({ success: true, notified: 0 });
    }

    console.log(`Found ${newListings.length} new listings to check for notifications`);

    // Get active buyer alerts
    const { data: activeAlerts } = await supabase
      .from("buyer_alerts")
      .select("id, user_id, search_query, product_keyword, location, max_price, category")
      .eq("is_active", true);

    if (!activeAlerts || activeAlerts.length === 0) {
      console.log("No active buyer alerts");
      return jsonResponse({ success: true, notified: 0 });
    }

    console.log(`Found ${activeAlerts.length} active buyer alerts`);

    // Get seller phone numbers
    const sellerIds = [...new Set(newListings.map(l => l.seller_id))];
    let sellerPhones: Record<string, string> = {};
    if (sellerIds.length > 0) {
      const { data: sellers } = await supabase
        .from("marketplace_users")
        .select("id, phone_number")
        .in("id", sellerIds);
      for (const s of sellers || []) {
        sellerPhones[s.id] = s.phone_number;
      }
    }

    // Get buyer phone numbers
    const buyerUserIds = [...new Set(activeAlerts.map(a => a.user_id))];
    let buyerPhones: Record<string, string> = {};
    if (buyerUserIds.length > 0) {
      const { data: buyers } = await supabase
        .from("marketplace_users")
        .select("id, phone_number")
        .in("id", buyerUserIds);
      for (const b of buyers || []) {
        buyerPhones[b.id] = b.phone_number;
      }
    }

    // Check existing notification_log to avoid duplicates
    const listingIds = newListings.map(l => l.id);
    const alertIds = activeAlerts.map(a => a.id);
    const { data: existingNotifs } = await supabase
      .from("notification_log")
      .select("alert_id, listing_id")
      .in("alert_id", alertIds)
      .in("listing_id", listingIds);

    const sentPairs = new Set(
      (existingNotifs || []).map(n => `${n.alert_id}:${n.listing_id}`)
    );

    // Match listings to alerts and queue notifications
    const notificationsToSend: Array<{
      alert: any;
      listing: any;
      buyerPhone: string;
      sellerPhone: string;
    }> = [];

    for (const listing of newListings) {
      for (const alert of activeAlerts) {
        // Skip if already sent
        const pairKey = `${alert.id}:${listing.id}`;
        if (sentPairs.has(pairKey)) continue;

        // Skip if the seller is the same as the buyer (don't notify yourself)
        if (listing.seller_id === alert.user_id) continue;

        // Match criteria
        if (!matchesAlert(listing, alert)) continue;

        const buyerPhone = buyerPhones[alert.user_id];
        const sellerPhone = sellerPhones[listing.seller_id] || "N/A";
        if (!buyerPhone) continue;

        notificationsToSend.push({ alert, listing, buyerPhone, sellerPhone });
      }
    }

    console.log(`Matched ${notificationsToSend.length} notifications to send`);

    // Send notifications gradually with delays
    let sentCount = 0;
    const MAX_PER_RUN = 10; // Limit per cron run to avoid timeout and rate limits

    for (let i = 0; i < Math.min(notificationsToSend.length, MAX_PER_RUN); i++) {
      const { alert, listing, buyerPhone, sellerPhone } = notificationsToSend[i];

      try {
        // Format notification message
        const caption = formatListingCaption(listing, sellerPhone);
        const notifMessage = `🔔 *New listing matches your alert!*\n\n${caption}\n\n_Reply *STOP ${alert.product_keyword || ""}* to unsubscribe_`;

        const imagesArr = Array.isArray(listing.images) ? listing.images : [];
        const firstImage = imagesArr.length > 0 ? imagesArr[0] : null;

        if (firstImage && typeof firstImage === "string" && firstImage.startsWith("http")) {
          await sendWhatsAppImage(supabase, buyerPhone, firstImage, notifMessage);
        } else {
          await sendWhatsAppText(supabase, buyerPhone, notifMessage);
        }

        // Log the notification
        await supabase.from("notification_log").insert({
          alert_id: alert.id,
          listing_id: listing.id,
          user_id: alert.user_id,
          phone_number: buyerPhone,
          status: "sent",
        });

        // Update last_notified_at on the alert
        await supabase.from("buyer_alerts")
          .update({ last_notified_at: new Date().toISOString() })
          .eq("id", alert.id);

        // Also log as outgoing chat message
        await supabase.from("chat_messages").insert({
          user_id: alert.user_id,
          phone_number: buyerPhone,
          direction: "outgoing",
          message_text: `🔔 Notification: New ${listing.title} - LKR ${listing.price}`,
          message_type: "notification",
          metadata: { notification_alert_id: alert.id, notification_listing_id: listing.id },
        });

        sentCount++;
        console.log(`Sent notification ${sentCount}/${notificationsToSend.length} to ${buyerPhone} for listing ${listing.title}`);

        // Gradual delay: 8 seconds between messages to different users
        if (i < notificationsToSend.length - 1) {
          await delay(8000);
        }
      } catch (e) {
        console.error(`Error sending notification to ${buyerPhone}:`, e);
        // Log failed notification
        await supabase.from("notification_log").insert({
          alert_id: alert.id,
          listing_id: listing.id,
          user_id: alert.user_id,
          phone_number: buyerPhone,
          status: "failed",
        }).catch(() => {});
      }
    }

    console.log(`Notification run complete: ${sentCount} sent`);
    return jsonResponse({ success: true, notified: sentCount, total_matched: notificationsToSend.length });
  } catch (error) {
    console.error("Notify-buyers error:", error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// ─── Matching Logic ──────────────────────────────────────

function matchesAlert(listing: any, alert: any): boolean {
  // product_keyword is now AI-cleaned (e.g., "Laptop" instead of "lappt")
  const keyword = (alert.product_keyword || "").toLowerCase();
  const searchQuery = (alert.search_query || "").toLowerCase();
  const listingTitle = (listing.title || "").toLowerCase();
  const listingCategory = (listing.category || "").toLowerCase();
  const listingDesc = (listing.description || "").toLowerCase();
  const listingDetails = JSON.stringify(listing.additional_details || {}).toLowerCase();

  // Build keyword list from cleaned product_keyword
  const stopWords = new Set(["in", "under", "lkr", "for", "the", "and", "of", "a", "an", "to", "is", "with"]);
  const keywords = keyword.split(/\s+/).filter((w: string) => w.length > 2 && !stopWords.has(w));
  
  // Also extract meaningful words from search_query as fallback
  const queryWords = searchQuery.split(/\s+/).filter((w: string) => w.length > 2 && !stopWords.has(w));
  const allKeywords = [...new Set([...keywords, ...queryWords])];

  // Match: at least one keyword must appear in title, category, description, or details
  const textMatch = allKeywords.length === 0 || allKeywords.some((kw: string) => 
    listingTitle.includes(kw) || listingCategory.includes(kw) || 
    listingDesc.includes(kw) || listingDetails.includes(kw)
  );
  if (!textMatch) return false;

  // Location match (AI-cleaned, so "Colombo" not "CMB")
  if (alert.location) {
    const alertLocation = alert.location.toLowerCase();
    const listingCity = (listing.city || "").toLowerCase();
    const listingDistrict = (listing.district || "").toLowerCase();
    if (!listingCity.includes(alertLocation) && !listingDistrict.includes(alertLocation) && 
        !alertLocation.includes(listingCity) && !alertLocation.includes(listingDistrict)) {
      return false;
    }
  }

  // Price match (AI-normalized, so "2 lakhs" is stored as 200000)
  if (alert.max_price && listing.price > alert.max_price) {
    return false;
  }

  // Category match (AI-extracted clean category)
  if (alert.category && listingCategory) {
    const alertCat = alert.category.toLowerCase();
    // Allow partial match both ways for flexibility
    if (!listingCategory.includes(alertCat) && !alertCat.includes(listingCategory)) {
      return false;
    }
  }

  return true;
}

// ─── Helpers ─────────────────────────────────────────────

function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getSessionKey(supabase: any): Promise<string | null> {
  // Provider-aware: returns the most recently active key (WAHA or Wasender).
  const keys = await resolveSessionKeys(supabase);
  return keys[0] || null;
}

function formatListingCaption(l: any, sellerPhone: string): string {
  const imagesArr = Array.isArray(l.images) ? l.images : [];
  const details = l.additional_details && typeof l.additional_details === "object"
    ? Object.entries(l.additional_details as Record<string, any>)
        .filter(([_, v]) => v && v !== "N/A" && v !== "")
        .map(([k, v]) => `  • ${k.replace(/_/g, " ")}: ${v}`)
        .join("\n")
    : "";

  return [
    `📱 *${l.title}*`,
    `💰 LKR ${Number(l.price).toLocaleString()}`,
    `📦 Condition: ${l.condition || "Good"}`,
    `📍 ${l.city}, ${l.district}`,
    details ? `📋 Details:\n${details}` : "",
    imagesArr.length > 1 ? `🖼️ ${imagesArr.length} photos available` : "",
    `📞 Contact Seller: +${sellerPhone}`,
  ].filter(Boolean).join("\n");
}
