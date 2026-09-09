import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// NOTE: imagescript is loaded lazily (see loadImage). A top-level import from
// deno.land/x can fail at boot ("brotli error") and would kill the whole
// webhook — the bot must never go silent because of the collage helper.
let _ImageMod: any = null;
async function loadImage(): Promise<any | null> {
  if (_ImageMod) return _ImageMod;
  const sources = [
    "npm:imagescript@1.2.17",
    "https://esm.sh/imagescript@1.2.17",
    "https://deno.land/x/imagescript@1.2.17/mod.ts",
  ];
  for (const s of sources) {
    try {
      const mod = await import(s);
      if (mod?.Image) {
        _ImageMod = mod.Image;
        return _ImageMod;
      }
    } catch (e) {
      console.warn("imagescript load failed", s, String(e));
    }
  }
  return null;
}
import { uploadToVps } from "./vps-storage.ts";
import { getFeeConfig, feeForPrice, DEFAULT_FEES } from "../_shared/fees.ts";
import { sendWhatsAppImage, sendTypingIndicator, wasenderSendWithFallback } from "../_shared/whatsapp.ts";
import {
  ensureReferralCode,
  extractReferralCode,
  stripReferralCode,
  attributeReferral,
  awardBuyerReferral,
  awardSellerReferral,
  getReferralConfig,
  referralLink,
  selfReferralMessage,
  sendReferralPromo,
} from "../_shared/referral.ts";

const MAX_IMAGES_PER_LISTING = 7;
const COLLAGE_TILE = 512; // each cell 512x512 → 1024x1024 total

