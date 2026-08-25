// Slow, human-paced referral promo broadcast to every existing WhatsApp user.
//
// Two messages per recipient:
//   1) "Earn with TakTak" referral explainer + the user's OWN referral link
//      (+ a warning not to click it themselves)
//   2) A ready-to-forward message for their friends, with the same link
//
// Anti-ban design: at most a couple of recipients per run, randomised gaps,
// and every recipient recorded in referral_broadcast_log so nobody gets it
// twice. Oldest users first, so the list is completed from day one onwards.
//
// Actions (POST body):
//   {}                          -> run one batch (cron)
//   { action: "status" }        -> progress counters
//   { action: "send", phone }   -> send immediately to one number (resend ok)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWhatsAppText } from "../_shared/whatsapp.ts";
import { ensureReferralCode, getReferralConfig, referralLink } from "../_shared/referral.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Pacing: max 100 recipients per day, one at a time, at least ~12 minutes
// apart, so the sending looks human and never resembles a bulk blast.
const MAX_PER_RUN = 1;
const DAILY_CAP = 100;
const MIN_SPACING_MS = 12 * 60 * 1000;
const MIN_GAP_MS = 12000;
const MAX_GAP_MS = 25000;
const MIN_MSG_GAP_MS = 6000;
const MAX_MSG_GAP_MS = 11000;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (a: number, b: number) => Math.floor(a + Math.random() * (b - a));

function isRealPhone(phone: string | null | undefined) {
  const d = String(phone || "").replace(/\D/g, "");
  return d.length >= 9 && d.length <= 13;
}

function messageOne(link: string) {
  return `*TakTak ගැන ඔයාගේ යාලුවන්ට කියලා දැන් සල්ලි හොයන්න පුලුවන්!* 💰

Earn කරන්නේ කොහොමද?

🔗 Step 1: ඔයාගේ Referral Link එක Share කරන්න.

🔎 Step 2: ඒ Link එකෙන් කෙනෙක් Ad එකක් Search කළොත් ඔයාට මුදල් ලැබෙනවා!

🏷️ Step 3: ඒ Link එකෙන් කෙනෙක් Ad එකක් පළ කළොත් (List කළොත්) Listing Fee එකෙන් 20%ක්ම ඔයාට!

ඔයාගේ Link එක 👇
${link}

⚠️ මතක තියාගන්න: මේ link එක *ඔයාම click කරන්න එපා*. එයින් ඔයාට මුදල් ලැබෙන්නේ නෑ. යාලුවන්ට, ග්‍රුප් වලට *share* කරන්නම තියෙන්නේ.

🚀 පහළින් එවන message එක එහෙමම යාලුවන්ට forward කරන්න — ඒකේ ඔයාගේ link එක දාලා තියෙනවා!`;
}

function messageTwo(link: string) {
  // Standalone, ready-to-forward as-is — no instructions, nothing to delete.
  return `ඔයාට ඉඩමක්, ගෙයක්, වාහනයක් නැත්තන් laptop එකක් ඉක්මනට විකුනගන්න ඕනේද?

නැත්තන් ගන්න හොයනවද?

මේ ලින්ක් එකෙන් ඕනෙම දෙයක් WhatsApp එකෙන් ඉක්මනට හොයාගන්න පුලුවන්!
${link}`;
}

async function sendToUser(supabase: any, user: any, botNumber: string) {
  const code = await ensureReferralCode(supabase, user.id);
  if (!code) return { ok: false, error: "no referral code" };
  const link = referralLink(code, botNumber);

  const r1 = await sendWhatsAppText(supabase, user.phone_number, messageOne(link));
  if (!r1.sent) return { ok: false, error: r1.error || "send failed" };
  await delay(jitter(MIN_MSG_GAP_MS, MAX_MSG_GAP_MS));
  const r2 = await sendWhatsAppText(supabase, user.phone_number, messageTwo(link));
  return { ok: true, error: r2.sent ? null : r2.error || "second message failed" };
}

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = await req.json().catch(() => ({} as any));
    const action = String(body?.action || "run");
    const cfg = await getReferralConfig(supabase);

    if (action === "status") {
      const [{ count: total }, { count: done }] = await Promise.all([
        supabase.from("marketplace_users").select("id", { count: "exact", head: true }),
        supabase.from("referral_broadcast_log").select("id", { count: "exact", head: true }),
      ]);
      return new Response(JSON.stringify({ success: true, total, done, remaining: (total || 0) - (done || 0) }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "send") {
      const phone = String(body?.phone || "").replace(/\D/g, "");
      const { data: user } = await supabase
        .from("marketplace_users")
        .select("id, phone_number")
        .eq("phone_number", phone)
        .maybeSingle();
      if (!user) {
        return new Response(JSON.stringify({ success: false, error: "user not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const r = await sendToUser(supabase, user, cfg.bot_number);
      await supabase.from("referral_broadcast_log").upsert(
        { user_id: user.id, phone_number: user.phone_number, status: r.ok ? "sent" : "failed", error: r.error },
        { onConflict: "phone_number" },
      );
      return new Response(JSON.stringify({ success: r.ok, error: r.error }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Scheduled batch
    const { data: settings } = await supabase
      .from("bot_settings")
      .select("value")
      .eq("key", "referral_broadcast")
      .maybeSingle();
    const enabled = (settings?.value as any)?.enabled !== false;
    if (!enabled || !cfg.enabled) {
      return new Response(JSON.stringify({ success: true, skipped: "disabled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Pace: stop at the daily cap and keep a wide gap between recipients.
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const { count: sentToday } = await supabase
      .from("referral_broadcast_log")
      .select("id", { count: "exact", head: true })
      .gte("sent_at", dayStart.toISOString());
    if ((sentToday || 0) >= DAILY_CAP) {
      return new Response(JSON.stringify({ success: true, skipped: "daily cap reached", sentToday }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: lastRow } = await supabase
      .from("referral_broadcast_log")
      .select("sent_at")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastRow?.sent_at && Date.now() - new Date(lastRow.sent_at).getTime() < MIN_SPACING_MS) {
      return new Response(JSON.stringify({ success: true, skipped: "too soon" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: sentRows } = await supabase.from("referral_broadcast_log").select("phone_number");
    const sentSet = new Set((sentRows || []).map((r: any) => r.phone_number));

    const { data: users } = await supabase
      .from("marketplace_users")
      .select("id, phone_number, created_at")
      .order("created_at", { ascending: true })
      .limit(2000);

    const queue = (users || [])
      .filter((u: any) => isRealPhone(u.phone_number) && !sentSet.has(u.phone_number))
      .slice(0, MAX_PER_RUN);

    const results: any[] = [];
    for (let i = 0; i < queue.length; i++) {
      const u = queue[i];
      const r = await sendToUser(supabase, u, cfg.bot_number);
      await supabase.from("referral_broadcast_log").upsert(
        { user_id: u.id, phone_number: u.phone_number, status: r.ok ? "sent" : "failed", error: r.error },
        { onConflict: "phone_number" },
      );
      results.push({ phone: u.phone_number, ok: r.ok, error: r.error });
      if (i < queue.length - 1) await delay(jitter(MIN_GAP_MS, MAX_GAP_MS));
    }

    return new Response(JSON.stringify({ success: true, processed: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("send-referral-broadcast error", e);
    return new Response(JSON.stringify({ success: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
