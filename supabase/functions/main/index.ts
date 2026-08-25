import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

import adminListingAction from "../admin-listing-action/index.ts";
import deleteListing from "../delete-listing/index.ts";
import notifyAdminsPayment from "../notify-admins-payment/index.ts";
import notifyBuyers from "../notify-buyers/index.ts";
import onepayCallback from "../onepay-callback/index.ts";
import onepayCreatePayment from "../onepay-create-payment/index.ts";
import pushNotionAnalytics from "../push-notion-analytics/index.ts";
import reconcileOnepayPending from "../reconcile-onepay-pending/index.ts";
import recoverMissedChats from "../recover-missed-chats/index.ts";
import sellerDashboardData from "../seller-dashboard-data/index.ts";
import sendPaymentFollowups from "../send-payment-followups/index.ts";
import sendReferralBroadcast from "../send-referral-broadcast/index.ts";
import sendRevenueReport from "../send-revenue-report/index.ts";
import sendSellerOtp from "../send-seller-otp/index.ts";
import testVpsUpload from "../test-vps-upload/index.ts";
import validateSellerSession from "../validate-seller-session/index.ts";
import verifySellerOtp from "../verify-seller-otp/index.ts";
import wahaControl from "../waha-control/index.ts";
import wahaDiag from "../waha-diag/index.ts";
import wahaHealth from "../waha-health/index.ts";
import wahaWebhook from "../waha-webhook/index.ts";
import wasenderHealth from "../wasender-health/index.ts";
import wasenderSessions from "../wasender-sessions/index.ts";
import wasenderWebhook from "../wasender-webhook/index.ts";


const routes: Record<string, any> = {
  "admin-listing-action": adminListingAction,
  "delete-listing": deleteListing,
  "notify-admins-payment": notifyAdminsPayment,
  "notify-buyers": notifyBuyers,
  "onepay-callback": onepayCallback,
  "onepay-create-payment": onepayCreatePayment,
  "push-notion-analytics": pushNotionAnalytics,
  "reconcile-onepay-pending": reconcileOnepayPending,
  "recover-missed-chats": recoverMissedChats,
  "seller-dashboard-data": sellerDashboardData,
  "send-payment-followups": sendPaymentFollowups,
  "send-referral-broadcast": sendReferralBroadcast,
  "send-revenue-report": sendRevenueReport,
  "send-seller-otp": sendSellerOtp,
  "test-vps-upload": testVpsUpload,
  "validate-seller-session": validateSellerSession,
  "verify-seller-otp": verifySellerOtp,
  "waha-control": wahaControl,
  "waha-diag": wahaDiag,
  "waha-health": wahaHealth,
  "waha-webhook": wahaWebhook,
  "wasender-health": wasenderHealth,
  "wasender-sessions": wasenderSessions,
  "wasender-webhook": wasenderWebhook,
};


serve(async (req) => {
  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  
  const functionName = pathParts[1] === 'functions' && pathParts[2] === 'v1' 
    ? pathParts[3]
    : pathParts[1];

  if (!functionName || functionName === '') {
    return new Response("Function not found", { status: 404 });
  }

  const handler = routes[functionName];

  if (!handler) {
    return new Response("Function not found in routes", { status: 404 });
  }

  if (typeof handler !== 'function') {
    return new Response(`Function ${functionName} does not export a default handler`, { status: 500 });
  }

  try {
    return await handler(req);
  } catch (error) {
    console.error(`Error executing function ${functionName}:`, error);
    return new Response(error.message || "Internal error", { status: 500 });
  }
});