async function buildCollageAndUpload(supabase: any, seller_id: string, imageUrls: string[]): Promise<string | null> {
  try {
    const src = imageUrls.slice(0, 4);
    if (src.length < 2) return null; // no collage needed for a single image

    const Image = await loadImage();
    if (!Image) return null;

    const tiles: any[] = [];
    for (const u of src) {
      try {
        const r = await fetch(u);
        if (!r.ok) continue;
        const buf = new Uint8Array(await r.arrayBuffer());
        const img = await Image.decode(buf);
        // cover-fit to square tile
        const side = Math.min(img.width, img.height);
        const cropped = img.crop(Math.floor((img.width - side) / 2), Math.floor((img.height - side) / 2), side, side);
        cropped.resize(COLLAGE_TILE, COLLAGE_TILE);
        tiles.push(cropped);
      } catch (e) {
        console.error("collage tile decode failed", e);
      }
    }
    if (tiles.length < 2) return null;

    // pad to 4 by repeating last tile so grid stays symmetric
    while (tiles.length < 4) tiles.push(tiles[tiles.length - 1].clone());

    const canvas = new Image(COLLAGE_TILE * 2, COLLAGE_TILE * 2);
    canvas.fill(0xffffffff);
    canvas.composite(tiles[0], 0, 0);
    canvas.composite(tiles[1], COLLAGE_TILE, 0);
    canvas.composite(tiles[2], 0, COLLAGE_TILE);
    canvas.composite(tiles[3], COLLAGE_TILE, COLLAGE_TILE);

    const jpegBytes = await canvas.encodeJPEG(85);
    const fileName = `${seller_id}/collage-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.jpg`;
    try {
      const url = await uploadToVps(fileName, jpegBytes, "image/jpeg");
      return url;
    } catch (e) {
      console.error("collage upload failed", e);
      return null;
    }
  } catch (e) {
    console.error("buildCollageAndUpload failed", e);
    return null;
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-webhook-signature, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const WASENDER_SEND_API = "https://www.wasenderapi.com/api/send-message";
const WASENDER_DECRYPT_API = "https://www.wasenderapi.com/api/decrypt-media";
const WASENDER_READ_API = "https://www.wasenderapi.com/api/messages/read";
const WAHA_BASE_URL = (Deno.env.get("WAHA_BASE_URL") || "").replace(/\/+$/, "");
const WAHA_API_KEY = Deno.env.get("WAHA_API_KEY") || "";
const STORAGE_BUCKET = "listing-images";

// ─── URL Sanitizer ─────────────────────────────────────
// The bot must never leak preview/hallucinated links. The only user-facing
// URL we allow the AI to produce in free text is the dashboard. Programmatic
// links (OnePay checkout, image URLs, seller storage URLs) are sent through
// dedicated paths that bypass this sanitizer.
const ALLOWED_URL_HOSTS = ["taktakmarket.buildstart.io"];
// Hosts whose URLs must pass through verbatim (payment gateways, WhatsApp
// deep-links, etc.). These are inserted programmatically by trusted paths.
const PASSTHROUGH_URL_HOSTS = ["onepay.lk", "ipg.onepay.lk", "wa.me", "api.whatsapp.com"];
const CANONICAL_DASHBOARD_URL = "https://taktakmarket.buildstart.io/login";

function sanitizeOutgoingUrls(text: string): string {
  if (!text) return text;
  return text.replace(/https?:\/\/[^\s)]+/gi, (match) => {
    try {
      const host = new URL(match).hostname.toLowerCase();
      if (PASSTHROUGH_URL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
        return match;
      }
      if (ALLOWED_URL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
        // Force any taktakmarket.buildstart.io/* link to the canonical dashboard URL
        // (guards against the AI inventing paths like /seller-dashboard).
        return CANONICAL_DASHBOARD_URL;
      }
      console.warn("sanitizeOutgoingUrls: stripped disallowed URL:", match);
      return CANONICAL_DASHBOARD_URL;
    } catch {
      return "";
    }
  });
}

// ─── DB resilience: retry transient failures, never stay silent ───────────
// Supabase/Postgres can briefly refuse connections ("connection timeout",
// "too many clients", fetch failures). Those are transient — retrying a few
// times with backoff recovers almost always. If it still fails, the caller
// sends the user a fallback WhatsApp message instead of dying silently.

const TRANSIENT_DB_PATTERNS = [
  "timeout",
  "timed out",
  "connection",
  "fetch failed",
  "network",
  "socket",
  "econnreset",
  "too many clients",
  "server is starting up",
  "shutting down",
  "503",
  "504",
  "upstream",
];

function isTransientDbError(err: any): boolean {
  const msg = `${err?.message || err?.error?.message || err || ""} ${err?.code || ""}`.toLowerCase();
  if (!msg.trim()) return false;
  return TRANSIENT_DB_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Run a Supabase query with automatic retries on transient DB failures.
 * Works with both thrown errors and PostgREST `{ data, error }` results.
 */
async function withDbRetry<T>(label: string, fn: () => PromiseLike<T>, attempts = 3): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res: any = await fn();
      if (res && typeof res === "object" && "error" in res && res.error && isTransientDbError(res.error)) {
        lastErr = res.error;
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;
      if (!isTransientDbError(e)) throw e;
    }
    if (i < attempts) {
      const wait = 400 * Math.pow(2, i - 1) + Math.floor(Math.random() * 250);
      console.warn(`DB retry ${i}/${attempts - 1} for "${label}" in ${wait}ms:`, String(lastErr?.message || lastErr));
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  console.error(`DB failed after ${attempts} attempts for "${label}":`, String(lastErr?.message || lastErr));
  throw Object.assign(new Error(`db_failed:${label}: ${lastErr?.message || lastErr}`), { transientDb: true });
}

// Avoid spamming the same user with fallback apologies.
const fallbackSentAt = new Map<string, number>();
const FALLBACK_COOLDOWN_MS = 10 * 60 * 1000;

const DB_FALLBACK_MESSAGE =
  "🙏 සමාවෙන්න! මේ මොහොතේ අපේ system එකේ කුඩා තාක්ෂණික බාධාවක් තියෙනවා. " +
  "ඔයාගේ message එක අපිට ලැබුණා ✅ — විනාඩි කිහිපයකින් නැවත message එකක් එවන්න, එවිට වහාම උත්තර දෙන්නම්. 💚\n\n" +
  "🙏 Sorry — we're having a brief technical issue. Your message was received; please send it again in a few minutes and we'll reply right away.";

async function sendDbFallbackMessage(phone: string, sessionApiKey: string) {
  if (!phone) return;
  const last = fallbackSentAt.get(phone) || 0;
  if (Date.now() - last < FALLBACK_COOLDOWN_MS) {
    console.log("Fallback message suppressed (cooldown) for", phone);
    return;
  }
  fallbackSentAt.set(phone, Date.now());
  try {
    await sendWhatsAppMessage(phone, DB_FALLBACK_MESSAGE, sessionApiKey);
    console.log("Fallback message sent to", phone);
  } catch (e) {
    console.error("Failed to send fallback message", e);
  }
}

export default async function(req: Request) {

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const payload = await req.json();
    console.log("Webhook received:", JSON.stringify(payload).slice(0, 500));

    if (payload.event === "messages.received" || payload.event === "messages.upsert") {
      const messages = normalizeMessages(payload);
      const sessionApiKey = payload.sessionId;

      if (!sessionApiKey) {
        console.error("No sessionId in webhook payload");
        return jsonResponse({ error: "No sessionId" });
      }

      // Store the session key for the cron notification function to use.
      // Non-fatal: a DB hiccup here must never block answering the user.
      try {
        await withDbRetry("storeSessionKey", () => storeSessionKey(supabase, sessionApiKey));
      } catch (e) {
        console.error("storeSessionKey failed (continuing):", String(e));
      }
      try {
        await withDbRetry("ensureBucket", () => ensureBucket(supabase));
      } catch (e) {
        console.error("ensureBucket failed (continuing):", String(e));
      }

      let currentPhone = "";
      try {
      for (const msg of messages) {

        const key = msg?.key;
        if (!key || key.fromMe) continue;

        const phone = extractPhoneNumber(key);
        if (phone) currentPhone = phone;
        const messageId = key?.id || "";

        // Skip reaction messages (emoji reactions on bot messages)
        const message = msg?.message || {};
        if (message.reactionMessage || message.protocolMessage) continue;

        const { text, mediaType, mediaInfo } = extractMessageContent(msg);

        if (!text && !mediaType) continue;
        if (!phone) continue;

        // Mark incoming message as read (blue ticks)
        await markMessageAsRead(key, sessionApiKey);

        // ─── PDF slips: never download or store. Ask for a screenshot instead ───
        {
          const docMime = String(mediaInfo?.mimetype || "").toLowerCase();
          const docName = String(mediaInfo?.fileName || mediaInfo?.title || "");
          const isPdf =
            mediaType === "document" &&
            (docMime.includes("pdf") || /\.pdf($|\?)/i.test(docName));
          if (isPdf) {
            console.log("wasender-webhook: PDF detected, asking for screenshot", { phone, docName, docMime });
            const pdfMsg =
              "🙏 ස්තූතියි! ඔබ එවා ඇත්තේ *PDF* ගොනුවක් — අපට PDF කියවන්න බැහැ. 😔\n\n" +
              "කරුණාකර *bank slip එකේ screenshot එකක් (image එකක්)* විදිහට එවන්න. එවිට වහාම verify කරලා දෙන්නම්. 📸\n\n" +
              "🙏 We can't read PDFs. Please send the payment slip as a *screenshot image* instead. 📸";
            try {
              await sendWhatsAppMessage(phone, pdfMsg, sessionApiKey);
            } catch (e) {
              console.error("wasender-webhook: failed to send PDF reply", e);
            }
            continue;
          }
        }

        // ─── Admin slip review decisions ("PAID <code>" / "NOT <code>") ───
        if (text && isSlipReviewAdmin(phone)) {
          try {
            const handled = await handleAdminSlipDecision(supabase, phone, text, msg, sessionApiKey);
            if (handled) continue;
          } catch (e) {
            console.error("handleAdminSlipDecision failed", e);
          }
        }




        const { data: user } = await withDbRetry("upsertUser", () =>
          supabase
            .from("marketplace_users")
            .upsert({ phone_number: phone }, { onConflict: "phone_number" })
            .select("id")
            .single());
        const userId = user?.id;


        // ─── REFERRAL: capture code sent by a brand-new user ───
        let referralCleanText = text || "";
        let selfReferralHandled = false;
        try {
          const incomingCode = extractReferralCode(text);
          if (incomingCode && userId) {
            // Did the user send their OWN link? Never stay silent — explain it.
            const { data: me } = await supabase
              .from("marketplace_users")
              .select("referral_code")
              .eq("id", userId)
              .maybeSingle();
            if (me?.referral_code && me.referral_code.toUpperCase() === incomingCode.toUpperCase()) {
              const refCfg = await getReferralConfig(supabase);
              const selfMsg = selfReferralMessage(referralLink(me.referral_code, refCfg.bot_number));
              await sendWhatsAppMessage(phone, selfMsg, sessionApiKey);
              await supabase.from("chat_messages").insert([
                { user_id: userId, phone_number: phone, direction: "incoming", message_text: text, message_type: "text" },
                { user_id: userId, phone_number: phone, direction: "outgoing", message_text: selfMsg, message_type: "text" },
              ]);
              selfReferralHandled = true;
            } else {
              const { count: priorIncoming } = await supabase
                .from("chat_messages")
                .select("id", { count: "exact", head: true })
                .eq("phone_number", phone)
                .eq("direction", "incoming");
              // only attributable while the user is brand new (no chat history yet)
              if ((priorIncoming ?? 0) === 0) {
                await attributeReferral(supabase, incomingCode, userId, phone);
              }
              referralCleanText = stripReferralCode(text);
            }
          }
        } catch (e) {
          console.error("referral capture failed", e);
        }
        if (selfReferralHandled) continue;


        let imageUrls: string[] = [];
        if (mediaType === "image" && mediaInfo) {
          try {
            const url = await decryptAndStoreMedia(supabase, sessionApiKey, messageId, mediaInfo, phone);
            if (url) imageUrls.push(url);
            console.log("Image saved:", url);
          } catch (e) {
            console.error("Image processing error:", e);
          }
        }

        const displayText =
          imageUrls.length > 0
            ? `${referralCleanText || ""} [📷 ${imageUrls.length} photo(s) attached]`.trim()
            : referralCleanText || "";

        const { data: insertedRow } = await withDbRetry("insertIncoming", () =>
          supabase
            .from("chat_messages")
            .insert({
              user_id: userId,
              phone_number: phone,
              direction: "incoming",
              message_text: displayText,
              message_type: mediaType || "text",
              metadata: { raw_key: key, image_urls: imageUrls, processed: false },
            })
            .select("id, created_at")
            .single());
        const insertedId = insertedRow?.id;


        // Payment slip verification must run before first-message welcome-mode.
        // A seller can send the bank slip as their first message after a pending listing,
        // and the generic welcome would otherwise intercept it and skip verification.
        if (imageUrls.length > 0 && userId) {
          const directSlipHandled = await handlePaymentSlip(supabase, userId, phone, imageUrls[0], sessionApiKey);
          if (directSlipHandled) {
            if (insertedId) {
              await supabase
                .from("chat_messages")
                .update({ metadata: { raw_key: key, image_urls: imageUrls, processed: true } })
                .eq("id", insertedId);
            }
            continue;
          }

          const orphanSlipHandled = await handleOrphanPaymentSlip(supabase, userId, phone, imageUrls[0], sessionApiKey);
          if (orphanSlipHandled) {
            if (insertedId) {
              await supabase
                .from("chat_messages")
                .update({ metadata: { raw_key: key, image_urls: imageUrls, processed: true } })
                .eq("id", insertedId);
            }
            continue;
          }
        }

        // Check for first-time user + bot welcome mode.
        // Guard against duplicate welcomes when the user sends two messages back-to-back
        // (two concurrent webhook invocations both see priorIncoming=1). We dedupe by
        // checking whether ANY outgoing message has ever been sent to this phone.
        const { count: priorOutgoingCount } = await withDbRetry("priorOutgoingCount", () =>
          supabase
            .from("chat_messages")
            .select("id", { count: "exact", head: true })
            .eq("phone_number", phone)
            .eq("direction", "outgoing"));


        if ((priorOutgoingCount ?? 0) === 0) {
          const { data: botSettingsRow } = await supabase
            .from("bot_settings")
            .select("value")
            .eq("key", "bot_mode")
            .single();

          const botSettings = botSettingsRow?.value as any;
          if (botSettings && botSettings.mode !== "off") {
            const welcomeMsg =
              botSettings.mode === "seller_first" ? botSettings.seller_first_message : botSettings.buyer_first_message;

            if (welcomeMsg) {
              // Insert the outgoing row FIRST so a concurrent invocation sees priorOutgoingCount>0
              // and skips its own welcome send.
              const { data: existingOut } = await supabase
                .from("chat_messages")
                .select("id")
                .eq("phone_number", phone)
                .eq("direction", "outgoing")
                .limit(1)
                .maybeSingle();
              if (!existingOut) {
                let finalWelcome = welcomeMsg;
                try {
                  const refCfg = await getReferralConfig(supabase);
                  if (refCfg.enabled && userId) {
                    const code = await ensureReferralCode(supabase, userId);
                    if (code) {
                      finalWelcome +=
                        `\n\n💰 *යාළුවෙක්ට share කරලා සල්ලි හොයාගන්න:*\n${referralLink(code, refCfg.bot_number)}\n` +
                        `ඔයාගේ link එකෙන් ආපු කෙනෙක් ad එකක් දැම්මොත් listing fee එකෙන් *${refCfg.seller_percent}%* ඔයාට. 🎁`;
                    }
                  }
                } catch (e) {
                  console.error("referral welcome append failed", e);
                }
                await supabase.from("chat_messages").insert({
                  user_id: userId,
                  phone_number: phone,
                  direction: "outgoing",
                  message_text: finalWelcome,
                  message_type: "text",
                });
                await sendWhatsAppMessage(phone, finalWelcome, sessionApiKey);
                continue;
              }
            }
          }
        }

        // ─── DEBOUNCE: batch rapid-fire messages ───
        // ALWAYS wait a short window (users often split one thought across several
        // short messages). If a newer incoming message arrives during/after the
        // wait, defer — that handler will answer the whole batch.
        // Images get a longer window because media rows land slower.
        {
          const windowMs = imageUrls.length > 0 ? 9000 : 7000;
          const deadline = Date.now() + windowMs;
          let deferred = false;

          while (Date.now() < deadline) {
            // Keep the "typing…" bubble alive while we wait (WhatsApp expires it ~10s)
            await sendTypingIndicator(sessionApiKey, phone, "composing");
            await delay(Math.min(2500, Math.max(500, deadline - Date.now())));
            const { data: latest } = await supabase
              .from("chat_messages")
              .select("id, created_at")
              .eq("phone_number", phone)
              .eq("direction", "incoming")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (latest && insertedId && latest.id !== insertedId) {
              console.log("Debounce: newer message arrived, deferring to that handler");
              deferred = true;
              break;
            }
          }
          if (deferred) {
            await sendTypingIndicator(sessionApiKey, phone, "paused");
            continue;
          }
          await sendTypingIndicator(sessionApiKey, phone, "composing");
        }


        // Aggregate all incoming messages since the last outgoing (one advertisement = one batch)
        const batch = await withDbRetry("aggregateBatch", () => aggregateUnansweredBatch(supabase, phone));
        const aggregatedText = batch.text;
        const aggregatedImages = batch.imageUrls;
        const onlyImagesNoText = !aggregatedText.trim() && aggregatedImages.length > 0;

        // If nothing to answer (all rows already processed by a concurrent handler), skip.
        if (batch.messageIds.length === 0) {
          console.log("Batch empty (already processed by concurrent handler), skipping.");
          continue;
        }

        // Mark all batched messages as processed — MERGE with existing metadata so image_urls survive
        for (const [id, meta] of Object.entries(batch.rawMetadata)) {
          await supabase
            .from("chat_messages")
            .update({ metadata: { ...(meta as any), processed: true } })
            .eq("id", id);
        }

        // Restart / cancel handler — clears any pending listing and bot_state
        if (userId && isRestartCommand(aggregatedText)) {
          const restartMsg = await handleRestart(supabase, userId, phone);
          await sendWhatsAppMessage(phone, restartMsg, sessionApiKey);
          await supabase.from("chat_messages").insert({
            user_id: userId,
            phone_number: phone,
            direction: "outgoing",
            message_text: restartMsg,
            message_type: "text",
          });
          continue;
        }

        // Check for STOP/unsubscribe command
        const stopResult = await handleUnsubscribe(supabase, userId, phone, aggregatedText);
        if (stopResult) {
          await sendWhatsAppMessage(phone, stopResult, sessionApiKey);
          await supabase.from("chat_messages").insert({
            user_id: userId,
            phone_number: phone,
            direction: "outgoing",
            message_text: stopResult,
            message_type: "text",
          });
          continue;
        }

        // Resend OnePay card-payment link if the seller asks for it while
        // they still have a pending payment. The AI has no memory of the
        // gateway URL, so without this it hallucinates a dashboard-login
        // reply instead of returning the actual checkout link.
        if (userId && looksLikeCardPaymentRequest(aggregatedText)) {
          const resent = await resendPendingPaymentLink(supabase, userId, phone, sessionApiKey);
          if (resent) continue;
        }

        // Check for DASHBOARD command
        if (aggregatedText.toLowerCase().trim() === "dashboard") {
          const dashboardUrl = "https://taktakmarket.buildstart.io/login";
          const dashMsg = `📊 *TakTak Seller Dashboard*\n\nTrack your listings, views, and inquiries here:\n${dashboardUrl}\n\n🔑 Use your WhatsApp number (+${phone}) to login. We'll send you an OTP to verify.\n\n_Your dashboard updates in real-time as buyers interact with your listings!_`;
          await sendWhatsAppMessage(phone, dashMsg, sessionApiKey);
          await supabase.from("chat_messages").insert({
            user_id: userId,
            phone_number: phone,
            direction: "outgoing",
            message_text: dashMsg,
            message_type: "text",
          });
          continue;
        }

        // OnePay reference lookup: user pasted/sent a TAK reference in chat.
        // Verify the payment regardless of whether the sender matches the payer.
        {
          const refMatch = aggregatedText.match(/\bTAK\d{6,}\b/i);
          if (refMatch) {
            const reference = refMatch[0].toUpperCase();
            const { data: payment } = await supabase
              .from("payments")
              .select("id, listing_id, seller_id, phone_number, amount, status")
              .eq("reference", reference)
              .maybeSingle();

            const chatUserId = userId || payment?.seller_id || null;

            // Skip duplicate outgoing "Payment received" within last 10 min for this phone
            const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            const { data: recentPayMsg } = await supabase
              .from("chat_messages")
              .select("id")
              .eq("phone_number", phone)
              .eq("direction", "outgoing")
              .gte("created_at", tenMinAgo)
              .or(
                "message_text.ilike.%Payment received%,message_text.ilike.%ගෙවීම දැනටමත්%,message_text.ilike.%not found%",
              )
              .limit(1)
              .maybeSingle();

            if (!payment) {
              const notFoundMsg = `⚠️ Reference *${reference}* අපගේ system එකේ හමු නොවීය (not found).\n\nකරුණාකර reference එක නැවත පරීක්ෂා කරන්න, හෝ ගෙවීම කළ WhatsApp number එකෙන්ම මෙය එවන්න. උදව් අවශ්‍ය නම් admin අප හා සම්බන්ධ වෙයි.`;
              await sendWhatsAppMessage(phone, notFoundMsg, sessionApiKey);
              await supabase.from("chat_messages").insert({
                user_id: chatUserId,
                phone_number: phone,
                direction: "outgoing",
                message_text: notFoundMsg,
                message_type: "text",
              });
              continue;
            }

            if (payment.status !== "paid") {
              // Reconcile as paid (WA-return / manual paste flow)
              await supabase
                .from("payments")
                .update({ status: "paid", gateway_response: { source: "wa_return", ref: reference } })
                .eq("id", payment.id);

              const { data: listing } = await supabase
                .from("listings")
                .update({
                  status: "active",
                  payment_status: "paid",
                  paid_at: new Date().toISOString(),
                })
                .eq("id", payment.listing_id)
                .select("id, title")
                .single();

              await supabase.from("revenue").insert({
                user_id: payment.seller_id,
                type: "listing_fee",
                amount: payment.amount,
                description: `Listing fee (OnePay ref ${reference})`,
              });

              notifyAdminsPayment({
                method: "card",
                seller_phone: payment.phone_number || phone,
                listing_title: listing?.title || "",
                amount: Number(payment.amount),
                reference,
              });

              if (!recentPayMsg) {
                const okMsg =
                  `✅ *Payment verified — LKR ${Number(payment.amount).toLocaleString()}*\n\n` +
                  `Listing *"${listing?.title || ""}"* දැන් *live*. Buyers ට එය සොයාගත හැක.\n\n` +
                  `📊 Reply *DASHBOARD* to track views & inquiries.`;
                await sendWhatsAppMessage(phone, okMsg, sessionApiKey);
                await supabase.from("chat_messages").insert({
                  user_id: chatUserId,
                  phone_number: phone,
                  direction: "outgoing",
                  message_text: okMsg,
                  message_type: "text",
                });
              }
              continue;
            }

            // Already paid — confirm
            if (!recentPayMsg) {
              const { data: listing } = await supabase
                .from("listings")
                .select("title, status")
                .eq("id", payment.listing_id)
                .maybeSingle();
              const dupMsg = `✅ ගෙවීම දැනටමත් *verified*.\n\n📝 Listing: *${listing?.title || ""}*\n💰 LKR ${Number(payment.amount).toLocaleString()}\n🔢 Ref: ${reference}\n\nListing එක දැනටමත් live. 📊 Reply *DASHBOARD* to track it.`;
              await sendWhatsAppMessage(phone, dupMsg, sessionApiKey);
              await supabase.from("chat_messages").insert({
                user_id: chatUserId,
                phone_number: phone,
                direction: "outgoing",
                message_text: dupMsg,
                message_type: "text",
              });
            }
            continue;
          }
        }

        // Payment slip verification: if user sent images and has a pending_payment listing
        if (aggregatedImages.length > 0 && userId) {
          const slipHandled = await handlePaymentSlip(supabase, userId, phone, aggregatedImages[0], sessionApiKey);
          if (slipHandled) continue;
        }

        // Text-only nudge: user says "paid/done/slip/ගෙව්වා" while a pending_payment listing exists
        if (
          userId &&
          aggregatedImages.length === 0 &&
          /\b(paid|done|slip|receipt|ගෙව්වා|ගෙවලා|රිසිට්|ස්ලිප්|ගෙවීම|செலுத்த|ரசீது)\b/i.test(aggregatedText)
        ) {
          const { data: pendingL } = await supabase
            .from("listings")
            .select("id, title, price")
            .eq("seller_id", userId)
            .eq("status", "pending_payment")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (pendingL) {
            const fee = feeForPrice(pendingL.price, await getFeeConfig(supabase));
            const nudge = `📤 *Payment Slip එක එවන්න*\n\nඔබගේ *"${pendingL.title}"* listing එක සඳහා bank slip photo එක මෙම chat එකටම එවන්න. මම එය තත්පර කිහිපයකින් verify කරන්නම්.\n\n*නිවැරදි විස්තර:*\n🏦 Commercial Bank – Dehiwala\n👤 BuildStart (Pvt) Ltd\n🔢 A/C: 1001075073\n💰 LKR ${fee.toLocaleString()}\n\n_Slip එකේ beneficiary නම, ගිණුම් අංකය, සහ මුදල පැහැදිලිව පෙනෙන photo එකක් එවන්න._`;
            await sendWhatsAppMessage(phone, nudge, sessionApiKey);
            await supabase.from("chat_messages").insert({
              user_id: userId,
              phone_number: phone,
              direction: "outgoing",
              message_text: nudge,
              message_type: "text",
            });
            continue;
          }
        }

        // Build display text for AI; if only images, instruct to reply in Sinhala
        const aiInputText = onlyImagesNoText
          ? `[USER_SENT_ONLY_IMAGES_NO_TEXT — reply in Sinhala. Ask for product name, price, condition, and location to create ONE listing from all photos.]`
          : aggregatedText;

        // Process with AI (all batched images treated as ONE advertisement)
        const aiResult = await processWithAI(supabase, userId, phone, aiInputText, aggregatedImages);

        // Handle subscription confirmation (user replied "2" or "notify" and AI detected it)
        if (aiResult.subscribeRequest && userId) {
          const subResult = await handleSubscription(supabase, userId, phone, aiResult.subscribeRequest);
          await sendWhatsAppMessage(phone, subResult, sessionApiKey);
          await supabase.from("chat_messages").insert({
            user_id: userId,
            phone_number: phone,
            direction: "outgoing",
            message_text: subResult,
            message_type: "text",
          });
          continue;
        }

        // Send messages based on result type
        if (aiResult.listingIds && aiResult.listingIds.length > 0) {
          // Fetch full listing data with seller info
          console.log("Fetching listings for IDs:", JSON.stringify(aiResult.listingIds));
          const { data: matchedListings, error: listingsError } = await supabase
            .from("listings")
            .select("id, title, price, city, district, condition, images, seller_id, additional_details")
            .in("id", aiResult.listingIds);

          console.log("Matched listings count:", matchedListings?.length, "error:", listingsError?.message);
          if (matchedListings && matchedListings.length > 0) {
            console.log("First listing images:", JSON.stringify(matchedListings[0].images));
          }

          const sellerIds = [...new Set((matchedListings || []).map((l: any) => l.seller_id))];
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

          // Send intro text if AI provided one (skip if empty)
          if (aiResult.introText && aiResult.introText.length > 2) {
            await sendWhatsAppMessage(phone, sanitizeOutgoingUrls(aiResult.introText), sessionApiKey);
            await delay(5500);
          }

          // Send each listing as image + caption
          const validListings = (matchedListings || []).filter((l: any) => l);
          console.log("Sending", validListings.length, "listings to", phone);
          for (let i = 0; i < validListings.length; i++) {
            const l = validListings[i];
            const sellerPhone = sellerPhones[l.seller_id] || "N/A";
            const caption = formatListingCaption(l, sellerPhone);
            const imagesArr = Array.isArray(l.images) ? l.images : [];
            const firstImage = imagesArr.length > 0 ? imagesArr[0] : null;

            console.log(
              `Listing ${i}: ${l.title}, images: ${imagesArr.length}, firstImage: ${firstImage?.slice(0, 80)}`,
            );

            if (firstImage && typeof firstImage === "string" && firstImage.startsWith("http")) {
              console.log("Sending IMAGE message for listing:", l.id);
              await sendWhatsAppImageMessage(phone, firstImage, caption, sessionApiKey);
            } else {
              console.log("Sending TEXT-ONLY for listing:", l.id);
              await sendWhatsAppMessage(phone, caption, sessionApiKey);
            }
            await delay(6000);
          }

          // Send follow-up options
          await delay(5500);
          const productName = aiResult.searchedProduct || "similar items";
          const parsedCriteria = fallbackParse(aggregatedText);
          const reqParts: string[] = [];
          if (parsedCriteria.location) reqParts.push(`*${parsedCriteria.location}* එකේ`);
          reqParts.push(`*${productName}*`);
          if (parsedCriteria.maxPrice) reqParts.push(`(රු. ${parsedCriteria.maxPrice.toLocaleString()} ට අඩු)`);
          const requirementLine = reqParts.join(" ");
          const followUp = `🔔 ඔයාට ${requirementLine} වල අලුත් විස්තර ලැබුනු ගමන් WhatsApp කරන්නද?`;
          await sendWhatsAppMessage(phone, followUp, sessionApiKey);

          // Referral: reward the referrer the first time this buyer actually searches
          if (userId) await awardBuyerReferral(supabase, userId);

          // Increment views_count and match_count for each suggested listing
          const listingIdsToUpdate = validListings.map((l: any) => l.id);
          if (listingIdsToUpdate.length > 0) {
            for (const lid of listingIdsToUpdate) {
              // Increment views_count by 1 (bot showed this to a buyer)
              const { data: currentListing } = await supabase
                .from("listings")
                .select("views_count, match_count")
                .eq("id", lid)
                .single();
              if (currentListing) {
                await supabase
                  .from("listings")
                  .update({
                    views_count: (currentListing.views_count || 0) + 1,
                    match_count: (currentListing.match_count || 0) + 1,
                  })
                  .eq("id", lid);
              }
            }
          }

          // Log full outgoing
          const fullOutgoing =
            (matchedListings || [])
              .map((l: any) => {
                const sp = sellerPhones[l.seller_id] || "N/A";
                return `📱 ${l.title} | LKR ${l.price} | ${l.city} | +${sp}`;
              })
              .join("\n") +
            "\n\n" +
            `Notify prompt sent`;

          await supabase.from("chat_messages").insert({
            user_id: userId,
            phone_number: phone,
            direction: "outgoing",
            message_text: (aiResult.introText || "") + "\n" + fullOutgoing,
            message_type: "text",
            metadata: { sent_listing_ids: validListings.map((l: any) => l.id) },
          });
        } else {
          // Plain text response — sanitize URLs so AI can't leak preview/hallucinated links
          const cleanText = sanitizeOutgoingUrls(aiResult.text);

          // Payment message: lead with the collage/cover preview so the seller sees
          // exactly what buyers will see — strong motivation to complete payment.
          if (aiResult.paymentPreviewImage) {
            const previewCap = sanitizeOutgoingUrls(aiResult.paymentPreviewCaption || "");
            await sendWhatsAppImageMessage(phone, aiResult.paymentPreviewImage, previewCap, sessionApiKey);
            await supabase.from("chat_messages").insert({
              user_id: userId,
              phone_number: phone,
              direction: "outgoing",
              message_text: previewCap,
              message_type: "image",
              metadata: { action: "payment_listing_preview", image_url: aiResult.paymentPreviewImage },
            });
            await delay(6000);
          }

          await sendWhatsAppMessage(phone, cleanText, sessionApiKey);
          await supabase.from("chat_messages").insert({
            user_id: userId,
            phone_number: phone,
            direction: "outgoing",
            message_text: cleanText,
            message_type: "text",
          });


          // Send listing preview card + dashboard prompt after creation
          if (aiResult.createdListing) {
            await delay(6000);
            const cl = aiResult.createdListing;
            const previewCaption = formatListingCaption(
              { ...cl, additional_details: cl.additional_details },
              cl.sellerPhone,
            );

            const firstImage = cl.images.length > 0 ? cl.images[0] : null;
            if (firstImage && typeof firstImage === "string" && firstImage.startsWith("http")) {
              await sendWhatsAppImageMessage(phone, firstImage, previewCaption, sessionApiKey);
            } else {
              await sendWhatsAppMessage(phone, previewCaption, sessionApiKey);
            }

            await delay(6000);
            const dashboardMsg =
              "📊 Want to track your product's views and inquiries on a dashboard?\nReply *DASHBOARD* to get your seller dashboard access link.";
            await sendWhatsAppMessage(phone, dashboardMsg, sessionApiKey);
          }
        }

        // Log search intent (best-effort — never fail the reply over this)
        if (userId) {
          try {
            await supabase.from("search_history").insert({
              user_id: userId,
              query_text: displayText,
              detected_intent: detectIntent(displayText),
            });
          } catch (e) {
            console.error("search_history insert failed (ignored):", String(e));
          }
        }
      }
      } catch (loopErr) {
        // Something (usually the database) failed mid-conversation. Never leave
        // the user in silence — apologise and ask them to resend.
        console.error("Message processing failed:", loopErr);
        await sendDbFallbackMessage(currentPhone, sessionApiKey);
        return jsonResponse({ error: String((loopErr as any)?.message || loopErr), fallback_sent: Boolean(currentPhone) });
      }
    }


    return jsonResponse({ success: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return jsonResponse({ error: error.message });
  }
}

// ─── Session Key Storage (for cron notifications) ────────

async function storeSessionKey(supabase: any, sessionKey: string) {
  // Keys of BOTH providers must survive: WAHA keys start with "waha:", Wasender
  // keys don't. Previously any inbound message overwrote the single stored row,
  // so a WAHA message wiped the Wasender key (and vice versa) — every cron
  // sender then failed with "invalid API key".
  const isWaha = sessionKey.startsWith("waha:");

  const { data: rows } = await supabase
    .from("chat_messages")
    .select("id, message_text")
    .eq("phone_number", "SYSTEM_SESSION_KEY")
    .limit(20);

  const sameProvider = (rows || []).find(
    (r: any) => typeof r.message_text === "string" && r.message_text.startsWith("waha:") === isWaha,
  );

  const metadata = { type: "session_key", provider: isWaha ? "waha" : "wasender", updated_at: new Date().toISOString() };

  if (sameProvider) {
    await supabase
      .from("chat_messages")
      .update({ message_text: sessionKey, metadata })
      .eq("id", sameProvider.id);
  } else {
    await supabase.from("chat_messages").insert({
      phone_number: "SYSTEM_SESSION_KEY",
      direction: "outgoing",
      message_text: sessionKey,
      message_type: "system",
      metadata,
    });
  }
}


// ─── Subscription Handling ───────────────────────────────

async function handleUnsubscribe(
  supabase: any,
  userId: string | null,
  phone: string,
  message: string,
): Promise<string | null> {
  const lower = message.toLowerCase().trim();
  if (!lower.startsWith("stop") && !lower.startsWith("unsubscribe")) return null;
  if (!userId) return "⚠️ Could not find your account. Please try again.";

  // Deactivate all active alerts for this user
  const { data: alerts } = await supabase
    .from("buyer_alerts")
    .select("id, search_query, product_keyword, location, max_price")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (!alerts || alerts.length === 0) {
    return "ℹ️ You don't have any active WhatsApp message subscriptions.";
  }

  // If user typed "STOP laptops" → deactivate specific alert
  const specificKeyword = lower.replace(/^(stop|unsubscribe)\s*/i, "").trim();

  if (specificKeyword) {
    const matchingAlert = alerts.find(
      (a: any) =>
        (a.product_keyword || "").toLowerCase().includes(specificKeyword) ||
        (a.search_query || "").toLowerCase().includes(specificKeyword),
    );
    if (matchingAlert) {
      await supabase.from("buyer_alerts").update({ is_active: false }).eq("id", matchingAlert.id);
      return `✅ Unsubscribed from *${matchingAlert.product_keyword || matchingAlert.search_query}* WhatsApp messages.`;
    }
  }

  // Deactivate all
  await supabase.from("buyer_alerts").update({ is_active: false }).eq("user_id", userId).eq("is_active", true);

  const alertSummary = alerts.map((a: any) => `• ${a.product_keyword || a.search_query}`).join("\n");
  return `✅ All WhatsApp message alerts unsubscribed:\n${alertSummary}\n\nYou can always subscribe again by searching and replying *2*.`;
}

async function handleSubscription(
  supabase: any,
  userId: string,
  phone: string,
  criteria: { product: string; location?: string; maxPrice?: number; category?: string },
): Promise<string> {
  // Check for existing active alert with same criteria
  const { data: existing } = await supabase
    .from("buyer_alerts")
    .select("id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .ilike("search_query", `%${criteria.product}%`)
    .limit(1);

  // Build a friendly Sinhala requirement summary including any special criteria
  const parts: string[] = [];
  if (criteria.location) parts.push(`*${criteria.location}* එකේ`);
  parts.push(`*${criteria.product}*`);
  if (criteria.maxPrice) parts.push(`(රු. ${criteria.maxPrice.toLocaleString()} ට අඩු)`);
  const requirementLine = parts.join(" ");

  if (existing && existing.length > 0) {
    return `සුපිරි! 🎯 ${requirementLine} වල විස්තර ලැබුනු ගමන් ඔයාට WhatsApp කරන්නම්. 📲\n\nඅයින් වෙන්න ඕන නම් *STOP ${criteria.product}* කියලා reply කරන්න.`;
  }

  const searchQuery = [
    criteria.product,
    criteria.location ? `in ${criteria.location}` : "",
    criteria.maxPrice ? `under LKR ${criteria.maxPrice.toLocaleString()}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  await supabase.from("buyer_alerts").insert({
    user_id: userId,
    search_query: searchQuery,
    product_keyword: criteria.product,
    location: criteria.location || null,
    max_price: criteria.maxPrice || null,
    category: criteria.category || null,
    is_active: true,
  });

  return `සුපිරි! 🎯 ${requirementLine} වල විස්තර ලැබුනු ගමන් ඔයාට WhatsApp message එකක් එවන්නම්. 📲\n\nඅලුත් listing එකක් ආවහම වහාම WhatsApp message එකකින් එවන්නම්. 💚\n\nඅයින් වෙන්න ඕන නම් *STOP ${criteria.product}* කියලා reply කරන්න.`;
}

// ─── Helpers ─────────────────────────────────────────────

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeMessages(payload: any): any[] {
  const raw = payload?.data?.messages ?? payload?.data;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return [raw];
  return [];
}

function extractPhoneNumber(key: any): string {
  const clean = (v: any) =>
    (typeof v === "string" ? v : "").replace("@s.whatsapp.net", "").replace("@c.us", "").replace(/\D/g, "");

  // Preferred: fields that always carry the real MSISDN.
  const cleanedSender = clean(key?.cleanedSenderPn);
  if (cleanedSender) return cleanedSender;
  const senderPn = clean(key?.senderPn);
  if (senderPn) return senderPn;
  const remoteJidAlt = clean(key?.remoteJidAlt);
  if (remoteJidAlt) return remoteJidAlt;
  const participantPn = clean(key?.participantPn);
  if (participantPn) return participantPn;

  // Fallback: remoteJid. Reject @lid pseudo-IDs — those digits are NOT the
  // user's phone number and storing them creates orphaned accounts that can
  // never sign in via OTP.
  const remoteJid = typeof key?.remoteJid === "string" ? key.remoteJid : "";
  if (remoteJid.endsWith("@lid")) {
    console.warn("extractPhoneNumber: dropping @lid without real phone", remoteJid);
    return "";
  }
  return clean(remoteJid);
}

function extractMessageContent(msg: any): {
  text: string;
  mediaType: string | null;
  mediaInfo: any | null;
} {
  const originalMessage = msg?.message || {};
  const message =
    originalMessage?.viewOnceMessage?.message ||
    originalMessage?.viewOnceMessageV2?.message ||
    originalMessage?.documentWithCaptionMessage?.message ||
    originalMessage;
  const messageBody = msg?.messageBody || "";

  const mediaKeys: Record<string, string> = {
    imageMessage: "image",
    videoMessage: "video",
    audioMessage: "audio",
    documentMessage: "document",
    stickerMessage: "sticker",
  };

  for (const [key, type] of Object.entries(mediaKeys)) {
    if (message[key]) {
      const caption = message[key]?.caption || messageBody || "";
      const mimetype = message[key]?.mimetype || "";
      const normalizedType = key === "documentMessage" && mimetype.startsWith("image/") ? "image" : type;
      return { text: caption, mediaType: normalizedType, mediaInfo: { ...message[key], _key: key } };
    }
  }

  const text = messageBody || message.conversation || message.extendedTextMessage?.text || "";
  return { text, mediaType: null, mediaInfo: null };
}

// ─── Manual slip review (admin-in-the-loop) ──────────────
// Slips the AI cannot verify are forwarded to a private review group of admin
// numbers. Sellers NEVER see these numbers — they only get the normal
// "we're checking your slip" style reply.
const SLIP_REVIEW_ADMINS = ["94765225044", "94711365928", "94760032274"];

function isSlipReviewAdmin(phone: string): boolean {
  const digits = String(phone || "").replace(/\D/g, "");
  return SLIP_REVIEW_ADMINS.some((a) => digits.endsWith(a.slice(-9)));
}

function newReviewCode(): string {
  return `RV${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

// Forward an unverifiable slip to the review admins and return the review code.
async function forwardSlipForReview(
  supabase: any,
  opts: {
    imageUrl: string;
    sellerPhone: string;
    sellerId: string | null;
    listingId: string | null;
    listingTitle: string;
    expectedFee: number;
    reason: string;
    extracted: any;
  },
): Promise<string> {
  const code = newReviewCode();
  try {
    await supabase.from("payments").insert({
      reference: `SLIP-RV-${code}`,
      listing_id: opts.listingId,
      seller_id: opts.sellerId,
      phone_number: opts.sellerPhone,
      amount: Number(opts.extracted?.amount || 0),
      currency: opts.extracted?.currency || "LKR",
      status: "manual_review",
      provider: "bank_transfer",
      gateway_response: {
        slip_url: opts.imageUrl,
        extracted: opts.extracted || null,
        failure_reason: opts.reason,
        review_code: code,
        review_status: "pending",
        expected_fee: opts.expectedFee,
      },
    });
  } catch (e) {
    console.error("forwardSlipForReview: payment insert failed", e);
  }

  const caption =
    `🧾 *Slip needs manual review*\n\n` +
    `👤 Seller: +${opts.sellerPhone}\n` +
    (opts.listingTitle ? `📝 Listing: ${opts.listingTitle}\n` : `📝 Listing: (none / orphan slip)\n`) +
    (opts.expectedFee ? `💰 Expected: LKR ${opts.expectedFee.toLocaleString()}\n` : "") +
    (opts.extracted?.amount ? `💵 Read amount: LKR ${Number(opts.extracted.amount).toLocaleString()}\n` : "") +
    `⚠️ Reason: ${opts.reason}\n` +
    `🔢 Code: *${code}*\n\n` +
    `Reply *PAID ${code}* to approve, or *NOT ${code}* to reject.\n` +
    `_(You can also just reply to this message with "paid" or "not".)_`;

  for (const admin of SLIP_REVIEW_ADMINS) {
    try {
      const r = await sendWhatsAppImage(supabase, admin, opts.imageUrl, caption);
      console.log("slip review forward:", admin, JSON.stringify(r));
    } catch (e) {
      console.error("slip review forward failed", admin, e);
    }
    await delay(6000);
  }
  return code;
}

function extractQuotedText(msg: any): string {
  const m = msg?.message || {};
  const ctx =
    m?.extendedTextMessage?.contextInfo ||
    m?.imageMessage?.contextInfo ||
    m?.contextInfo ||
    null;
  const q = ctx?.quotedMessage || null;
  if (!q) return "";
  return (
    q?.conversation ||
    q?.extendedTextMessage?.text ||
    q?.imageMessage?.caption ||
    q?.documentMessage?.caption ||
    ""
  );
}

// Handles "PAID <code>" / "NOT <code>" replies from the review admins.
async function handleAdminSlipDecision(
  supabase: any,
  phone: string,
  text: string,
  rawMsg: any,
  sessionApiKey: string,
): Promise<boolean> {
  if (!isSlipReviewAdmin(phone)) return false;
  const body = String(text || "").trim();
  if (!body) return false;

  const decisionMatch = /^\s*(paid|approve|approved|ok|yes|not|no|reject|rejected)\b/i.exec(body);
  if (!decisionMatch) return false;
  const word = decisionMatch[1].toLowerCase();
  const approve = ["paid", "approve", "approved", "ok", "yes"].includes(word);

  // Code can come from the message itself or from the quoted review message.
  const codeFrom = (s: string) => (/\bRV[A-Z0-9]{4,6}\b/i.exec(s || "")?.[0] || "").toUpperCase();
  const code = codeFrom(body) || codeFrom(extractQuotedText(rawMsg));

  let q = supabase
    .from("payments")
    .select("id, listing_id, seller_id, phone_number, amount, gateway_response")
    .eq("status", "manual_review")
    .eq("gateway_response->>review_status", "pending")
    .order("created_at", { ascending: false })
    .limit(1);
  if (code) q = q.eq("gateway_response->>review_code", code);
  const { data: review } = await q.maybeSingle();

  if (!review) {
    if (code) {
      await sendWhatsAppMessage(phone, `⚠️ No pending slip review found for code *${code}*.`, sessionApiKey);
      return true;
    }
    return false; // plain "paid"/"no" from an admin with nothing pending → normal bot flow
  }

  const gr = review.gateway_response || {};
  const sellerPhone = review.phone_number;
  const expectedFee = Number(gr.expected_fee || 0);
  const amount = Number(review.amount || 0) || expectedFee;

  if (!approve) {
    await supabase
      .from("payments")
      .update({
        status: "failed",
        gateway_response: { ...gr, review_status: "rejected", reviewed_by: phone, reviewed_at: new Date().toISOString() },
      })
      .eq("id", review.id);
    const msg =
      `⚠️ ඔබ එවූ Payment Slip එක තහවුරු කරගන්න බැරි වුණා.\n\n` +
      `කරුණාකර ගෙවීම නිවැරදිව සිදුකර, *පැහැදිලි slip photo* එකක් නැවත එවන්න.\n\n` +
      `🏦 Commercial Bank – Dehiwala\n👤 BuildStart (Pvt) Ltd\n🔢 1001075073` +
      (expectedFee ? `\n💰 LKR ${expectedFee.toLocaleString()}` : "");
    if (sellerPhone) {
      await sendWhatsAppMessage(sellerPhone, msg, sessionApiKey);
      await supabase.from("chat_messages").insert({
        user_id: review.seller_id,
        phone_number: sellerPhone,
        direction: "outgoing",
        message_text: msg,
        message_type: "text",
      });
    }
    await sendWhatsAppMessage(phone, `❌ Rejected *${gr.review_code || ""}* — seller informed.`, sessionApiKey);
    return true;
  }

  // Approve
  let listing: any = null;
  if (review.listing_id) {
    const { data } = await supabase
      .from("listings")
      .update({ status: "active", payment_status: "paid", paid_at: new Date().toISOString() })
      .eq("id", review.listing_id)
      .select("id, title, price")
      .maybeSingle();
    listing = data;
  }

  await supabase
    .from("payments")
    .update({
      status: "paid",
      amount,
      gateway_response: { ...gr, review_status: "approved", reviewed_by: phone, reviewed_at: new Date().toISOString() },
    })
    .eq("id", review.id);

  await supabase.from("revenue").insert({
    user_id: review.seller_id,
    type: "listing_fee",
    amount,
    description: `Bank slip manual approval (${gr.review_code || review.id})`,
  });

  notifyAdminsPayment({
    method: "manual",
    seller_phone: sellerPhone || "",
    listing_title: listing?.title || "",
    amount,
    reference: gr.review_code || "",
  });

  if (review.seller_id) {
    await updateBotState(supabase, review.seller_id, { mode: "idle", pending_listing_id: null, last_question: null });
  }

  if (sellerPhone) {
    const okMsg =
      `✅ *Payment Verified!*\n\n` +
      (listing?.title ? `📝 *Listing:* ${listing.title}\n` : "") +
      `💰 *Amount:* LKR ${amount.toLocaleString()}\n\n` +
      `🎉 ඔබගේ Listing එක දැන් ක්‍රියාත්මකයි! Buyers ට එය සෙවිය හැක.`;
    await sendWhatsAppMessage(sellerPhone, okMsg, sessionApiKey);
    await supabase.from("chat_messages").insert({
      user_id: review.seller_id,
      phone_number: sellerPhone,
      direction: "outgoing",
      message_text: okMsg,
      message_type: "text",
    });
  }

  try {
    if (review.seller_id && review.listing_id) {
      await awardSellerReferral(supabase, review.seller_id, review.listing_id, amount);
    }
  } catch (e) {
    console.error("awardSellerReferral (manual review) failed", e);
  }
  if (review.seller_id && sellerPhone) {
    await delay(7000);
    await sendReferralPromo(supabase, review.seller_id, sellerPhone);
  }

  await sendWhatsAppMessage(phone, `✅ Approved *${gr.review_code || ""}* — listing is live.`, sessionApiKey);
  return true;
}



// ─── Listing Caption Formatter (shared) ──────────────────

function formatListingCaption(l: any, sellerPhone: string): string {
  const imagesArr = Array.isArray(l.images) ? l.images : [];
  const details =
    l.additional_details && typeof l.additional_details === "object"
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
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Media Processing ────────────────────────────────────

async function ensureBucket(supabase: any) {
  try {
    const { error } = await supabase.storage.createBucket(STORAGE_BUCKET, {
      public: true,
      fileSizeLimit: 10 * 1024 * 1024,
    });
    if (error && !error.message?.includes("already exists")) {
      console.error("Bucket creation error:", error.message);
    }
  } catch (_e) {}
}

async function decryptAndStoreMedia(
  supabase: any,
  sessionApiKey: string,
  messageId: string,
  mediaInfo: any,
  phone: string,
): Promise<string | null> {
  if (mediaInfo?._wahaDirect) {
    return await downloadAndStoreWahaMedia(supabase, sessionApiKey, messageId, mediaInfo, phone);
  }

  const mediaKey = mediaInfo._key;
  const decryptPayload = {
    data: {
      messages: {
        key: { id: messageId },
        message: {
          [mediaKey]: {
            url: mediaInfo.url,
            mimetype: mediaInfo.mimetype,
            mediaKey: mediaInfo.mediaKey,
            fileSha256: mediaInfo.fileSha256,
            fileLength: mediaInfo.fileLength,
          },
        },
      },
    },
  };

  console.log("Calling decrypt-media for message:", messageId);

  const decryptRes = await fetch(WASENDER_DECRYPT_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(decryptPayload),
  });

  if (!decryptRes.ok) {
    const err = await decryptRes.text();
    console.error("Decrypt API error:", decryptRes.status, err);
    return null;
  }

  const decryptData = await decryptRes.json();
  const publicUrl = decryptData?.publicUrl;

  if (!publicUrl) {
    console.error("No publicUrl from decrypt API:", JSON.stringify(decryptData));
    return null;
  }

  console.log("Decrypted media URL:", publicUrl);

  const imageRes = await fetch(publicUrl);
  if (!imageRes.ok) {
    console.error("Failed to download decrypted image:", imageRes.status);
    return null;
  }

  const imageBlob = await imageRes.arrayBuffer();
  const mimetype = mediaInfo.mimetype || "image/jpeg";
  const ext = mimetype.split("/")[1] || "jpg";
  const fileName = `${phone}/${Date.now()}_${messageId}.${ext}`;

  try {
    const url = await uploadToVps(fileName, imageBlob, mimetype);
    return url;
  } catch (e) {
    console.error("VPS storage upload error:", (e as Error).message);
    return publicUrl;
  }
}

async function downloadAndStoreWahaMedia(
  supabase: any,
  sessionApiKey: string,
  messageId: string,
  mediaInfo: any,
  phone: string,
): Promise<string | null> {
  try {
    let mediaUrl = normalizeWahaMediaUrl(mediaInfo?._wahaMediaUrl || mediaInfo?.url || "");

    if (!mediaUrl && mediaInfo?._wahaChatId && mediaInfo?._wahaMessageId) {
      const session = encodeURIComponent(wahaSessionName(sessionApiKey));
      const chatId = encodeURIComponent(mediaInfo._wahaChatId);
      const id = encodeURIComponent(mediaInfo._wahaMessageId);
      const msgRes = await wahaFetch(`/api/${session}/chats/${chatId}/messages/${id}?downloadMedia=true`);
      if (msgRes.ok) {
        const msgJson = await msgRes.json().catch(() => null);
        mediaUrl = normalizeWahaMediaUrl(msgJson?.media?.url || msgJson?.payload?.media?.url || "");
      } else {
        console.error("WAHA media lookup error:", msgRes.status, await msgRes.text());
      }
    }

    if (!mediaUrl) {
      console.error("WAHA image had no downloadable media URL", {
        messageId,
        mediaError: mediaInfo?._wahaMediaError || null,
      });
      return null;
    }

    console.log("Downloading WAHA media:", mediaUrl.slice(0, 120));
    const mediaRes = await wahaFetch(mediaUrl);
    if (!mediaRes.ok) {
      console.error("WAHA media download error:", mediaRes.status, await mediaRes.text());
      return null;
    }

    const imageBlob = await mediaRes.arrayBuffer();
    const mimetype = mediaInfo?.mimetype || mediaRes.headers.get("Content-Type") || "image/jpeg";
    const ext = extensionFromMime(mimetype);
    const safeMessageId = String(messageId || Date.now()).replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileName = `${phone}/${Date.now()}_${safeMessageId}.${ext}`;

    // Primary: upload to VPS S3 bucket (same as Wasender path) so all
    // WhatsApp-received images live in the user's own storage bucket.
    try {
      const url = await uploadToVps(fileName, imageBlob, mimetype);
      return url;
    } catch (e) {
      console.error("WAHA VPS storage upload error:", (e as Error).message);
    }

    // Fallback: Supabase storage bucket if VPS upload fails.
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(fileName, imageBlob, { contentType: mimetype, upsert: true });

    if (!uploadError) {
      const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(fileName);
      return data?.publicUrl || null;
    }

    console.error("WAHA storage upload error:", uploadError.message);
    return null;
  } catch (e) {
    console.error("WAHA media processing error:", e);
    return null;
  }
}

function normalizeWahaMediaUrl(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if ((parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") && WAHA_BASE_URL) {
      return `${WAHA_BASE_URL}${parsed.pathname}${parsed.search}`;
    }
    return url;
  } catch {
    if (url.startsWith("/")) return `${WAHA_BASE_URL}${url}`;
    return url;
  }
}

function isPublicImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.pathname.includes("/storage/v1/object/public/");
  } catch {
    return false;
  }
}

function extensionFromMime(mimetype: string): string {
  const clean = String(mimetype || "image/jpeg")
    .split(";")[0]
    .toLowerCase();
  if (clean.includes("png")) return "png";
  if (clean.includes("webp")) return "webp";
  if (clean.includes("gif")) return "gif";
  return "jpg";
}

// ─── AI Processing ───────────────────────────────────────

interface AIResult {
  text: string;
  listingIds?: string[];
  introText?: string;
  searchedProduct?: string;
  allListed?: boolean;
  subscribeRequest?: {
    product: string;
    location?: string;
    maxPrice?: number;
    category?: string;
  };
  createdListing?: {
    id: string;
    title: string;
    price: number;
    city: string;
    district: string;
    condition: string;
    images: string[];
    additional_details: Record<string, any>;
    sellerPhone: string;
  };
  /** Cover/collage image sent together with the payment message (seller motivation). */
  paymentPreviewImage?: string | null;
  /** Caption for the payment preview image (buyer-view card). */
  paymentPreviewCaption?: string;
}


async function processWithAI(
  supabase: any,
  userId: string | null,
  phone: string,
  message: string,
  imageUrls: string[] = [],
): Promise<AIResult> {
  // Check if user replied "notify" → extract subscription criteria from recent context.
  // NOTE: bare "2" is NOT treated as subscribe — it collides with listing-selection ("show me #2"),
  // buyer/seller welcome-mode shortcut, and other numeric picks. Only treat "2" as subscribe if the
  // last outgoing bot message explicitly offered the "reply *2*" notify prompt.
  const lowerMsg = message.toLowerCase().trim();
  const isExplicitNotify = lowerMsg === "notify" || lowerMsg === "notify me" || lowerMsg.includes("notify me when");
  const isYesReply =
    /^(ඔව්+|ow|owu|owa|හා+|haa+|ha|හරි|hari|yes|y|yeah|yep|ya|sure|ok+|okay|k|send|please|plz|pls|ඕන|ona|one|ඕනේ|ஆம்|ஆமா|சரி)\.?!?$/i.test(
      lowerMsg,
    );
  let isContextualNotify = false;
  if (lowerMsg === "2" || isYesReply) {
    const { data: lastOut } = await supabase
      .from("chat_messages")
      .select("message_text")
      .eq("phone_number", phone)
      .eq("direction", "outgoing")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastText = (lastOut?.message_text || "").toLowerCase();
    isContextualNotify = /(whatsapp කරන්නද|notify|දැනුම්|දැනුවත්|alert|ලැබුනු ගමන්)/i.test(lastText);
  }
  if (isExplicitNotify || isContextualNotify) {
    const subCriteria = await extractSubscriptionCriteria(supabase, phone);
    if (subCriteria) {
      return { text: "", subscribeRequest: subCriteria };
    }
  }

  const { data: history } = await supabase
    .from("chat_messages")
    .select("direction, message_text, metadata")
    .eq("phone_number", phone)
    .order("created_at", { ascending: false })
    .limit(40);

  // Collect previously sent listing IDs from metadata
  const previouslySentIds: string[] = [];
  for (const m of history || []) {
    const sentIds = (m.metadata as any)?.sent_listing_ids;
    if (Array.isArray(sentIds)) {
      previouslySentIds.push(...sentIds);
    }
  }
  const sentIdSet = new Set(previouslySentIds);
  console.log("Previously sent listing IDs:", previouslySentIds.length);

  const chatHistory = (history || [])
    .reverse()
    .map((m: any) => {
      const imgs = (m.metadata as any)?.image_urls;
      const txt = (m.message_text || "").trim();
      const content = txt || (Array.isArray(imgs) && imgs.length ? `[sent ${imgs.length} photo(s)]` : "");
      return { role: m.direction === "incoming" ? "user" : "assistant", content };
    })
    .filter((m: any) => m.content);

  // Anti-loop guard: count how many questions the bot has already asked in the
  // recent turns. Sellers churn when they answer and get asked again, so after
  // two asks we STOP collecting and move straight to publishing + payment.
  const recentTurns = (history || []).slice(-12);
  const botAskCount = recentTurns.filter(
    (m: any) => m.direction === "outgoing" && /[?？]/.test(m.message_text || ""),
  ).length;
  const stopAskingRule =
    botAskCount >= 2
      ? `\n\n🚫 STOP-ASKING OVERRIDE (HIGHEST PRIORITY):\nYou have already asked this user ${botAskCount} question message(s) in this conversation. Do NOT ask for any more details. Take everything already given anywhere in the chat history, fill any missing optional field by leaving it out, use "good" for condition and the user's known city/district (or "Colombo"/"Colombo" if truly unknown) and emit SYSTEM_CREATE_LISTING NOW in this reply. Never repeat a question the user already answered.`
      : "";


  // AI-based intent classification (replaces brittle regex). If images are
  // present it's always a selling flow. Otherwise ask a tiny/fast model to
  // classify so we can skip the expensive listings fetch for greetings and
  // sellers. Falls back to a safe regex only if the AI call fails.
  const isNonSearchIntent = await classifyNonSearchIntent(message, imageUrls.length > 0);

  let listingsContext = "";
  if (!isNonSearchIntent) {
    // Step 1: Extract search keywords using AI NLU
    const searchCriteria = await parseAlertWithAI(message);
    const keywords = extractSearchKeywords(message, searchCriteria);
    console.log("Search keywords:", JSON.stringify(keywords), "criteria:", JSON.stringify(searchCriteria));

    // Step 2: Fetch ALL active listings
    let allListings: any[] = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data } = await supabase
        .from("listings")
        .select(
          "id, title, description, price, city, district, condition, category, images, seller_id, additional_details",
        )
        .eq("status", "active")
        .range(from, from + pageSize - 1);
      if (data && data.length > 0) {
        allListings = allListings.concat(data);
        if (data.length < pageSize) break;
        from += pageSize;
      } else break;
    }
    console.log("Total active listings:", allListings.length);

    // Step 3: Score and rank listings by keyword relevance
    const scored = allListings.map((l: any) => {
      const score = scoreListingRelevance(l, keywords, searchCriteria);
      return { ...l, _score: score };
    });

    // Filter out zero-score listings, sort by score desc, take top 15 for AI context
    const matched = scored
      .filter((l: any) => l._score > 0)
      .sort((a: any, b: any) => b._score - a._score)
      .slice(0, 15);

    console.log(
      "Matched listings:",
      matched.length,
      "top scores:",
      matched.slice(0, 5).map((l: any) => `${l.title}:${l._score}`),
    );

    // If no keyword matches, fall back to latest 10 listings for AI to work with
    let listingsToShow = matched.length > 0 ? matched : allListings.slice(0, 10);

    // HARD dedup: strip already-sent listings so the AI can't repeat them
    // (soft "do not include" instructions in the prompt are unreliable).
    const beforeDedup = listingsToShow.length;
    listingsToShow = listingsToShow.filter((l: any) => !sentIdSet.has(l.id));
    if (beforeDedup !== listingsToShow.length) {
      console.log(`Dedup filtered ${beforeDedup - listingsToShow.length} already-sent listings`);
    }

    const sellerIds = [...new Set(listingsToShow.map((l: any) => l.seller_id))];
    let sellerPhones: Record<string, string> = {};
    if (sellerIds.length > 0) {
      const { data: sellers } = await supabase.from("marketplace_users").select("id, phone_number").in("id", sellerIds);
      for (const s of sellers || []) {
        sellerPhones[s.id] = s.phone_number;
      }
    }

    listingsContext = listingsToShow
      .map((l: any) => {
        const sp = sellerPhones[l.seller_id] || "N/A";
        const hasImages = (l.images || []).length > 0;
        const scoreLabel = l._score ? ` | Relevance:${l._score}` : "";
        return `ID:${l.id} | ${l.title} | LKR ${l.price} | ${l.city}, ${l.district} | ${l.condition} | Category:${l.category || "N/A"} | HasImages:${hasImages} | Seller:+${sp}${scoreLabel}`;
      })
      .join("\n");
  }

  const imageContext =
    imageUrls.length > 0
      ? `\n\nIMAGE HANDLING (CRITICAL):\n- The user sent ${imageUrls.length} photo(s) in one batch. ALL these images belong to ONE single advertisement/listing. Do NOT create multiple listings.\n- Acknowledge count naturally: "📸 Got your ${imageUrls.length} photo${imageUrls.length > 1 ? "s" : ""}!"\n- Maximum ${MAX_IMAGES_PER_LISTING} photos per listing. If more are sent, only the first ${MAX_IMAGES_PER_LISTING} will be kept — mention this politely if it applies.\n- The system will auto-generate a 2×2 collage thumbnail from the first 4 photos and keep every original as a gallery image. Do NOT ask the user to combine or resend anything.\n- Image URLs (deduplicated): ${imageUrls.join(", ")}\n- If the user is in a SELLING flow, save ALL these images to the SAME listing.\n- If no caption/text was provided with the photos, respond in *Sinhala* and ask for: product name, price, condition (new/used), and city/district — needed to publish ONE listing with all these photos.\n- Never ask them to resend photos. Never acknowledge photos multiple times.`
      : "";

  const alreadySentContext =
    sentIdSet.size > 0
      ? `\n\nALREADY SHOWN LISTING IDS (do NOT include these again):\n${[...sentIdSet].join(", ")}`
      : "";

  // Fetch bot mode settings for dynamic greeting
  const { data: botSettingsRow } = await supabase.from("bot_settings").select("value").eq("key", "bot_mode").single();
  const botSettings = botSettingsRow?.value as any;

  const greetingRule =
    botSettings && botSettings.mode !== "off"
      ? `7. For greetings, use this EXACT configured welcome message:\n"${botSettings.mode === "seller_first" ? botSettings.seller_first_message : botSettings.buyer_first_message}"`
      : `7. For greetings, use this EXACT message:\n"ඔයා මිලදී ගන්න හොයන්නේ කුමක්ද?\\n\\n(වාහන, ඉඩම්, ගෙවල්, Phones)\\n\\nඔයාට විකුනගන්න යමක් තියෙනව නම් photo එකක් සමග විස්තර එවන්න"`;

  // First reply to this user? (no prior assistant message in loaded history)
  const isFirstReply = !(chatHistory || []).some((m: any) => m.role === "assistant");
  const firstReplyRule = isFirstReply
    ? `\nFIRST-REPLY LANGUAGE OVERRIDE (CRITICAL): This is the user's FIRST message to TakTak and our FIRST response to them. Reply in *Sinhala* ONLY, even if the user wrote in English or Tamil. From the second reply onward, follow the normal DEFAULT LANGUAGE rule (mirror the user's language).`
    : "";

  // Meta / WhatsApp Business auto-generated inquiry messages (from click-to-chat
  // buttons like "Message" on a catalog/business profile). These are NOT the
  // user's own language choice — always reply in Sinhala.
  const metaAutoPatterns = [
    /^\s*hello[!.]?\s*can i get more info on this\??\s*$/i,
    /^\s*hi[!.]?\s*can i get more info on this\??\s*$/i,
    /^\s*hello[!.]?\s*i'?m interested in.*$/i,
    /^\s*hi[!.]?\s*i'?m interested in.*$/i,
  ];
  const isMetaAutoMessage = metaAutoPatterns.some((r) => r.test(String(message || "")));
  const metaAutoRule = isMetaAutoMessage
    ? `\nMETA AUTO-MESSAGE OVERRIDE (CRITICAL): The user's message is an *auto-generated WhatsApp Business inquiry* (e.g. "Hello! Can I get more info on this?") — it does NOT reflect their preferred language. You MUST reply in *Sinhala* only, regardless of the English wording. Ignore the DEFAULT LANGUAGE mirroring rule for this turn.`
    : "";

  // Load per-user context (profile, pending payment listing, active listings, bot state)
  const userContext = await loadUserContext(supabase, userId, phone);

  // Admin-configurable listing fee (single source of truth)
  const feeCfg = await getFeeConfig(supabase);

  // ─── Referral knowledge: the user's own link is always available to the AI ───
  let referralRule = "";
  try {
    const refCfgPrompt = await getReferralConfig(supabase);
    if (refCfgPrompt.enabled && userId) {
      const myCode = await ensureReferralCode(supabase, userId);
      if (myCode) {
        const myLink = referralLink(myCode, refCfgPrompt.bot_number);
        referralRule = `

REFERRAL PROGRAM (answer confidently whenever the user asks about "referral", "refer", "රෙෆරල්", "link එක", "සල්ලි හොයන්නේ කොහොමද", "earn money", "commission", or asks for their link):
- Every TakTak user has their OWN referral link. THIS user's link is: ${myLink} (code: ${myCode}).
- ALWAYS give them this exact link whenever they ask for it — at any point in the conversation. Never invent another link or code.
- How it works: they share the link with friends/groups → a NEW person opens it and chats with TakTak.
   • If that new person publishes a PAID listing → this user earns *${refCfgPrompt.seller_percent}%* of that listing fee.
   • If that new person searches for something → this user earns *LKR ${refCfgPrompt.buyer_reward}*.
- Only *brand-new* numbers count. Clicking or sending their OWN link earns nothing — tell them politely to share it with others instead.
- Earnings are shown and can be claimed (redeemed to their bank account) after logging in at ${CANONICAL_DASHBOARD_URL}. Minimum redeem amount is *LKR ${refCfgPrompt.min_redeem.toLocaleString()}*.
- Rewards are credited automatically and the user gets a WhatsApp message each time they earn.`;
      }
    }
  } catch (e) {
    console.error("referral prompt build failed", e);
  }

  const systemPrompt = `You are the AI assistant for TakTak AI Marketplace, a WhatsApp-based second-hand marketplace in Sri Lanka.
You understand Sinhala, Tamil, English, and mixed Sri Lankan typing styles.
${userContext}

${listingsContext ? `AVAILABLE LISTINGS (pre-filtered and ranked by relevance — higher Relevance score = better match):\n${listingsContext}\n\nIMPORTANT: Pick the TOP 3-5 listings with the HIGHEST Relevance scores. These are already matched to the user's search query.` : "NO LISTINGS LOADED — this is a greeting or non-search message. Do NOT suggest or show any listings."}

${imageContext}
${alreadySentContext}

ROUTING TAGS — every reply MUST classify the user's intent using EXACTLY ONE of these tags, output on its own line at the END of your message. The system parses these tags to route behavior; free prose alone is NOT enough.

  • SHOW_LISTINGS:id1,id2,...     → buyer wants to see matching items (also emit SEARCHED_PRODUCT:name on the next line)
  • ALL_LISTED                    → buyer's query has no more unseen matches (also emit SEARCHED_PRODUCT:name)
  • SYSTEM_CREATE_LISTING:...     → seller has provided ALL required fields + ≥1 photo (see format below)
  • INTENT:sell_start             → user wants to sell but hasn't given details yet — ask category-specific questions
  • INTENT:sell_collecting        → seller flow in progress, still collecting fields
  • INTENT:payment_help           → user is asking about a pending payment (use PENDING PAYMENT LISTINGS from USER_CONTEXT)
  • INTENT:greeting               → pure greeting, no search
  • INTENT:smalltalk              → chit-chat, thanks, acknowledgement — no listings, no actions
  • INTENT:clarify_search         → buyer's query is too vague — ask 1–2 clarifying questions BEFORE showing listings
  • INTENT:menu_choice:<n>        → user picked numbered option n from the LAST BOT MESSAGE (only valid if that message offered *n*)

Example:
Here are the best matches for iPhone in Kandy! 📱
SHOW_LISTINGS:abc-123,def-456
SEARCHED_PRODUCT:iPhone 13 Pro


RULES:
1. Detect user intent: buying, selling, searching, negotiating, greeting
2. For BUYING/SEARCHING:
   a. FIRST — check if the query is specific enough. A query is specific if it names at least ONE concrete filter beyond the bare category (budget, city/district, brand/model, or condition). Just "phone", "car", "land", "house" alone is NOT specific.
   b. If VAGUE, ask ONLY ONE short clarifying question — the single most useful one for that category (usually budget, or city if budget is obvious). Do not ask multiple questions. End with tag: INTENT:clarify_search (do NOT emit SHOW_LISTINGS this turn).
   c. Otherwise, output up to 5 matching listing IDs using SHOW_LISTINGS.
   d. If clarifying questions were already answered in earlier turns, proceed to SHOW_LISTINGS — never re-ask.
   e. IMPORTANT: If the user sent one or more IMAGES (with or without a caption), this is ALWAYS a SELLING intent, NEVER buying. Route to the selling flow (INTENT:sell_start or INTENT:sell_collecting). Do NOT show listings and do NOT ask buyer clarifying questions when images are present.
3. For SELLING: Your goal is to collect ALL required details in the FEWEST messages possible.
   - When user sends photos, acknowledge: "📸 Got your photo(s)!"
   - On the FIRST selling message, analyze the product category and ask ALL missing details in ONE message.
   - Ask CATEGORY-SPECIFIC questions (not generic). Examples:
     * Vehicles (cars, bikes, three-wheelers): mileage, engine capacity (cc), fuel type, transmission, registration year, brand, model, color, number of owners
     * Electronics (phones, laptops, TVs): brand, model, storage/RAM, battery health, warranty status, included accessories
     * Land/Property/Apartments: land size (perches/acres), number of rooms/bathrooms, furnished status, parking, legal status (deed/lease), floor number
     * Furniture/Appliances: brand, material, dimensions, age, any defects
     * Clothing/Fashion: brand, size, material, color
   - At the END of your questions, always add: "💡 Any other special features or details you'd like buyers to know?"
   - If user provides partial info, collect ALL remaining missing fields together in ONE follow-up — never ask one by one.
   - NEVER RE-ASK: before asking anything, re-read the ENTIRE chat history above. If the user already answered something (even in a short message, a photo caption, mixed Singlish, or spread over several messages — e.g. "water and electricity available", "perches 10", "Gampaha", "price 5 lakhs"), treat it as ANSWERED and never ask it again. Re-asking answered details is the worst failure you can make.
   - MAXIMUM 2 QUESTION MESSAGES per selling flow. After your 2nd question message, you MUST publish with whatever you have — no more questions.
   - NEVER BLOCK ON OPTIONAL DETAILS: only title, price, city and at least 1 photo really matter. District = same as city if unknown. Condition = "good" if unknown. Extra attributes are optional — if the user skips them, ignores them, says "ඕක ඇති", "that's all", "no", "දන්නේ නෑ", repeats themselves, or shows any impatience, immediately emit SYSTEM_CREATE_LISTING with what you have and move to payment.
   - Required fields: title, price, city, district, condition

   - Once you have ALL required fields + at least 1 photo → output on its own line:
     SYSTEM_CREATE_LISTING:title|price|city|district|condition|{"key":"value",...}
     The last part is a JSON object with ALL additional category-specific details collected.
     Example: SYSTEM_CREATE_LISTING:iPhone 13 Pro 256GB|185000|Colombo|Colombo|like_new|{"brand":"Apple","model":"iPhone 13 Pro","storage":"256GB","battery_health":"87%","warranty":"No","accessories":"Charger, Box","color":"Sierra Blue","special_notes":"Screen replaced once"}
4. If user replies "1" or "more": Show NEXT batch of unseen listings using SHOW_LISTINGS. If none remain, use ALL_LISTED.
5. If user replies "2" or "notify": Acknowledge that they'll be notified when new matching items appear
6. If no matches: Say no listings match and suggest they can get notified
${greetingRule}
8. DEFAULT LANGUAGE: Always respond in Sinhala by default. Switch to English ONLY if the user types in English. Switch to Tamil ONLY if the user types in Tamil. If the user mixes languages, respond in whichever non-English language they used (Sinhala or Tamil), defaulting to Sinhala if unclear.
9. Keep messages short, professional, and conversational. IMPORTANT: Use single asterisk *text* for bold in WhatsApp, NOT double asterisks **text**. Single * is correct for WhatsApp bold formatting.
9a. TONE: Always maintain a professional, friendly tone. NEVER use casual slang, colloquial exclamations, or unprofessional words in ANY language. Avoid words like "එලකිරි", "සුපිරි", "මරු", "කියාපු", "බෝම", "awesome", "sick", "dope", "woww" etc. Use polite, clean language suitable for a professional marketplace. Instead of slang, use proper words like "විශිෂ්ටයි" (excellent), "හොඳයි" (good), "නියමයි" (great).
10. Understand phrases like "mata phone ekak one", "vikunanna aqua", "best price?"
10. Always detect Sri Lankan cities/districts
11. CRITICAL: Never show more than 5 listings per response. NEVER output all listing IDs. Only pick the BEST 3-5 matches for the user's query. If the user says "Hi" or greets or sends a casual message, do NOT show any listings — just greet them. ONLY show listings when the user EXPLICITLY asks to buy, search, or find something specific.
11a. STRICT RELEVANCE: A listing is a match ONLY if its title or description clearly refers to the SAME product the user asked for (or an obvious direct synonym — e.g. "phone"↔"mobile", "bike"↔"motorcycle"). Same category is NOT enough — "shoes" must NOT return "frocks" or "shirts" just because both are fashion; "car" must NOT return "van" or "bike". If NO listing in the AVAILABLE LISTINGS truly matches the requested product, emit ALL_LISTED (and SEARCHED_PRODUCT) instead of forcing unrelated items.
12. Images, seller contacts, and follow-up reply options (1=more, 2=notify) will be AUTOMATICALLY added after SHOW_LISTINGS — do NOT include them yourself
13. Your intro text should ONLY go BEFORE the SHOW_LISTINGS or ALL_LISTED line. Do NOT add any text after these tags.
14. NEVER include "Reply 1" or "Reply 2" instructions in your response — the system handles this automatically

HOW TAKTAK WORKS (explain confidently when asked "how does this work?", "මොකක්ද මේ?", "how to sell/buy?", "what is TakTak?"):
- TakTak is a WhatsApp-only marketplace assistant for Sri Lanka. Buyers and sellers do EVERYTHING here in chat — no app, no website browsing.
- *Buyers*: just tell me what you want (e.g. "mata iPhone 13 ekak one Colombo") and I show you matching listings with photos + seller contact.
- *Sellers*: send a photo of the item + basic details (price, city, condition) and I create the listing after a small one-time listing fee.
- *Premium Instant-Match WhatsApp Messages* (free feature — ALWAYS mention this when explaining how it works, or when a buyer's search returns no/few results):
   • After any search, buyers can reply *2* to subscribe to that search.
   • The moment a matching listing is posted by ANY seller, I send it to the buyer instantly as a WhatsApp message — no need to keep searching.
   • Sellers also benefit: your new listing reaches waiting buyers within minutes.
   • Reply *STOP <keyword>* anytime to unsubscribe.
   • WORDING RULE: never use the word "notification"/"notify"/"දැනුම්දීම" for this — always call it a *WhatsApp message* (WhatsApp msg එකක්) so users are not confused.

LISTING FEE (CRITICAL — NEVER HALLUCINATE PRICING):
- TakTak is NOT free to post. Every published listing requires a one-time listing fee.
- Fee tiers (based on the seller's asking price):
   • Asking price *below LKR ${feeCfg.threshold.toLocaleString()}* → listing fee = *LKR ${feeCfg.low.toLocaleString()}*
   • Asking price *LKR ${feeCfg.threshold.toLocaleString()} or above* → listing fee = *LKR ${feeCfg.high.toLocaleString()}*
- Buyers use TakTak for FREE — no fee to search, contact sellers, or subscribe to instant-match WhatsApp messages.
- If a user asks "is it free?", "how much to post?", "ගාස්තුවක් තියෙනවද?", "නොමිලේද?", etc. — ALWAYS state the correct fee above for sellers, and clarify that buying/searching is free. NEVER say posting is free, promotional, discounted, or waived. NEVER invent alternative prices.
- Payment methods: (1) Bank transfer to *Commercial Bank — BuildStart (Pvt) Ltd — 1001075073* then send the deposit slip photo here, OR (2) Card payment via the OnePay link the bot provides after SYSTEM_CREATE_LISTING.
- Do NOT quote the fee or bank details unprompted during data collection — only when the user asks about pricing/payment, or after SYSTEM_CREATE_LISTING (the system message already includes them).

LINKS (CRITICAL — NEVER HALLUCINATE URLS):
- The ONLY seller dashboard URL is: *https://taktakmarket.buildstart.io/login* — nothing else.
- NEVER send other URLs, preview links, "lovable.app" links, IP addresses, or any URL you invent.
- The OnePay payment link is inserted automatically by the system after SYSTEM_CREATE_LISTING — do NOT generate or guess a payment link yourself.
- If a user asks for the dashboard, use exactly: https://taktakmarket.buildstart.io/login
- The user's referral wa.me link given in the REFERRAL PROGRAM section may be sent verbatim whenever they ask for it.${referralRule}

Default to Sinhala. Only switch to English if the user writes in English, or Tamil if the user writes in Tamil.${firstReplyRule}${metaAutoRule}${stopAskingRule}`;

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

  const aiRes = await fetch((Deno.env.get("AI_GATEWAY_URL") || "https://ai.gateway.lovable.dev/v1") + "/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [{ role: "system", content: systemPrompt }, ...chatHistory, { role: "user", content: message }],
    }),
  });

  if (!aiRes.ok) {
    console.error("AI error:", aiRes.status, await aiRes.text());
    return { text: "Sorry, I'm having trouble right now. Please try again! 🙏" };
  }

  const aiData = await aiRes.json();
  let reply = aiData.choices?.[0]?.message?.content || "Sorry, please try again!";
  // Fix double asterisks to single for WhatsApp bold formatting
  reply = reply.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  console.log("AI raw reply:", reply.slice(0, 500));
  // Strip INTENT:xxx routing tags — internal only, never send to user
  reply = reply
    .replace(/^\s*INTENT:[^\n]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Handle listing creation
  if (reply.includes("SYSTEM_CREATE_LISTING:") && userId) {
    const match = reply.match(/SYSTEM_CREATE_LISTING:(.+)/);
    if (match) {
      const parts = match[1].split("|");
      if (parts.length >= 5) {
        const [title, priceStr, city, district, condition, ...rest] = parts;

        let additionalDetails: Record<string, any> = {};
        const restStr = rest.join("|").trim();
        if (restStr) {
          try {
            additionalDetails = JSON.parse(restStr);
          } catch (e) {
            console.error("Failed to parse additional details:", restStr, e);
          }
        }

        const { data: recentImages } = await supabase
          .from("chat_messages")
          .select("metadata")
          .eq("phone_number", phone)
          .eq("direction", "incoming")
          .order("created_at", { ascending: false })
          .limit(10);

        const rawImages: string[] = (recentImages || [])
          .flatMap((m: any) => m.metadata?.image_urls || [])
          .filter(Boolean);
        // Dedup + cap
        const seen = new Set<string>();
        const originalImages: string[] = [];
        for (const u of rawImages) {
          if (seen.has(u)) continue;
          seen.add(u);
          originalImages.push(u);
          if (originalImages.length >= MAX_IMAGES_PER_LISTING) break;
        }
        // Build a 2x2 collage thumbnail from the first up-to-4 photos, prepend as cover.
        let allImages = originalImages;
        if (originalImages.length >= 2) {
          const collageUrl = await buildCollageAndUpload(supabase, userId, originalImages);
          if (collageUrl) allImages = [collageUrl, ...originalImages];
        }

        // Deduplication: AI-powered check against ALL active listings from this seller
        const parsedPrice = parseFloat(priceStr.replace(/[^0-9.]/g, "")) || 0;
        const { data: sellerListings } = await supabase
          .from("listings")
          .select("id, title, price, category, city, additional_details")
          .eq("seller_id", userId)
          .eq("status", "active");

        const isDuplicate = await checkDuplicateWithAI(
          title.trim(),
          parsedPrice,
          city.trim(),
          (additionalDetails?.category as string) || "",
          additionalDetails,
          sellerListings || [],
        );

        if (isDuplicate) {
          console.log("AI duplicate listing prevented for seller:", userId, "title:", title.trim());
          // Clear the pending-listing state so the seller can retry with a corrected title.
          await updateBotState(supabase, userId, {
            mode: "selling",
            pending_listing_id: null,
            last_question: "duplicate_confirmation",
            collecting: [],
          });
          const existing = sellerListings?.[0];
          const existingSummary = existing
            ? `\n\n📌 *ඔබගේ දැනට active දැන්වීම:* ${existing.title} — රු ${Number(existing.price).toLocaleString()} (${existing.city})`
            : "";
          const dupText =
            `⚠️ *මෙයට සමාන දැන්වීමක් ඔබට දැනටමත් තිබේ.*` +
            existingSummary +
            `\n\nඑකම භාණ්ඩය නැවත පල නොකෙරේ.\n\n` +
            `• මෙය *වෙනස්ම භාණ්ඩයක්* නම් — නම හෝ මාදිලිය පැහැදිලිව වෙනස් කර නැවත එවන්න (උදා: model number එකත් සමඟ).\n` +
            `• කලින් දැන්වීම *update කිරීමට* අවශ්‍ය නම් — "update" කියා reply කරන්න.\n` +
            `• කලින් දැන්වීම *විකිණී අවසන්* නම් — "sold" කියා reply කරන්න.`;
          return { text: dupText };
        }

        const insertData = {
          seller_id: userId,
          title: title.trim(),
          price: parsedPrice,
          city: city.trim(),
          district: district.trim(),
          condition: mapCondition(condition.trim()),
          images: allImages,
          status: "pending_payment",
          payment_status: "unpaid",
          additional_details: additionalDetails,
        };

        const { data: createdRow, error: listingError } = await supabase
          .from("listings")
          .insert(insertData)
          .select("id")
          .single();

        if (listingError) {
          console.error("Listing creation error:", listingError);
          reply =
            reply.replace(/SYSTEM_CREATE_LISTING:.+/, "") +
            "\n\n⚠️ Sorry, there was an error creating your listing. Please try again.";
        } else {
          // Track pending listing in bot_state so next turns know payment is expected
          await updateBotState(supabase, userId, {
            mode: "selling",
            pending_listing_id: createdRow.id,
            last_question: "waiting_for_payment",
            collecting: [],
          });

          // Request OnePay checkout link
          let paymentLink: string | null = null;
          const feeCfgNow = await getFeeConfig(supabase);
          let paymentFee = feeForPrice(parsedPrice, feeCfgNow);
          try {
            const payResp = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/onepay-create-payment-taktak`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              },
              body: JSON.stringify({ listing_id: createdRow.id }),
            });
            const payJson = await payResp.json();
            paymentLink = payJson?.redirect_url || null;
            if (payJson?.amount) paymentFee = payJson.amount;
          } catch (e) {
            console.error("OnePay link request failed:", e);
          }

          const baseReply = reply
            .replace(/SYSTEM_CREATE_LISTING:.+/, "")
            .replace(/SHOW_LISTINGS:.+/g, "")
            .replace(/SEARCHED_PRODUCT:.+/g, "")
            .trim();

          const buyersWaiting = await estimateBuyersForListing(supabase, {
            id: createdRow.id,
            title: title.trim(),
            category: (insertData as any).category ?? null,
          });

          const confirmText =
            (baseReply ? baseReply + "\n\n" : "") +

            `📝 *Listing prepared:* ${title.trim()}\n` +
            `මෙම Advertisement එක පල කර ගැනීමට *රු ${paymentFee.toLocaleString()}* වැයවේ.\n` +
            (parsedPrice >= feeCfgNow.threshold
              ? `_(රු ${feeCfgNow.threshold.toLocaleString()} හෝ ඊට වැඩි භාණ්ඩ සඳහා)_\n\n`
              : `_(රු ${feeCfgNow.threshold.toLocaleString()} ට අඩු භාණ්ඩ සඳහා)_\n\n`) +
            `පහත ගෙවීම් ක්‍රම දෙකෙන් එකක් තෝරාගන්න:\n\n` +
            `*1️⃣ Bank Transfer*\n` +
            `🏦 Bank: Commercial Bank\n` +
            `🏢 Branch: Dehiwala\n` +
            `👤 Name: BuildStart (Pvt) Ltd\n` +
            `🔢 A/C No: 1001075073\n` +
            `_මුදල් ගෙවා Receipt පත මෙම WhatsApp එකටම එවන්න._\n\n` +
            `*2️⃣ Card Payment*\n` +
            (paymentLink
              ? `පහත Link එක ඔස්සේ Card Payment එක සිදුකල හැක:\n${paymentLink}\n\n` +
                "_ගෙවීම තහවුරු වූ විගස ඔබගේ Listing එක ක්‍රියාත්මක වේ._"
              : "⚠️ Card payment link එක දැන් ලබා ගැනීමට නොහැකි විය. කරුණාකර නැවත උත්සාහ කරන්න හෝ Bank Transfer භාවිතා කරන්න.");

          const coverImage =
            allImages.find((u) => typeof u === "string" && u.startsWith("http")) || null;

          const previewCaption =
            `👀 *ඔබගේ දැන්වීම Buyers දකින විදිහ:*\n\n` +
            formatListingCaption(
              {
                title: title.trim(),
                price: parsedPrice,
                condition: mapCondition(condition.trim()),
                city: city.trim(),
                district: district.trim(),
                images: allImages,
                additional_details: additionalDetails,
              },
              phone,
            ) +
            `\n\n🔥 *ගැනුම්කරුවන් ${buyersWaiting} දෙනෙක්* මේ වගේ භාණ්ඩයක් දැන් සොයමින් සිටී.\n` +
            `💚 ගෙවීම සම්පූර්ණ කළ විගස ඔබගේ දැන්වීම live වේ.`;


          return {
            text: confirmText,
            paymentPreviewImage: coverImage,
            paymentPreviewCaption: previewCaption,
          };

        }
      }
    }
    return {
      text: reply
        .replace(/SHOW_LISTINGS:.+/g, "")
        .replace(/SEARCHED_PRODUCT:.+/g, "")
        .trim(),
    };
  }

  // Parse ALL_LISTED
  if (reply.includes("ALL_LISTED")) {
    const searchedProductMatch2 = reply.match(/SEARCHED_PRODUCT:(.+)/);
    const allListedIndex = reply.indexOf("ALL_LISTED");
    let introText = allListedIndex > 0 ? reply.substring(0, allListedIndex).trim() : "";
    introText = introText
      .replace(/reply\s*\*?\*?\d\*?\*?.*/gi, "")
      .replace(/SEARCHED_PRODUCT:.+/g, "")
      .trim();
    const searchedProduct = searchedProductMatch2 ? searchedProductMatch2[1].trim() : "similar items";
    const allListedMsg = introText
      ? introText
      : `✅ You've seen all available *${searchedProduct}* listings! We'll notify you when new ones appear. 🔔`;
    return { text: allListedMsg, allListed: true, searchedProduct };
  }

  // Parse SHOW_LISTINGS
  const listingIdsMatch = reply.match(/SHOW_LISTINGS:([\w\-,\ ]+)/);
  const searchedProductMatch = reply.match(/SEARCHED_PRODUCT:(.+)/);

  if (listingIdsMatch) {
    let ids = listingIdsMatch[1]
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 5);

    // HARD dedup: drop any IDs the buyer has already been shown
    const beforeIdDedup = ids.length;
    ids = ids.filter((id) => !sentIdSet.has(id));
    if (beforeIdDedup !== ids.length) {
      console.log(`AI tried to repeat ${beforeIdDedup - ids.length} already-shown listing(s); dropped.`);
    }

    const showIndex = reply.indexOf("SHOW_LISTINGS:");
    let introText = showIndex > 0 ? reply.substring(0, showIndex).trim() : "";
    introText = introText.replace(/reply\s*\*?\*?\d\*?\*?.*/gi, "").trim();
    const searchedProduct = searchedProductMatch ? searchedProductMatch[1].trim() : undefined;

    if (ids.length > 0) {
      return {
        text: "",
        listingIds: ids,
        introText: introText || undefined,
        searchedProduct,
      };
    }
  }

  return { text: reply };
}

