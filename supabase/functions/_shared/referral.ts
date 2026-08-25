// TakTak referral program — shared logic for all edge functions.
import { sendWhatsAppText } from "./whatsapp.ts";

export interface ReferralConfig {
  enabled: boolean;
  seller_percent: number;
  buyer_reward: number;
  min_redeem: number;
  bot_number: string;
}

export const DASHBOARD_LOGIN_URL = "https://taktak.buildstart.io/login";

export const DEFAULT_REFERRAL: ReferralConfig = {
  enabled: true,
  seller_percent: 20,
  buyer_reward: 5,
  min_redeem: 1000,
  bot_number: "94722756169",
};

export async function getReferralConfig(supabase: any): Promise<ReferralConfig> {
  try {
    const { data } = await supabase
      .from("bot_settings")
      .select("value")
      .eq("key", "referral")
      .maybeSingle();
    const v = (data?.value || {}) as Partial<ReferralConfig>;
    return {
      enabled: v.enabled !== false,
      seller_percent: Number(v.seller_percent) > 0 ? Number(v.seller_percent) : DEFAULT_REFERRAL.seller_percent,
      buyer_reward: Number(v.buyer_reward) >= 0 ? Number(v.buyer_reward) : DEFAULT_REFERRAL.buyer_reward,
      min_redeem: Number(v.min_redeem) > 0 ? Number(v.min_redeem) : DEFAULT_REFERRAL.min_redeem,
      bot_number: String(v.bot_number || DEFAULT_REFERRAL.bot_number),
    };
  } catch {
    return DEFAULT_REFERRAL;
  }
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomCode() {
  let s = "";
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `TAK-${s}`;
}

/** Returns the user's referral code, creating one if missing. */
export async function ensureReferralCode(supabase: any, userId: string): Promise<string | null> {
  if (!userId) return null;
  const { data: existing } = await supabase
    .from("marketplace_users")
    .select("referral_code")
    .eq("id", userId)
    .maybeSingle();
  if (existing?.referral_code) return existing.referral_code;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const { error } = await supabase
      .from("marketplace_users")
      .update({ referral_code: code })
      .eq("id", userId)
      .is("referral_code", null);
    if (!error) {
      const { data } = await supabase
        .from("marketplace_users")
        .select("referral_code")
        .eq("id", userId)
        .maybeSingle();
      if (data?.referral_code) return data.referral_code;
    }
  }
  return null;
}

export function referralLink(code: string, botNumber: string) {
  return `https://wa.me/${botNumber}?text=${encodeURIComponent(code)}`;
}

export const REFERRAL_CODE_RE = /\bTAK-[A-Z0-9]{4,8}\b/i;

/** Explainer + ready-to-forward promo pair (same copy as the broadcast). */
export function referralPromoMessages(link: string, cfg: ReferralConfig): [string, string] {
  const one = `*TakTak ගැන ඔයාගේ යාලුවන්ට කියලා දැන් සල්ලි හොයන්න පුලුවන්!* 💰

Earn කරන්නේ කොහොමද?

🔗 Step 1: ඔයාගේ Referral Link එක Share කරන්න.

🔎 Step 2: ඒ Link එකෙන් කෙනෙක් Ad එකක් Search කළොත් ඔයාට රු. ${cfg.buyer_reward}ක් ලැබෙනවා!

🏷️ Step 3: ඒ Link එකෙන් කෙනෙක් Ad එකක් පළ කළොත් (List කළොත්) Listing Fee එකෙන් ${cfg.seller_percent}%ක්ම ඔයාට!

ඔයාගේ Link එක 👇
${link}

⚠️ මතක තියාගන්න: මේ link එක *ඔයාම click කරන්න එපා*. එයින් ඔයාට මුදල් ලැබෙන්නේ නෑ. යාලුවන්ට, ග්‍රුප් වලට *share* කරන්නම තියෙන්නේ.

💳 එකතු වන මුදල් claim කරන්න: ${DASHBOARD_LOGIN_URL}

🚀 පහළින් එවන message එක එහෙමම යාලුවන්ට forward කරන්න — ඒකේ ඔයාගේ link එක දාලා තියෙනවා!`;

  const two = `ඔයාට ඉඩමක්, ගෙයක්, වාහනයක් නැත්තන් laptop එකක් ඉක්මනට විකුනගන්න ඕනේද?

නැත්තන් ගන්න හොයනවද?

මේ ලින්ක් එකෙන් ඕනෙම දෙයක් WhatsApp එකෙන් ඉක්මනට හොයාගන්න පුලුවන්!
${link}`;

  return [one, two];
}

