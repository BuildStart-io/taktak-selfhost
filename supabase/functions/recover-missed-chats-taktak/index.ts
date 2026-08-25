// Recovery tool for the outage window.
//
// The bot crashed at boot for a period (bad CDN dependency), so some inbound
// WhatsApp messages were never processed OR logged. This function talks to the
// Wasender API directly to find chats whose LAST message came from the user and
// was never answered, then sends a short apology + "we're back" nudge.
//
// Modes:
//   POST { probe: true }                    -> report which Wasender endpoints work
//   POST { since_hours: 24, dry_run: true } -> list who would be contacted
//   POST { since_hours: 24 }                -> actually send (spaced 6s)
//   POST { phones: ["9477..."] }            -> send to an explicit list
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveSessionKeys, isWahaKey, sendWhatsAppText } from "../_shared/whatsapp.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RECOVERY_MESSAGE =
  "🙏 සමාවෙන්න! අපේ system එකේ තාවකාලික බාධාවක් නිසා ඔයාගේ පණිවිඩයට වෙලාවට උත්තර දෙන්න බැරි වුණා.\n\n" +
  "දැන් TakTak නැවත සම්පූර්ණයෙන්ම වැඩ කරනවා ✅\n\n" +
  "ඔයා හොයපු දේ හෝ විකුණන්න ඕන දේ *නැවත එක් message එකකින්* එවන්න — මම වහාම උදව් කරන්නම්. 😊";

async function wasenderGet(key: string, path: string) {
  const res = await fetch(`https://www.wasenderapi.com${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, ok: res.ok, body };
}

function digitsOf(jid: string) {
  return String(jid || "").split("@")[0].replace(/\D/g, "");
}

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const opts = await req.json().catch(() => ({} as any));
    const keys = await resolveSessionKeys(supabase);
    const wasenderKey = keys.find((k) => !isWahaKey(k)) || "";
    if (!wasenderKey) {
      return new Response(JSON.stringify({ error: "no wasender session key" }), { status: 500, headers: jsonHeaders });
    }

    const personalToken = Deno.env.get("WASENDER_PERSONAL_ACCESS_TOKEN") || "";

    if (opts.probe) {
      const probeKey = opts.use_personal ? personalToken : wasenderKey;
      const probes: Record<string, unknown> = {};
      const paths: string[] = Array.isArray(opts.paths) && opts.paths.length
        ? opts.paths
        : ["/api/chats", "/api/contacts", "/api/status"];
      for (const p of paths) {
        if (opts.post) {
          const res = await fetch(`https://www.wasenderapi.com${p}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${probeKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(opts.body || {}),
          });
          const t = await res.text();
          probes[p] = { status: res.status, sample: t.slice(0, 400) };
        } else {
          const r = await wasenderGet(probeKey, p);
          probes[p] = { status: r.status, sample: JSON.stringify(r.body).slice(0, 700) };
        }
      }
      return new Response(JSON.stringify({ probes }, null, 2), { headers: jsonHeaders });
    }

    const sinceHours = Number(opts.since_hours || 24);
    const sinceMs = Date.now() - sinceHours * 3600_000;
    const dryRun = Boolean(opts.dry_run);

    let targets: string[] = Array.isArray(opts.phones) ? opts.phones.map(digitsOf).filter(Boolean) : [];

    // Wasender exposes no inbound chat/message listing endpoint (only outgoing
    // message-logs), and the missed messages never reached our DB because the
    // function crashed at boot — so the phone list must be supplied explicitly.
    targets = Array.from(new Set(targets));
    if (targets.length === 0) {
      return new Response(JSON.stringify({
        error: "no phones supplied",
        hint: "POST { phones: [\"9477...\", ...], dry_run: true } — provider has no inbound chat list API",
      }), { status: 400, headers: jsonHeaders });
    }

    // Never nudge a chat we already answered after their last inbound message.
    const skipped: string[] = [];
    const finalTargets: string[] = [];
    for (const phone of targets) {
      const { data: lastIn } = await supabase
        .from("chat_messages").select("created_at")
        .eq("phone_number", phone).eq("direction", "incoming")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const { data: lastOut } = await supabase
        .from("chat_messages").select("created_at, message_text")
        .eq("phone_number", phone).eq("direction", "outgoing")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();

      const inAt = lastIn?.created_at ? new Date(lastIn.created_at).getTime() : 0;
      const outAt = lastOut?.created_at ? new Date(lastOut.created_at).getTime() : 0;
      // Already replied after their last logged inbound AND that reply is recent -> skip.
      if (outAt && inAt && outAt > inAt && outAt > sinceMs) { skipped.push(phone); continue; }
      // Already sent this exact recovery note -> skip.
      if (lastOut?.message_text && String(lastOut.message_text).includes("තාවකාලික බාධාවක්")) {
        skipped.push(phone);
        continue;
      }
      finalTargets.push(phone);
    }

    if (dryRun) {
      return new Response(JSON.stringify({ dry_run: true, count: finalTargets.length, targets: finalTargets, skipped }), { headers: jsonHeaders });
    }

    const sent: string[] = [];
    const failed: any[] = [];
    for (const phone of finalTargets) {
      const r = await sendWhatsAppText(supabase, phone, RECOVERY_MESSAGE);
      if (r.sent) {
        sent.push(phone);
        await supabase.from("chat_messages").insert({
          phone_number: phone,
          direction: "outgoing",
          message_text: RECOVERY_MESSAGE,
          metadata: { type: "outage_recovery" },
        });
      } else {
        failed.push({ phone, error: r.error });
      }
      await sleep(6000);
    }

    return new Response(JSON.stringify({ ok: true, sent: sent.length, sent_to: sent, failed, skipped }), { headers: jsonHeaders });
  } catch (e) {
    console.error("recover-missed-chats error", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: jsonHeaders });
  }
}