// ─── Subscription Criteria Extraction ────────────────────

async function extractSubscriptionCriteria(
  supabase: any,
  phone: string,
): Promise<{ product: string; location?: string; maxPrice?: number; category?: string } | null> {
  // Look at recent messages to find what was searched/offered
  const { data: recentMessages } = await supabase
    .from("chat_messages")
    .select("message_text, metadata, direction, created_at")
    .eq("phone_number", phone)
    .order("created_at", { ascending: false })
    .limit(12);

  if (!recentMessages || recentMessages.length === 0) return null;

  // Strategy: find the last outgoing bot message that OFFERED a notification
  // (contains phrases like "notify", "දැනුම්", "whatsapp කරන්නද", "ලැබුනු ගමන්"),
  // then use AI to extract the product/location/price the bot referenced.
  // Fallback: use the most recent substantive incoming search query.
  const offerPattern = /(notify|දැනුම්|දැනුවත්|alert|whatsapp කරන්නද|ලැබුනු ගමන්|දාද්දී|listing එකක්)/i;

  let contextText: string | null = null;
  let contextSource: "bot_offer" | "user_query" = "user_query";

  for (const m of recentMessages) {
    if (m.direction === "outgoing" && offerPattern.test(m.message_text || "")) {
      contextText = m.message_text;
      contextSource = "bot_offer";
      break;
    }
  }

  if (!contextText) {
    // Fallback: last incoming message that looks like a real search query
    // (skip 1-2 word confirmations like "ha", "ok", "yes" — any short reply is likely a confirmation, not a query)
    for (const m of recentMessages) {
      const txt = (m.message_text || "").trim();
      if (m.direction === "incoming" && txt.length > 4 && txt.split(/\s+/).length >= 2) {
        contextText = txt;
        break;
      }
    }
  }

  if (!contextText) return null;

  console.log(`[extractSubscriptionCriteria] source=${contextSource} text="${contextText.slice(0, 120)}"`);
  return await parseAlertWithAI(contextText);
}