/** Sends the two referral promo messages to a user (used after a successful publish). */
export async function sendReferralPromo(supabase: any, userId: string, phone: string): Promise<void> {
  try {
    const cfg = await getReferralConfig(supabase);
    if (!cfg.enabled) return;
    // Send once per user — never spam the promo on repeat publishes.
    const { count: alreadySent } = await supabase
      .from("chat_messages")
      .select("id", { count: "exact", head: true })
      .eq("phone_number", phone)
      .eq("direction", "outgoing")
      .contains("metadata", { action: "referral_promo_after_publish" });
    if ((alreadySent ?? 0) > 0) return;
    const code = await ensureReferralCode(supabase, userId);
    if (!code) return;
    const [one, two] = referralPromoMessages(referralLink(code, cfg.bot_number), cfg);
    for (const msg of [one, two]) {
      const r = await sendWhatsAppText(supabase, phone, msg);
      try {
        await supabase.from("chat_messages").insert({
          user_id: userId,
          phone_number: phone,
          direction: "outgoing",
          message_text: msg,
          message_type: "text",
          metadata: { action: "referral_promo_after_publish", sent: r.sent },
        });
      } catch (_e) { /* logging must never block */ }
      await new Promise((r2) => setTimeout(r2, 7000));
    }
  } catch (e) {
    console.error("sendReferralPromo failed", e);
  }
}

/** Message shown when a user clicks/sends their OWN referral link. */
export function selfReferralMessage(link: string): string {
  return `😊 ඒක *ඔයාගේම* referral link එකයි!

ඔයාම මේ link එක use කළාම ඔයාට මුදලක් ලැබෙන්නේ නෑ. මේක *යාලුවන්ට, ග්‍රුප් වලට share කරන්න* තියෙන එකක්.

ඔයාගේ link එකෙන් අලුත් කෙනෙක් ආවම විතරයි reward එක ලැබෙන්නේ 👇
${link}

💳 එකතු වන මුදල් claim කරන්න: ${DASHBOARD_LOGIN_URL}`;
}

/** Extracts a referral code from an incoming message, if present. */
export function extractReferralCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(REFERRAL_CODE_RE);
  return m ? m[0].toUpperCase() : null;
}

/** Removes the referral code from message text so the AI never sees it. */
export function stripReferralCode(text: string | null | undefined): string {
  return (text || "").replace(new RegExp(REFERRAL_CODE_RE.source, "gi"), "").trim();
}

/**
 * Attributes a new user to a referrer. Only NEW numbers count: the referred
 * phone must not already exist on the platform (no earlier chat history, no
 * listings, and the user row must have just been created). One award per
 * phone number, never self-referral.
 */
export async function attributeReferral(
  supabase: any,
  code: string,
  referredUserId: string,
  referredPhone: string,
): Promise<boolean> {
  if (!code || !referredUserId) return false;

  const { data: existing } = await supabase
    .from("referrals")
    .select("id")
    .or(`referred_id.eq.${referredUserId},referred_phone.eq.${referredPhone}`)
    .limit(1)
    .maybeSingle();
  if (existing) return false;

  // ── The referred number must be brand new to TakTak ──
  const { data: referredUser } = await supabase
    .from("marketplace_users")
    .select("created_at")
    .eq("id", referredUserId)
    .maybeSingle();
  if (!referredUser?.created_at) return false;
  const ageMs = Date.now() - new Date(referredUser.created_at).getTime();
  if (ageMs > 10 * 60 * 1000) return false; // known number → not eligible

  const { count: priorIncoming } = await supabase
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("phone_number", referredPhone)
    .eq("direction", "incoming");
  if ((priorIncoming ?? 0) > 0) return false;

  const { count: priorListings } = await supabase
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", referredUserId);
  if ((priorListings ?? 0) > 0) return false;

  const { data: referrer } = await supabase
    .from("marketplace_users")
    .select("id")
    .eq("referral_code", code.toUpperCase())
    .maybeSingle();
  if (!referrer?.id || referrer.id === referredUserId) return false;

  const { error } = await supabase.from("referrals").insert({
    referrer_id: referrer.id,
    referred_id: referredUserId,
    referred_phone: referredPhone,
    code: code.toUpperCase(),
  });
  return !error;
}


