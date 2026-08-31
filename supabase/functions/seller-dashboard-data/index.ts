import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ensureReferralCode, getReferralConfig, referralLink } from "../_shared/referral.ts";

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
    const { session_token, action, listing_id, payout_account } = await req.json();
    if (!session_token) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    // Validate session
    const { data: session } = await supabase
      .from("seller_sessions")
      .select("phone_number")
      .eq("session_token", session_token)
      .eq("is_active", true)
      .gte("expires_at", new Date().toISOString())
      .single();

    if (!session) {
      return jsonResponse({ error: "Session expired" }, 401);
    }

    // Handle mark-as-sold action
    if (action === "mark_sold" && listing_id) {
      // Verify the listing belongs to this seller
      const { data: sellerUser } = await supabase
        .from("marketplace_users")
        .select("id")
        .eq("phone_number", session.phone_number)
        .single();

      if (!sellerUser) return jsonResponse({ error: "User not found" }, 404);

      const { error: updateErr } = await supabase
        .from("listings")
        .update({ status: "sold" })
        .eq("id", listing_id)
        .eq("seller_id", sellerUser.id);

      if (updateErr) return jsonResponse({ error: updateErr.message }, 400);
      return jsonResponse({ success: true, status: "sold" });
    }

    // Get seller user
    const { data: user } = await supabase
      .from("marketplace_users")
      .select("id, display_name, phone_number, created_at, referral_code, payout_account")
      .eq("phone_number", session.phone_number)
      .single();

    if (!user) {
      return jsonResponse({ error: "User not found" }, 404);
    }

    const refCfg = await getReferralConfig(supabase);

    // ─── Referral actions ───
    if (action === "save_payout_account") {
      const acct = (payout_account || {}) as any;
      const clean = {
        bank_name: String(acct.bank_name || "").trim().slice(0, 80),
        account_name: String(acct.account_name || "").trim().slice(0, 120),
        account_number: String(acct.account_number || "").replace(/[^0-9A-Za-z-]/g, "").slice(0, 40),
        branch: String(acct.branch || "").trim().slice(0, 80),
      };
      if (!clean.bank_name || !clean.account_name || !clean.account_number) {
        return jsonResponse({ error: "Bank name, account name and account number are required" }, 400);
      }
      const { error } = await supabase
        .from("marketplace_users")
        .update({ payout_account: clean })
        .eq("id", user.id);
      if (error) return jsonResponse({ error: error.message }, 400);
      return jsonResponse({ success: true, payout_account: clean });
    }

    if (action === "request_redeem") {
      const { data: rewards } = await supabase
        .from("referral_rewards")
        .select("amount")
        .eq("referrer_id", user.id);
      const earned = (rewards || []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      const { data: payouts } = await supabase
        .from("referral_payouts")
        .select("amount, status")
        .eq("user_id", user.id);
      const locked = (payouts || [])
        .filter((p: any) => p.status !== "rejected")
        .reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
      const available = earned - locked;

      if (available < refCfg.min_redeem) {
        return jsonResponse({ error: `Minimum redeem amount is LKR ${refCfg.min_redeem}` }, 400);
      }
      const acct = (user.payout_account || {}) as any;
      if (!acct.account_number) {
        return jsonResponse({ error: "Please save your bank account details first" }, 400);
      }
      const { error } = await supabase.from("referral_payouts").insert({
        user_id: user.id,
        amount: available,
        status: "pending",
        account_snapshot: acct,
      });
      if (error) return jsonResponse({ error: error.message }, 400);
      return jsonResponse({ success: true, requested: available });
    }

    // Get all listings for this seller
    const { data: listings } = await supabase
      .from("listings")
      .select("id, title, price, city, district, condition, status, category, images, views_count, match_count, created_at, additional_details, expires_at, is_boosted, boost_expires_at")
      .eq("seller_id", user.id)
      .order("created_at", { ascending: false });

    // Get leads (inquiries) count per listing - but DON'T expose buyer info
    const listingIds = (listings || []).map(l => l.id);
    let leadCounts: Record<string, number> = {};
    if (listingIds.length > 0) {
      const { data: leads } = await supabase
        .from("leads")
        .select("listing_id")
        .in("listing_id", listingIds);

      for (const lead of leads || []) {
        if (lead.listing_id) {
          leadCounts[lead.listing_id] = (leadCounts[lead.listing_id] || 0) + 1;
        }
      }
    }

    // Generate suggested best times based on search patterns
    const suggestedTimes = generateSuggestedTimes();

    // Analytics: views over time (last 7 days)
    const totalViews = (listings || []).reduce((sum, l) => sum + (l.views_count || 0), 0);
    const totalMatches = (listings || []).reduce((sum, l) => sum + (l.match_count || 0), 0);
    const activeListings = (listings || []).filter(l => l.status === "active").length;
    const soldListings = (listings || []).filter(l => l.status === "sold").length;

    // ─── Referral summary ───
    const referralCode = user.referral_code || (await ensureReferralCode(supabase, user.id));
    const { data: refRows } = await supabase
      .from("referrals")
      .select("id, created_at")
      .eq("referrer_id", user.id);
    const { data: rewardRows } = await supabase
      .from("referral_rewards")
      .select("id, reward_type, amount, description, created_at")
      .eq("referrer_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);
    const { data: payoutRows } = await supabase
      .from("referral_payouts")
      .select("id, amount, status, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    const earnedTotal = (rewardRows || []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
    const lockedTotal = (payoutRows || [])
      .filter((p: any) => p.status !== "rejected")
      .reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
    const paidTotal = (payoutRows || [])
      .filter((p: any) => p.status === "paid")
      .reduce((s: number, p: any) => s + Number(p.amount || 0), 0);

    return jsonResponse({
      seller: {
        display_name: user.display_name,
        member_since: user.created_at,
      },
      referral: {
        enabled: refCfg.enabled,
        code: referralCode,
        link: referralCode ? referralLink(referralCode, refCfg.bot_number) : null,
        seller_percent: refCfg.seller_percent,
        buyer_reward: refCfg.buyer_reward,
        min_redeem: refCfg.min_redeem,
        total_referred: (refRows || []).length,
        earned_total: earnedTotal,
        available: earnedTotal - lockedTotal,
        paid_total: paidTotal,
        payout_account: user.payout_account || {},
        rewards: rewardRows || [],
        payouts: payoutRows || [],
      },
      listings: (listings || []).map(l => ({
        ...l,
        inquiry_count: leadCounts[l.id] || 0,
        suggested_time: suggestedTimes,
      })),
      analytics: {
        total_listings: (listings || []).length,
        active_listings: activeListings,
        sold_listings: soldListings,
        total_views: totalViews,
        total_matches: totalMatches,
        total_inquiries: Object.values(leadCounts).reduce((s, c) => s + c, 0),
      },
    });
  } catch (error) {
    console.error("Dashboard data error:", error);
    return jsonResponse({ error: error.message }, 500);
  }
}

function generateSuggestedTimes() {
  return {
    best_days: ["Saturday", "Sunday", "Friday"],
    best_hours: ["9:00 AM - 11:00 AM", "7:00 PM - 9:00 PM"],
    tip: "Most buyers search during weekends and evenings. Consider refreshing your listings during these times for maximum visibility.",
  };
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