// ─── AI-Powered Duplicate Detection ─────────────────────

async function checkDuplicateWithAI(
  newTitle: string,
  newPrice: number,
  newCity: string,
  newCategory: string,
  newDetails: Record<string, any>,
  existingListings: any[],
): Promise<boolean> {
  if (!existingListings || existingListings.length === 0) return false;

  // Quick exact match check first (fast path)
  const exactMatch = existingListings.find((l: any) => l.title.toLowerCase().trim() === newTitle.toLowerCase().trim());
  if (exactMatch) {
    console.log("Exact title duplicate found:", exactMatch.id);
    return true;
  }

  // Use AI for fuzzy/semantic duplicate detection
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    // Fallback: basic similarity check without AI
    return existingListings.some((l: any) => {
      const existingWords = new Set(l.title.toLowerCase().split(/\s+/));
      const newWords = newTitle.toLowerCase().split(/\s+/);
      const overlap = newWords.filter((w) => existingWords.has(w) && w.length > 2).length;
      return overlap >= Math.ceil(newWords.length * 0.6);
    });
  }

  const existingList = existingListings
    .map(
      (l: any) =>
        `ID:${l.id} | Title: ${l.title} | Price: LKR ${l.price} | City: ${l.city} | Category: ${l.category || "N/A"}`,
    )
    .join("\n");

  try {
    const aiRes = await fetch((Deno.env.get("AI_GATEWAY_URL") || "https://ai.gateway.lovable.dev/v1") + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          {
            role: "system",
            content: `You are a strict duplicate product detector for a marketplace. Compare a NEW listing against EXISTING listings from the same seller.

Two listings are DUPLICATES ONLY IF they clearly refer to the SAME physical product (same brand + same model/variant). Allow for:
- Typos and word order ("iPhone 13 Pro" vs "iPhone 13pro" vs "Apple iPhone 13 Pro 256GB")
- Added/removed descriptive words ("Toyota Aqua 2015" vs "Toyota Aqua 2015 White")
- Price changes on the same model

They are NOT duplicates when the *model name, model number, or variant* differs, even within the same category. Examples of NOT_DUPLICATE:
- "iPhone 13" vs "iPhone 14"
- "Toyota Aqua" vs "Toyota Vitz"
- "T800 Ultra Smart Watch" vs "X10 Ultra Smart Watch"  (different model numbers)
- "Samsung A54" vs "Samsung A34"
- "JBL Neckband" vs "JBL Speaker"

If the model number / model name differs at all → NOT_DUPLICATE.
When in doubt → NOT_DUPLICATE.

Respond with ONLY "DUPLICATE" or "NOT_DUPLICATE". Nothing else.`,
          },
          {
            role: "user",
            content: `NEW LISTING:\nTitle: ${newTitle}\nPrice: LKR ${newPrice}\nCity: ${newCity}\nCategory: ${newCategory}\n\nEXISTING LISTINGS FROM SAME SELLER:\n${existingList}`,
          },
        ],
      }),
    });

    if (!aiRes.ok) {
      console.error("Duplicate check AI error:", aiRes.status);
      return false;
    }

    const aiData = await aiRes.json();
    const result = (aiData.choices?.[0]?.message?.content || "").trim().toUpperCase();
    console.log("AI duplicate check result:", result, "for title:", newTitle);
    return result.includes("DUPLICATE") && !result.includes("NOT_DUPLICATE");
  } catch (e) {
    console.error("Duplicate check error:", e);
    return false;
  }
}