async function notifyReferrer(supabase: any, referrerId: string, text: string) {
  try {
    const { data } = await supabase
      .from("marketplace_users")
      .select("phone_number")
      .eq("id", referrerId)
      .maybeSingle();
    if (data?.phone_number) await sendWhatsAppText(supabase, data.phone_number, text);
  } catch (e) {
    console.error("referral notify failed", e);
  }
}

async function totalPoints(supabase: any, referrerId: string): Promise<number> {
  const { data } = await supabase
    .from("referral_rewards")
    .select("amount")
    .eq("referrer_id", referrerId);
  return (data || []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
}

/** Award the referrer 20% (configurable) of a paid listing fee. Idempotent per listing. */
export async function awardSellerReferral(
  supabase: any,
  sellerId: string,
  listingId: string,
  fee: number,
): Promise<void> {
  try {
    const cfg = await getReferralConfig(supabase);
    if (!cfg.enabled) return;

    const { data: ref } = await supabase
      .from("referrals")
      .select("referrer_id")
      .eq("referred_id", sellerId)
      .maybeSingle();
    if (!ref?.referrer_id) return;

    const amount = Math.round((Number(fee) || 0) * (cfg.seller_percent / 100));
    if (amount <= 0) return;

    const { error } = await supabase.from("referral_rewards").insert({
      referrer_id: ref.referrer_id,
      referred_id: sellerId,
      reward_type: "seller_listing",
      amount,
      listing_id: listingId,
      description: `Referred seller paid listing fee LKR ${fee}`,
    });
    if (error) return; // duplicate → already awarded

    const total = await totalPoints(supabase, ref.referrer_id);
    await notifyReferrer(
      supabase,
      ref.referrer_id,
      `🎉 සුබ පැතුම්! ඔයා share කරපු link එකෙන් ආපු කෙනෙක් listing එකක් publish කළා.\n\n*ඔයාට හම්බවුණා: රු. ${amount}* 💰\nමුළු referral එකතුව: *රු. ${total}*\n\n💳 Points claim කරන්න login වෙන්න: ${DASHBOARD_LOGIN_URL}`,
    );
  } catch (e) {
    console.error("awardSellerReferral failed", e);
  }
}

/** Award the referrer a small bonus the first time a referred buyer searches. */
export async function awardBuyerReferral(supabase: any, buyerId: string): Promise<void> {
  try {
    const cfg = await getReferralConfig(supabase);
    if (!cfg.enabled || cfg.buyer_reward <= 0) return;

    const { data: ref } = await supabase
      .from("referrals")
      .select("referrer_id")
      .eq("referred_id", buyerId)
      .maybeSingle();
    if (!ref?.referrer_id) return;

    const { error } = await supabase.from("referral_rewards").insert({
      referrer_id: ref.referrer_id,
      referred_id: buyerId,
      reward_type: "buyer_search",
      amount: cfg.buyer_reward,
      description: "Referred buyer searched for a product",
    });
    if (error) return; // already awarded for this buyer

    const total = await totalPoints(supabase, ref.referrer_id);
    await notifyReferrer(
      supabase,
      ref.referrer_id,
      `✅ ඔයාගේ link එකෙන් ආපු කෙනෙක් TakTak එකේ search කළා.\n\n*ඔයාට හම්බවුණා: රු. ${cfg.buyer_reward}*\nමුළු referral එකතුව: *රු. ${total}*\n\n💳 Points claim කරන්න login වෙන්න: ${DASHBOARD_LOGIN_URL}`,
    );
  } catch (e) {
    console.error("awardBuyerReferral failed", e);
  }
}