// ─── AI Intent Classifier (replaces regex fast-path) ─────
// Returns true when the message is a greeting OR a selling opener — in
// either case we can safely skip loading & scoring listings. Any buying /
// searching / negotiating / unclear intent returns false so listings load.
async function classifyNonSearchIntent(message: string, hasImages: boolean): Promise<boolean> {
  // Images always mean selling flow — hard rule, no AI needed.
  if (hasImages) return true;

  const text = (message || "").trim();
  if (!text) return true; // nothing to search on
  // Very short messages (1-2 tokens) with no digits are almost never search queries.
  // But we still let AI decide when unsure.

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) return regexIntentFallback(text);

  try {
    const aiRes = await fetch((Deno.env.get("AI_GATEWAY_URL") || "https://ai.gateway.lovable.dev/v1") + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          {
            role: "system",
            content: `Classify a Sri Lankan marketplace WhatsApp message into ONE label. Reply with ONLY the label, nothing else.\n\nLabels:\n- GREETING: hi/hello/ayubowan/kohomada/vanakkam/thanks — pure social, no product intent.\n- SELLING: user wants to POST/list/sell something they own (e.g. "sell my iphone", "vikunanna", "mata meka vikuna denna one", "posting my bike", "brand new phone for sale").\n- SEARCHING: user wants to BUY/find/see listings (e.g. "iphone 13 under 100k", "toyota aqua kandy", "any phones?", "mata phone ekak one").\n- OTHER: payment/help/complaints/unclear.\n\nRules:\n- "brand new" alone is NOT selling — depends on context. "brand new iphone for sale" = SELLING, "looking for brand new iphone" = SEARCHING.\n- If unsure between SEARCHING and something else, pick SEARCHING.\n- Output exactly one word: GREETING, SELLING, SEARCHING, or OTHER.`,
          },
          { role: "user", content: text.slice(0, 500) },
        ],
      }),
    });

    if (!aiRes.ok) return regexIntentFallback(text);
    const data = await aiRes.json();
    const label = String(data.choices?.[0]?.message?.content || "")
      .trim()
      .toUpperCase();
    console.log("Intent classifier:", label, "for:", text.slice(0, 80));
    return label.startsWith("GREETING") || label.startsWith("SELLING");
  } catch (e) {
    console.error("Intent classifier error:", e);
    return regexIntentFallback(text);
  }
}

function regexIntentFallback(text: string): boolean {
  const greetingPatterns =
    /^(hi|hello|hey|helo|ayubowan|ආයුබෝවන්|vanakkam|வணக்கம்|good\s*(morning|evening|afternoon|night)|sup|yo|oi|machan|bro|ane|kohomada|කොහොමද|ello|hii+|hellloo*|👋|🙏|gm|gn)\b/i;
  const isGreeting = greetingPatterns.test(text) && text.split(/\s+/).length <= 4;
  const isSelling = /^(sell|selling|vikunanna|විකුණන්න|விற்க)/i.test(text);
  return isGreeting || isSelling;
}

// ─── AI-Powered Alert Parsing ────────────────────────────

async function parseAlertWithAI(
  rawQuery: string,
): Promise<{ product: string; location?: string; maxPrice?: number; category?: string } | null> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    console.error("LOVABLE_API_KEY not configured for alert parsing");
    return fallbackParse(rawQuery);
  }

  const systemPrompt = `You are a Sri Lankan marketplace NLU engine. Extract structured data from user search queries.

Users may type in English, Sinhala (romanized), Tamil (romanized), Singlish, Tanglish, or mixed languages with typos and slang.

YOUR TASK:
1. Correct spelling mistakes: "lappt" → "laptop", "iphne" → "iPhone", "samsnug" → "Samsung"
2. Understand Sri Lankan slang/numbers: "laksha"/"lak"/"L" = 100,000 LKR, "2kt"/"2k" = 2,000, "2L" = 200,000, "million"/"mn"/"mil" = 1,000,000, "crore"/"cr" = 10,000,000
3. Normalize currency to LKR integer: "2 lakhs" → 200000, "50k" → 50000, "50 million" → 50000000, "5 crore" → 50000000, "25000" → 25000
4. Detect Sri Lankan cities/districts: "CMB" → "Colombo", "KDY" → "Kandy", "Galle" → "Galle"
5. Detect product category: phones, laptops, vehicles, property, electronics, furniture, clothing, etc.
6. Generate a CLEAN product keyword (English, properly spelled, concise)

RESPOND ONLY with a JSON object (no markdown, no explanation):
{
  "product": "clean product name in English",
  "location": "city or district name or null",
  "max_price": number_or_null,
  "category": "category or null"
}

Examples:
Input: "Matalaksha 2kt lappt" → {"product":"Laptop","location":null,"max_price":200000,"category":"laptops"}
Input: "iphne 13 kandy under 1 lak" → {"product":"iPhone 13","location":"Kandy","max_price":100000,"category":"phones"}
Input: "mata phone ekak one colombo" → {"product":"Phone","location":"Colombo","max_price":null,"category":"phones"}
Input: "bike ekak gampaha 3L" → {"product":"Motorcycle","location":"Gampaha","max_price":300000,"category":"vehicles"}
Input: "used car toyota aqua" → {"product":"Toyota Aqua","location":null,"max_price":null,"category":"vehicles"}
Input: "50 million Toyota" → {"product":"Toyota","location":null,"max_price":50000000,"category":"vehicles"}
Input: "toyota car under 5 million colombo" → {"product":"Toyota","location":"Colombo","max_price":5000000,"category":"vehicles"}`;

  try {
    const aiRes = await fetch((Deno.env.get("AI_GATEWAY_URL") || "https://ai.gateway.lovable.dev/v1") + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: rawQuery },
        ],
      }),
    });

    if (!aiRes.ok) {
      console.error("AI alert parsing error:", aiRes.status);
      return fallbackParse(rawQuery);
    }

    const aiData = await aiRes.json();
    const content = aiData.choices?.[0]?.message?.content || "";
    console.log("AI alert parse result:", content);

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallbackParse(rawQuery);

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.product || typeof parsed.product !== "string") {
      return fallbackParse(rawQuery);
    }

    return {
      product: parsed.product.trim(),
      location: parsed.location && parsed.location !== "null" ? parsed.location.trim() : undefined,
      maxPrice: typeof parsed.max_price === "number" ? parsed.max_price : undefined,
      category: parsed.category && parsed.category !== "null" ? parsed.category.trim() : undefined,
    };
  } catch (e) {
    console.error("AI alert parsing exception:", e);
    return fallbackParse(rawQuery);
  }
}

function fallbackParse(rawQuery: string): { product: string; location?: string; maxPrice?: number; category?: string } {
  // Simple regex fallback if AI is unavailable
  const locationMatch = rawQuery.match(/in\s+(\w[\w\s]*?)(?:\s+under|\s*$)/i);
  const priceMatch = rawQuery.match(/(?:under|below)\s+(?:LKR\s+|Rs\.?\s*)?([0-9,]+)/i);
  const millionMatch = rawQuery.match(/(\d+(?:\.\d+)?)\s*(?:million|mn|mil|මිලියන)\b/i);
  const lakhMatch = rawQuery.match(/(\d+(?:\.\d+)?)\s*(?:laksha?|lak|L|ලක්ෂ)\b/i);
  const croreMatch = rawQuery.match(/(\d+(?:\.\d+)?)\s*(?:crore|cr|කෝටි)\b/i);
  const kMatch = rawQuery.match(/(\d+(?:\.\d+)?)\s*(?:kt?|k|දහස)\b/i);

  let maxPrice: number | undefined;
  if (priceMatch) maxPrice = parseInt(priceMatch[1].replace(/,/g, ""));
  else if (croreMatch) maxPrice = Math.round(parseFloat(croreMatch[1]) * 10000000);
  else if (millionMatch) maxPrice = Math.round(parseFloat(millionMatch[1]) * 1000000);
  else if (lakhMatch) maxPrice = Math.round(parseFloat(lakhMatch[1]) * 100000);
  else if (kMatch) maxPrice = Math.round(parseFloat(kMatch[1]) * 1000);

  const product =
    rawQuery
      .replace(/in\s+\w[\w\s]*/i, "")
      .replace(/(?:under|below)\s+.*/i, "")
      .replace(/\d+(?:\.\d+)?\s*(?:million|mn|mil|මිලියන|crore|cr|කෝටි|laksha?|lak|L|ලක්ෂ|kt?|k|දහස)\b/gi, "")
      .replace(/\bRs\.?\b|\bLKR\b|රු\.?/gi, "")
      .replace(/\s+/g, " ")
      .trim() || rawQuery;

  return {
    product,
    location: locationMatch ? locationMatch[1].trim() : undefined,
    maxPrice,
  };
}

// ─── Keyword Search & Scoring ───────────────────────────

function extractSearchKeywords(
  rawMessage: string,
  criteria: { product: string; location?: string; maxPrice?: number; category?: string } | null,
): string[] {
  const keywords: string[] = [];

  // From AI-parsed criteria
  if (criteria) {
    if (criteria.product) {
      // Split multi-word product into individual keywords + keep full phrase
      keywords.push(criteria.product.toLowerCase());
      criteria.product
        .toLowerCase()
        .split(/\s+/)
        .forEach((w) => {
          if (w.length > 2) keywords.push(w);
        });
    }
    if (criteria.location) keywords.push(criteria.location.toLowerCase());
    if (criteria.category) keywords.push(criteria.category.toLowerCase());
  }

  // From raw message - extract meaningful words (skip common stop words)
  const stopWords = new Set([
    "i",
    "me",
    "my",
    "want",
    "need",
    "looking",
    "for",
    "a",
    "an",
    "the",
    "to",
    "in",
    "is",
    "are",
    "can",
    "you",
    "show",
    "find",
    "get",
    "buy",
    "one",
    "any",
    "some",
    "please",
    "pls",
    "mata",
    "one",
    "oney",
    "ekak",
    "tiyenawada",
    "thiyenawada",
    "have",
    "under",
    "below",
    "above",
    "around",
    "near",
    "good",
    "best",
    "cheap",
    "used",
    "second",
    "hand",
    "secondhand",
  ]);

  rawMessage
    .toLowerCase()
    .split(/[\s,;.!?]+/)
    .forEach((word) => {
      const clean = word.replace(/[^a-z0-9\u0D80-\u0DFF\u0B80-\u0BFF]/g, "");
      if (clean.length > 2 && !stopWords.has(clean) && !keywords.includes(clean)) {
        keywords.push(clean);
      }
    });

  return [...new Set(keywords)];
}

function scoreListingRelevance(
  listing: any,
  keywords: string[],
  criteria: { product: string; location?: string; maxPrice?: number; category?: string } | null,
): number {
  if (keywords.length === 0) return 0;

  const title = (listing.title || "").toLowerCase();
  const description = (listing.description || "").toLowerCase();
  const category = (listing.category || "").toLowerCase();
  const city = (listing.city || "").toLowerCase();
  const district = (listing.district || "").toLowerCase();
  const additionalStr = listing.additional_details ? JSON.stringify(listing.additional_details).toLowerCase() : "";

  // HARD GATE: the listing must contain at least one product-derived keyword
  // in its title, description, or additional_details. Matching only on city,
  // district, or category is NOT enough — that's how "shoes" was returning
  // "frocks" (both share the fashion category).
  const stopForGate = new Set([criteria?.location?.toLowerCase() || "", criteria?.category?.toLowerCase() || ""]);
  const productKeywords = keywords.filter((k) => k.length > 2 && !stopForGate.has(k) && k !== city && k !== district);
  const productText = `${title} ${description} ${additionalStr}`;
  const hasProductMatch = productKeywords.some((k) => productText.includes(k));
  if (!hasProductMatch) return 0;

  let score = 0;
  for (const keyword of keywords) {
    if (title.includes(keyword)) score += 10;
    if (category.includes(keyword)) score += 4; // reduced — category is weak signal
    if (city.includes(keyword) || district.includes(keyword)) score += 6;
    if (description.includes(keyword)) score += 4;
    if (additionalStr.includes(keyword)) score += 3;
  }

  if (criteria?.product && title.includes(criteria.product.toLowerCase())) {
    score += 15;
  }
  if (criteria?.location) {
    const loc = criteria.location.toLowerCase();
    if (city.includes(loc) || district.includes(loc)) score += 10;
  }
  if (criteria?.maxPrice && listing.price > criteria.maxPrice) {
    score = Math.floor(score * 0.3);
  }
  // No blanket category bonus — category alone must not lift unrelated items.

  return score;
}

function detectIntent(message: string): string {
  const lower = message.toLowerCase();
  if (/sell|vikuna|vikunan|list my|post ad/i.test(lower)) return "sell";
  if (/buy|one|oney|want|need|looking|search|find/i.test(lower)) return "buy";
  if (/price|how much|rate|best price/i.test(lower)) return "negotiate";
  if (/available|thiyenawa|thibei/i.test(lower)) return "check_availability";
  if (/hi|hello|hey|ayubowan/i.test(lower)) return "greeting";
  return "search";
}

function mapCondition(condition: string): string {
  const lower = condition.toLowerCase();
  if (lower.includes("new") && !lower.includes("like")) return "new";
  if (lower.includes("like new") || lower.includes("like_new")) return "like_new";
  if (lower.includes("good")) return "good";
  if (lower.includes("fair")) return "fair";
  if (lower.includes("poor")) return "poor";
  return "good";
}

// ─── Mark as Read ───────────────────────────────────────

function isWahaSession(sessionApiKey: string) {
  return sessionApiKey.startsWith("waha:");
}

function wahaSessionName(sessionApiKey: string) {
  return sessionApiKey.replace(/^waha:/, "").split(":")[0] || "default";
}

function wahaChatIdFor(phone: string) {
  const digits = phone.replace(/\D/g, "");
  // WAHA may deliver privacy-mode contacts as LIDs. Replies must go back to @lid.
  return digits.length > 13 ? `${digits}@lid` : `${digits}@c.us`;
}

async function sha512Hex(value: string) {
  const hashBuffer = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

async function markMessageAsRead(key: any, sessionApiKey: string) {
  try {
    if (isWahaSession(sessionApiKey)) {
      console.log("Skipping Wasender read receipt for WAHA session:", key.id);
      return;
    }

    const res = await fetch(WASENDER_READ_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        key: {
          id: key.id,
          remoteJid: key.remoteJid,
          fromMe: false,
        },
      }),
    });
    if (!res.ok) {
      console.error("Mark as read error:", res.status, await res.text());
    } else {
      console.log("Message marked as read:", key.id);
    }
  } catch (e) {
    console.error("Mark as read exception:", e);
  }
}

// ─── WhatsApp Messaging ─────────────────────────────────

async function sendWhatsAppMessage(phone: string, text: string, sessionApiKey: string) {
  const to = phone.startsWith("+") ? phone : `+${phone}`;
  console.log("Sending text to:", to);

  if (isWahaSession(sessionApiKey)) {
    const session = wahaSessionName(sessionApiKey);
    const chatId = wahaChatIdFor(phone);
    console.log("Sending WAHA text to:", chatId, "session:", session);
    const res = await wahaFetch("/api/sendText", {
      method: "POST",
      body: JSON.stringify({ session, chatId, text }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("WAHA send text error:", res.status, err);
    }
    return res;
  }

  // Wasender enforces 1 message / 5s (account protection). Without a retry the
  // message is silently lost, which is the main cause of "bot skipped a reply".
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(WASENDER_SEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to, text }),
    });

    if (res.ok) return res;

    const err = await res.text().catch(() => `${res.status}`);
    console.error("Wasender send error:", res.status, err, "attempt", attempt);
    if (res.status === 429 && attempt < 3) {
      let waitMs = 6000;
      try {
        const parsed = JSON.parse(err);
        if (parsed?.retry_after) waitMs = Math.max(1000, Number(parsed.retry_after) * 1000 + 1000);
      } catch { /* default wait */ }
      console.log(`Rate limited, waiting ${waitMs}ms before retry...`);
      await delay(waitMs);
      continue;
    }
    // A webhook sessionId can occasionally be stale even while the account's
    // stored/env sender key is healthy (scheduled follow-ups still work). Use
    // the same key fallback path as scheduled messages before giving up.
    const fallback = await wasenderSendWithFallback({ to, text });
    if (fallback.sent) {
      console.log("Inbound reply sent through fallback key");
      return new Response(JSON.stringify(fallback), { status: 200 });
    }
    return res;
  }
  const fallback = await wasenderSendWithFallback({ to, text });
  return new Response(JSON.stringify(fallback), {
    status: fallback.sent ? 200 : (fallback.status || 429),
    headers: { "Content-Type": "application/json" },
  });
}


async function sendWhatsAppImageMessage(phone: string, imageUrl: string, caption: string, sessionApiKey: string) {
  const to = phone.startsWith("+") ? phone : `+${phone}`;
  console.log("Sending image to:", to, "imageUrl:", imageUrl.slice(0, 80));

  if (isWahaSession(sessionApiKey)) {
    const session = wahaSessionName(sessionApiKey);
    const chatId = wahaChatIdFor(phone);
    console.log("Sending WAHA image to:", chatId, "session:", session);
    const res = await wahaFetch("/api/sendImage", {
      method: "POST",
      body: JSON.stringify({ session, chatId, file: { url: imageUrl }, caption }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("WAHA image send error:", res.status, err);
      if (res.status === 404 || res.status === 405) {
        return await sendWhatsAppMessage(phone, `${caption}\n${imageUrl}`, sessionApiKey);
      }
      if (res.status === 429) {
        console.log("Rate limited, waiting 6s before retry...");
        await delay(6000);
        return await wahaFetch("/api/sendImage", {
          method: "POST",
          body: JSON.stringify({ session, chatId, file: { url: imageUrl }, caption }),
        });
      }
    }
    return res;
  }

  const res = await fetch(WASENDER_SEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to, text: caption, imageUrl }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Wasender image send error:", res.status, err);
    if (res.status === 429) {
      console.log("Rate limited, waiting 6s before retry...");
      await delay(6000);
      const retryRes = await fetch(WASENDER_SEND_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to, text: caption, imageUrl }),
      });
      if (!retryRes.ok) {
        const retryErr = await retryRes.text();
        console.error("Retry also failed:", retryRes.status, retryErr);
      }
      return retryRes;
    }
  }
  return res;
}

// ─── Payment Slip Verification ───────────────────────────

// Normalize a slip reference/transaction number for duplicate detection.
// Returns null when the value is missing, placeholder-ish, or too short to trust.
function normalizeSlipReference(raw: any): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return null;
  const bad = ["NA", "NULL", "NONE", "UNKNOWN", "NOTVISIBLE", "NOTCLEAR", "NOTMENTIONED", "UNCLEAR"];
  if (bad.includes(cleaned)) return null;
  if (cleaned.length < 4) return null;
  return cleaned;
}

// Look for an existing payment already recorded with this slip reference.
async function findSlipByReference(supabase: any, slipRef: string): Promise<any | null> {
  try {
    const { data: byRef } = await supabase
      .from("payments")
      .select("id, status, phone_number, created_at")
      .eq("reference", slipRef)
      .limit(1)
      .maybeSingle();
    if (byRef) return byRef;

    const { data: byJson } = await supabase
      .from("payments")
      .select("id, status, phone_number, created_at")
      .eq("gateway_response->>slip_reference", slipRef)
      .limit(1)
      .maybeSingle();
    return byJson || null;
  } catch (e) {
    console.error("findSlipByReference error:", e);
    return null;
  }
}

async function handlePaymentSlip(

  supabase: any,
  userId: string,
  phone: string,
  imageUrl: string,
  sessionApiKey: string,
): Promise<boolean> {
  // Find latest pending_payment listing for this seller
  const { data: pendingListing } = await supabase
    .from("listings")
    .select("id, title, price")
    .eq("seller_id", userId)
    .eq("status", "pending_payment")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!pendingListing) return false;

  const expectedFee = feeForPrice(pendingListing.price, await getFeeConfig(supabase));

  // Ack immediately
  await sendWhatsAppMessage(
    phone,
    "🔍 Payment slip එක පරීක්ෂා කරමින් සිටී... කරුණාකර මොහොතක් රැඳී සිටින්න.",
    sessionApiKey,
  );
  await supabase.from("chat_messages").insert({
    user_id: userId,
    phone_number: phone,
    direction: "outgoing",
    message_text: "🔍 Verifying payment slip...",
    message_type: "text",
  });

  // Ask Lovable AI (vision) to extract details from the slip
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) {
    console.error("LOVABLE_API_KEY missing for slip verification");
    return false;
  }

  const systemPrompt = `You are a bank payment slip verifier AND image classifier. Look at the image and return STRICT JSON only, no prose.
Return JSON with keys:
{
  "image_type": "payment_slip" | "product_photo" | "other",
  "is_payment_slip": boolean,
  "beneficiary_name": string | null,
  "beneficiary_account": string | null,
  "bank": string | null,
  "amount": number | null,
  "currency": string | null,
  "date": string | null,
  "reference": string | null,
  "reason_if_invalid": string | null
}
Rules:
- "payment_slip" = bank deposit/transfer receipt, ATM slip, online banking screenshot, or mobile banking confirmation showing an amount + account.
- "product_photo" = a photo of a physical item/product (phone, vehicle, furniture, clothes, electronics, etc.) that a person would sell.
- "other" = anything else (selfie, screenshot of chat, meme, blank, etc.).
- Set is_payment_slip=true ONLY when image_type=="payment_slip".
- "reference": the slip's reference / transaction / receipt / journal number exactly as printed (letters+digits). Do NOT invent one. If it is missing, blurred, cropped, or unreadable, return null.
Expected beneficiary: "BuildStart (Pvt) Ltd", account "1001075073", bank "Commercial Bank". Expected minimum amount: LKR ${expectedFee}.`;


  let extracted: any = null;
  try {
    const resp = await fetch((Deno.env.get("AI_GATEWAY_URL") || "https://ai.gateway.lovable.dev/v1") + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: "Classify this image and (if slip) verify it. Return JSON." },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });
    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content || "{}";
    extracted = JSON.parse(content);
    console.log("Slip extraction:", JSON.stringify(extracted));
  } catch (e) {
    console.error("Slip AI error:", e);
  }

  // If image is clearly a product photo, don't reject — guide user to restart or complete payment
  if (extracted?.image_type === "product_photo") {
    const msg = `📸 මෙය නව භාණ්ඩයක photo එකක් ලෙස පෙනේ.\n\nඔබට දැනට *"${pendingListing.title}"* සඳහා ගෙවීම pending වේ. කරුණාකර පහත එකක් තෝරන්න:\n\n1️⃣ *ගෙවීම සම්පූර්ණ කරන්න* — bank slip photo එවන්න (LKR ${expectedFee.toLocaleString()})\n2️⃣ *අලුත් listing එකක් දාන්න* — "අලුතින්" හෝ "restart" ලෙස reply කර, පසුව නව photo එවන්න\n\n_වත්මන් pending listing එක අත්හැරීමට "අලුතින්" type කරන්න._`;
    await sendWhatsAppMessage(phone, msg, sessionApiKey);
    await supabase.from("chat_messages").insert({
      user_id: userId,
      phone_number: phone,
      direction: "outgoing",
      message_text: msg,
      message_type: "text",
    });
    return true;
  }

  const failMsg = async (reason: string) => {
    const msg = `⚠️ ඔබගේ Payment Slip එක තහවුරු කර ගැනීමට නොහැකි විය.\n\n*හේතුව:* ${reason}\n\nකරුණාකර පැහැදිලි Slip photo එකක් නැවත එවන්න, හෝ Card Payment link එක භාවිතා කරන්න.\n\n_නව භාණ්ඩයක් දැන්වීමට නම් "අලුතින්" type කරන්න._\n\n*නිවැරදි විස්තර:*\n🏦 Commercial Bank – Dehiwala\n👤 BuildStart (Pvt) Ltd\n🔢 1001075073\n💰 LKR ${expectedFee.toLocaleString()}`;
    await sendWhatsAppMessage(phone, msg, sessionApiKey);
    await supabase.from("chat_messages").insert({
      user_id: userId,
      phone_number: phone,
      direction: "outgoing",
      message_text: msg,
      message_type: "text",
    });
    // Persist failed slip so admins can review it in the dashboard.
    await supabase.from("payments").insert({
      reference: `SLIP-FAIL-${Date.now()}`,
      listing_id: pendingListing.id,
      seller_id: userId,
      phone_number: phone,
      amount: Number(extracted?.amount || 0),
      currency: extracted?.currency || "LKR",
      status: "failed",
      provider: "bank_transfer",
      gateway_response: { slip_url: imageUrl, extracted, failure_reason: reason },
    });
  };

  if (!extracted || !extracted.is_payment_slip) {
    await failMsg(extracted?.reason_if_invalid || "මෙය බැංකු Payment Slip එකක් ලෙස හඳුනාගත නොහැක.");
    return true;
  }

  // ── Slip reference number: must be present + unique ──
  const slipRef = normalizeSlipReference(extracted.reference);
  if (!slipRef) {
    const msg = `⚠️ Slip එකේ *Reference Number* එක පැහැදිලිව පෙනෙන්නේ නැහැ.\n\nකරුණාකර reference / transaction number එක පැහැදිලිව පෙනෙන පැහැදිලි photo එකක් නැවත එවන්න. 🙏\n\n_(Slip එකේ මුදල, ගිණුම් අංකය සහ reference number එක තිබිය යුතුයි.)_`;
    await sendWhatsAppMessage(phone, msg, sessionApiKey);
    await supabase.from("chat_messages").insert({
      user_id: userId,
      phone_number: phone,
      direction: "outgoing",
      message_text: msg,
      message_type: "text",
    });
    await supabase.from("payments").insert({
      reference: `SLIP-NOREF-${Date.now()}`,
      listing_id: pendingListing.id,
      seller_id: userId,
      phone_number: phone,
      amount: Number(extracted?.amount || 0),
      currency: extracted?.currency || "LKR",
      status: "failed",
      provider: "bank_transfer",
      gateway_response: { slip_url: imageUrl, extracted, failure_reason: "missing_reference" },
    });
    return true;
  }

  const duplicate = await findSlipByReference(supabase, slipRef);
  if (duplicate) {
    const msg = `⚠️ මෙම Slip එක *දැනටමත් upload කර ඇත*.\n\n🔢 Reference: *${slipRef}*\n\nඑකම slip එකක් නැවත භාවිතා කළ නොහැක. නව ගෙවීමක් සිදු කර, එහි slip එක එවන්න. උදව් අවශ්‍ය නම් admin අප හා සම්බන්ධ වෙයි.`;
    await sendWhatsAppMessage(phone, msg, sessionApiKey);
    await supabase.from("chat_messages").insert({
      user_id: userId,
      phone_number: phone,
      direction: "outgoing",
      message_text: msg,
      message_type: "text",
    });
    await supabase.from("payments").insert({
      reference: `SLIP-DUP-${Date.now()}`,
      listing_id: pendingListing.id,
      seller_id: userId,
      phone_number: phone,
      amount: Number(extracted?.amount || 0),
      currency: extracted?.currency || "LKR",
      status: "failed",
      provider: "bank_transfer",
      gateway_response: {
        slip_url: imageUrl,
        extracted,
        slip_reference: slipRef,
        failure_reason: "duplicate_reference",
        duplicate_of: duplicate.id,
      },
    });
    return true;
  }

  const beneficiary =
    `${extracted.beneficiary_name || ""} ${extracted.beneficiary_account || ""} ${extracted.bank || ""}`.toLowerCase();
  const nameOk = beneficiary.includes("buildstart") || beneficiary.includes("1001075073");
  const bankOk = !extracted.bank || String(extracted.bank).toLowerCase().includes("commercial");
  const amount = Number(extracted.amount || 0);
  const amountOk = amount >= expectedFee;

  if (!nameOk) {
    await failMsg(`Beneficiary නම නොගැලපේ (${extracted.beneficiary_name || "unknown"}).`);
    return true;
  }
  if (!bankOk) {
    await failMsg(`Bank නොගැලපේ (${extracted.bank}).`);
    return true;
  }
  if (!amountOk) {
    await failMsg(
      `ගෙවූ මුදල අවම මුදලට වඩා අඩුය. ගෙවා ඇත්තේ LKR ${amount.toLocaleString()}, අවශ්‍ය LKR ${expectedFee.toLocaleString()}.`,
    );
    return true;
  }

  // Verified — record payment + activate listing
  const reference = slipRef;
  await supabase.from("payments").insert({
    reference,
    listing_id: pendingListing.id,
    seller_id: userId,
    phone_number: phone,
    amount: amount,
    currency: extracted.currency || "LKR",
    status: "paid",
    provider: "bank_transfer",
    gateway_response: { slip_url: imageUrl, extracted, slip_reference: slipRef },
  });


  await supabase
    .from("listings")
    .update({ status: "active", payment_status: "paid", paid_at: new Date().toISOString() })
    .eq("id", pendingListing.id);

  // Record revenue (bank slip auto-approval)
  await supabase.from("revenue").insert({
    user_id: userId,
    type: "listing_fee",
    amount: amount,
    description: `Bank slip auto-approval for ${pendingListing.title} (${reference})`,
  });

  notifyAdminsPayment({
    method: "bank_transfer",
    seller_phone: phone,
    listing_title: pendingListing.title,
    amount,
    reference,
  });

  // Clear pending state — this listing is now live
  await updateBotState(supabase, userId, {
    mode: "idle",
    pending_listing_id: null,
    last_question: null,
  });

  const okMsg = `✅ *Payment Verified!*\n\n📝 *Listing:* ${pendingListing.title}\n💰 *Amount:* LKR ${amount.toLocaleString()}\n🏦 ${extracted.bank || "Commercial Bank"}\n🔢 Ref: ${reference}\n\n🎉 ඔබගේ Listing එක දැන් ක්‍රියාත්මකයි! Buyers ට එය සෙවිය හැක.`;
  await sendWhatsAppMessage(phone, okMsg, sessionApiKey);
  await supabase.from("chat_messages").insert({
    user_id: userId,
    phone_number: phone,
    direction: "outgoing",
    message_text: okMsg,
    message_type: "text",
  });

  // Referral: award the referrer, then invite this seller to the program too.
  try {
    await awardSellerReferral(supabase, userId, pendingListing.id, amount);
  } catch (e) {
    console.error("awardSellerReferral (bank slip) failed", e);
  }
  await delay(7000);
  await sendReferralPromo(supabase, userId, phone);
  return true;
}

async function handleOrphanPaymentSlip(
  supabase: any,
  userId: string,
  phone: string,
  imageUrl: string,
  sessionApiKey: string,
): Promise<boolean> {
  const looksLikeSlip = await classifyPaymentSlipImage(imageUrl, 300);
  if (!looksLikeSlip?.is_payment_slip) return false;

  const msg = `⚠️ Payment slip එක ලැබුණා, නමුත් මේ WhatsApp number එකට pending payment listing එකක් හමු වුණේ නැහැ.

කරුණාකර listing එක create කරලා bot එක payment details දුන්නාට පසුව slip එක එවන්න.

ඔබ already listing එකක් create කළා නම්, ඒ listing එක create කළ *same WhatsApp number* එකෙන් slip එක එවන්න.`;

  await sendWhatsAppMessage(phone, msg, sessionApiKey);
  await supabase.from("chat_messages").insert({
    user_id: userId,
    phone_number: phone,
    direction: "outgoing",
    message_text: msg,
    message_type: "text",
  });

  // Persist orphan slip for admin review in the dashboard.
  await supabase.from("payments").insert({
    reference: `SLIP-ORPHAN-${Date.now()}`,
    listing_id: null,
    seller_id: userId || null,
    phone_number: phone,
    amount: 0,
    currency: "LKR",
    status: "orphan",
    provider: "bank_transfer",
    gateway_response: { slip_url: imageUrl, note: "No pending listing for this number" },
  });

  return true;
}

async function classifyPaymentSlipImage(imageUrl: string, expectedFee: number): Promise<any | null> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return null;

  const systemPrompt = `You are a bank payment slip image classifier. Return STRICT JSON only.
Return {"image_type":"payment_slip"|"product_photo"|"other","is_payment_slip":boolean,"reason_if_invalid":string|null}.
Payment slip means bank deposit/transfer receipt, ATM slip, online banking screenshot, or mobile banking confirmation. Expected minimum amount: LKR ${expectedFee}.`;

  try {
    const resp = await fetch((Deno.env.get("AI_GATEWAY_URL") || "https://ai.gateway.lovable.dev/v1") + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: "Classify this image. Return JSON." },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });
    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content || "{}";
    return JSON.parse(content);
  } catch (e) {
    console.error("Orphan slip classifier error:", e);
    return null;
  }
}

// ─── Message Batching Helpers ────────────────────────────

async function hasRecentIncoming(supabase: any, phone: string, seconds: number): Promise<boolean> {
  const since = new Date(Date.now() - seconds * 1000).toISOString();
  const { data } = await supabase
    .from("chat_messages")
    .select("id, metadata")
    .eq("phone_number", phone)
    .eq("direction", "incoming")
    .gte("created_at", since)
    .limit(5);
  return (data || []).some((m: any) => {
    const imgs = (m.metadata as any)?.image_urls;
    return Array.isArray(imgs) && imgs.length > 0;
  });
}

async function aggregateUnansweredBatch(
  supabase: any,
  phone: string,
): Promise<{ text: string; imageUrls: string[]; messageIds: string[]; rawMetadata: Record<string, any> }> {
  const { data: lastOut } = await supabase
    .from("chat_messages")
    .select("created_at")
    .eq("phone_number", phone)
    .eq("direction", "outgoing")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const sinceIso = lastOut?.created_at || new Date(Date.now() - 60_000).toISOString();

  const { data: incoming } = await supabase
    .from("chat_messages")
    .select("id, message_text, message_type, metadata, created_at")
    .eq("phone_number", phone)
    .eq("direction", "incoming")
    .gt("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(30);

  // HARDENED DEDUP: skip messages another concurrent handler has already marked processed
  const unprocessed = (incoming || []).filter((m: any) => !((m.metadata as any)?.processed === true));

  const texts: string[] = [];
  const imageSet = new Set<string>();
  const ids: string[] = [];
  const rawMetadata: Record<string, any> = {};

  for (const m of unprocessed) {
    ids.push(m.id);
    rawMetadata[m.id] = m.metadata || {};
    const cleaned = String(m.message_text || "")
      .replace(/\s*\[📷[^\]]*\]\s*$/u, "")
      .trim();
    if (cleaned) texts.push(cleaned);
    const imgs = (m.metadata as any)?.image_urls;
    if (Array.isArray(imgs)) for (const u of imgs) if (typeof u === "string" && u) imageSet.add(u);
  }

  const uniqueText = [...new Set(texts)].join(" ").trim();
  return { text: uniqueText, imageUrls: [...imageSet], messageIds: ids, rawMetadata };
}

// ─── User Context & Bot State ────────────────────────────

function isRestartCommand(text: string): boolean {
  const t = (text || "").toLowerCase().trim();
  if (!t) return false;
  // English + Sinhala + Tamil restart / cancel / start-over intents
  const patterns = [
    /^(restart|reset|cancel|start\s*over|new|nevermind|never\s*mind|clear|forget\s*it)\b/i,
    /^(අලුතින්|නවත්වන්න|අවලංගු|නවතන්න|මුල\s*ඉඳන්|අලුත්\s*එකක්)/,
    /^(மீண்டும்|ரத்து|நிறுத்து|மறு\s*தொடக்கம்|புதிதாக)/,
  ];
  return patterns.some((r) => r.test(t));
}

async function handleRestart(supabase: any, userId: string, phone: string): Promise<string> {
  // Abandon any pending payment listing
  const { data: pending } = await supabase
    .from("listings")
    .select("id, title")
    .eq("seller_id", userId)
    .eq("status", "pending_payment")
    .order("created_at", { ascending: false });

  let abandonedTitles: string[] = [];
  if (pending && pending.length > 0) {
    const ids = pending.map((p: any) => p.id);
    await supabase.from("listings").update({ status: "abandoned" }).in("id", ids);
    abandonedTitles = pending.map((p: any) => p.title);
  }

  // Reset bot state
  await updateBotState(supabase, userId, {
    mode: "idle",
    pending_listing_id: null,
    collecting: [],
    last_question: null,
    restart_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const abandonedLine = abandonedTitles.length > 0 ? `\n\n_මකා දැමූ draft: ${abandonedTitles.join(", ")}_` : "";

  return (
    `🔄 *නැවත ආරම්භ කරමු!*\n\n` +
    `මම ඔබේ පෙර සංවාදය පිරිසිදු කළා. ${abandonedLine}\n\n` +
    `ඔබට උදව් කරන්නේ කුමකටද?\n` +
    `• භාණ්ඩයක් සොයන්න — නම type කරන්න (උදා: *iPhone 13 Colombo*)\n` +
    `• භාණ්ඩයක් විකිණීමට — *sell* type කරන්න`
  );
}

// ── Card / OnePay link re-request ─────────────────────────
function looksLikeCardPaymentRequest(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  // English / Sinhala / Singlish variants asking for the card / OnePay link.
  const patterns = [
    /\bcard\b/,
    /\bcarde?\b/,
    /\bcard payment\b/,
    /\bonepay\b/,
    /\bpayment link\b/,
    /\bpay link\b/,
    /\bpay by card\b/,
    /card\s*eken/,
    /card\s*valin/,
    /card\s*ekak/,
    /gevanne\s*kese/,
    /gevanna\s*kese/,
    /link\s*ekak/,
    /card\s*hara/,
    /කාඩ්/,
    /කාඩ්පත්/,
    /පේමන්ට්\s*ලින්ක්/,
    /ගෙවීමේ\s*ලින්ක්/,
  ];
  return patterns.some((p) => p.test(t));
}

async function resendPendingPaymentLink(
  supabase: any,
  userId: string,
  phone: string,
  sessionApiKey: string | null,
): Promise<boolean> {
  // Only resend if the seller has a pending_payment listing.
  const { data: listing } = await supabase
    .from("listings")
    .select("id, title, listing_fee, price, payment_status")
    .eq("seller_id", userId)
    .eq("status", "pending_payment")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!listing || listing.payment_status === "paid") return false;

  // Prefer an existing pending OnePay checkout URL from the payments table.
  const { data: payment } = await supabase
    .from("payments")
    .select("redirect_url, status, amount, reference")
    .eq("listing_id", listing.id)
    .eq("provider", "onepay")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let redirectUrl: string | null = payment?.redirect_url && payment.status !== "paid" ? payment.redirect_url : null;
  let amount = Number(payment?.amount || listing.listing_fee || feeForPrice(listing.price, await getFeeConfig(supabase)));

  // If no stored link (or it belongs to a completed payment), request a fresh one.
  if (!redirectUrl) {
    try {
      const payResp = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/onepay-create-payment-taktak`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ listing_id: listing.id }),
      });
      const payJson = await payResp.json();
      redirectUrl = payJson?.redirect_url || null;
      if (payJson?.amount) amount = payJson.amount;
    } catch (e) {
      console.error("resendPendingPaymentLink: onepay-create-payment failed", e);
    }
  }

  const msg = redirectUrl
    ? `💳 *Card Payment Link*\n\n` +
      `📝 *Listing:* ${listing.title}\n` +
      `💰 *ගාස්තුව:* LKR ${amount.toLocaleString()}\n\n` +
      `පහත Link එක ඔස්සේ ආරක්ෂිතව Card Payment එක සිදු කරන්න:\n${redirectUrl}\n\n` +
      `_ගෙවීම තහවුරු වූ විගස ඔබගේ Listing එක ස්වයංක්‍රීයව live වේ._`
    : `⚠️ Card payment link එක දැන් generate කර ගැනීමට නොහැකි විය. කරුණාකර මිනිත්තු කිහිපයකින් නැවත උත්සාහ කරන්න, හෝ Bank Transfer භාවිතා කරන්න:\n\n` +
      `🏦 Commercial Bank – Dehiwala\n👤 BuildStart (Pvt) Ltd\n🔢 1001075073\n💰 LKR ${amount.toLocaleString()}`;

  await sendWhatsAppMessage(phone, msg, sessionApiKey);
  await supabase.from("chat_messages").insert({
    user_id: userId,
    phone_number: phone,
    direction: "outgoing",
    message_text: msg,
    message_type: "text",
    metadata: { action: "resend_onepay_link", listing_id: listing.id },
  });
  return true;
}

// ── Buyer demand estimate for a listing (used at the top of the payment message)
function demandTokens(title: string): string[] {
  return String(title || "")
    .toLowerCase()
    .split(/[^a-z0-9\u0D80-\u0DFF\u0B80-\u0BFF]+/)
    .filter((t) => t.length >= 3)
    .slice(0, 6);
}

function demandHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

async function estimateBuyersForListing(
  supabase: any,
  listing: { id: string; title: string; category?: string | null },
): Promise<number> {
  const cat = String(listing.category || "").toLowerCase();
  const toks = demandTokens(listing.title);
  let real = 0;
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [{ data: alerts }, { data: searches }] = await Promise.all([
      supabase
        .from("buyer_alerts")
        .select("search_query, product_keyword, category")
        .eq("is_active", true)
        .limit(3000),
      supabase
        .from("search_history")
        .select("query_text, detected_product, detected_category, user_id")
        .gte("created_at", since)
        .limit(5000),
    ]);
    const match = (text: string, c: string) =>
      (cat && c && c === cat) || toks.some((t) => text.includes(t));
    const alertMatches = (alerts || []).filter((a: any) =>
      match(`${a.search_query || ""} ${a.product_keyword || ""}`.toLowerCase(), String(a.category || "").toLowerCase()),
    ).length;
    const searcherSet = new Set(
      (searches || [])
        .filter((s: any) =>
          match(`${s.query_text || ""} ${s.detected_product || ""}`.toLowerCase(), String(s.detected_category || "").toLowerCase()),
        )
        .map((s: any) => String(s.user_id || "")),
    );
    real = alertMatches + searcherSet.size;
  } catch (e) {
    console.error("estimateBuyersForListing failed:", e);
  }
  const h = demandHash(String(listing.id));
  const floor = 105 + (h % 60);
  const wobble = (h >> 5) % 15;
  return Math.min(Math.max(real, floor) + wobble, 400);
}


async function updateBotState(supabase: any, userId: string, patch: Record<string, any>): Promise<void> {
  try {
    const { data: existing } = await supabase
      .from("marketplace_users")
      .select("bot_state")
      .eq("id", userId)
      .maybeSingle();
    const merged = { ...((existing?.bot_state as any) || {}), ...patch, updated_at: new Date().toISOString() };
    await supabase.from("marketplace_users").update({ bot_state: merged }).eq("id", userId);
  } catch (e) {
    console.error("updateBotState failed:", e);
  }
}

async function loadUserContext(supabase: any, userId: string | null, phone: string): Promise<string> {
  if (!userId) return "";

  try {
    const [{ data: profile }, { data: pending }, { data: active }, { data: alerts }, { data: lastOut }] =
      await Promise.all([
        supabase
          .from("marketplace_users")
          .select(
            "display_name, city, district, bot_state, created_at, subscription_type, trust_score, successful_sales, successful_purchases",
          )
          .eq("id", userId)
          .maybeSingle(),
        supabase
          .from("listings")
          .select("id, title, price, created_at")
          .eq("seller_id", userId)
          .eq("status", "pending_payment")
          .order("created_at", { ascending: false })
          .limit(3),
        supabase
          .from("listings")
          .select("id, title, price, city, views_count")
          .eq("seller_id", userId)
          .eq("status", "active")
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("buyer_alerts")
          .select("search_query, location, max_price")
          .eq("user_id", userId)
          .eq("is_active", true)
          .limit(3),
        supabase
          .from("chat_messages")
          .select("message_text, created_at")
          .eq("user_id", userId)
          .eq("direction", "outgoing")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    const lines: string[] = [];
    const name = profile?.display_name || "unknown";
    const loc = [profile?.city, profile?.district].filter(Boolean).join(", ") || "unknown";
    const sub = profile?.subscription_type || "free";
    lines.push(`Phone: +${phone} | Name: ${name} | Location: ${loc} | Plan: ${sub}`);

    const state = (profile?.bot_state as any) || {};
    if (state.mode && state.mode !== "idle") {
      lines.push(
        `Bot mode: ${state.mode}${state.last_question ? ` | Last asked: ${state.last_question}` : ""}${state.pending_listing_id ? ` | Pending listing id: ${state.pending_listing_id}` : ""}`,
      );
    } else {
      lines.push(`Bot mode: idle (no pending flow — treat this as a fresh turn).`);
    }

    if (pending && pending.length > 0) {
      lines.push(`⏳ PENDING PAYMENT LISTINGS (waiting for payment slip / OnePay):`);
      for (const p of pending) {
        lines.push(`  - ${p.title} (LKR ${p.price}) — id=${p.id}`);
      }
      lines.push(
        `  → If the user sends a payment slip image, says "done/paid/ගෙව්වා", or asks about payment status, they mean the MOST RECENT pending listing above. Do NOT restart the selling flow.`,
      );
    }

    if (active && active.length > 0) {
      lines.push(`✅ ACTIVE LISTINGS (${active.length}) — user is a returning seller:`);
      for (const l of active) {
        lines.push(`  - ${l.title} (LKR ${l.price}, ${l.city}, ${l.views_count || 0} views)`);
      }
    } else {
      lines.push(`No active listings yet — user is either a buyer or a first-time seller.`);
    }

    if (alerts && alerts.length > 0) {
      lines.push(`🔔 ACTIVE BUYER ALERTS (user is already subscribed to these searches):`);
      for (const a of alerts) {
        const bits = [a.search_query, a.location, a.max_price ? `≤ LKR ${a.max_price}` : null]
          .filter(Boolean)
          .join(" | ");
        lines.push(`  - ${bits}`);
      }
      lines.push(`  → Do NOT offer to subscribe them again for the same query.`);
    }

    if (lastOut?.message_text) {
      const snippet = String(lastOut.message_text).replace(/\s+/g, " ").slice(0, 240);
      lines.push(`LAST BOT MESSAGE (what you said to them just before): "${snippet}"`);
      lines.push(
        `  → Interpret short replies like "1", "2", "yes", "ok" ONLY in the context of the last bot message. If it did not offer numbered options, treat the number as content (e.g. picking listing #2), NOT as a menu choice.`,
      );
    }

    if (state.restart_at) {
      lines.push(
        `ℹ️ User restarted the conversation at ${state.restart_at}. Ignore chat history before this timestamp.`,
      );
    }

    return `\n\nUSER_CONTEXT (about the person you are talking to right now):\n${lines.join("\n")}`;
  } catch (e) {
    console.error("loadUserContext failed:", e);
    return "";
  }
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
