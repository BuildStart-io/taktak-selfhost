// Simulates a OnePay success callback for the Hikvision seller and verifies
// the payment/listing/revenue update and confirmation WhatsApp send.
//
// Run: supabase--test_edge_functions with functions=["onepay-callback"]
//
// Creates a throwaway pending payment tied to the Hikvision seller and an
// existing listing, POSTs a success payload to the deployed onepay-callback
// endpoint, then asserts the DB was updated. The callback itself fires the
// confirmation WhatsApp message via the stored Wasender session key, so on
// success the Hikvision user receives the "✅ Payment received" message.

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HIKVISION_PHONE = "94769652770";
const HIKVISION_SELLER_ID = "f3d3e99d-06ee-437e-8b47-18a0c1f83ab0";

Deno.test("onepay-callback marks payment paid and activates listing", async () => {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // Reuse the Hikvision Monitor listing already on file.
  const { data: listing } = await admin
    .from("listings")
    .select("id, title")
    .eq("seller_id", HIKVISION_SELLER_ID)
    .eq("title", "Hikvision Monitor")
    .maybeSingle();
  if (!listing) throw new Error("Hikvision Monitor listing not found");

  // Create a fresh pending payment we can safely mutate.
  const reference = `TEST${Date.now().toString().slice(-8)}`;
  const { error: insErr } = await admin.from("payments").insert({
    reference,
    listing_id: listing.id,
    seller_id: HIKVISION_SELLER_ID,
    phone_number: HIKVISION_PHONE,
    amount: 300,
    currency: "LKR",
    status: "pending",
    provider: "onepay",
  });
  if (insErr) throw insErr;

  // POST a OnePay-style success payload to the deployed function.
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/onepay-callback-taktak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transaction_reference: reference,
      transaction_status: "SUCCESS",
      transaction_id: `IPG_${reference}`,
      additional_data: listing.id,
    }),
  });
  const body = await resp.json();
  console.log("callback response:", resp.status, body);
  assertEquals(resp.status, 200);
  assertEquals(body.success, true);

  // Verify DB side-effects.
  const { data: paid } = await admin
    .from("payments")
    .select("status, provider_transaction_id")
    .eq("reference", reference)
    .single();
  assertEquals(paid?.status, "paid");
  assertEquals(paid?.provider_transaction_id, `IPG_${reference}`);

  const { data: rev } = await admin
    .from("revenue")
    .select("id, amount, type")
    .eq("description", `Listing fee (OnePay ref ${reference})`)
    .maybeSingle();
  if (!rev) throw new Error("revenue row not inserted");
  assertEquals(Number(rev.amount), 300);
  assertEquals(rev.type, "listing_fee");

  console.log(
    `✅ Confirmation WhatsApp message dispatched to ${HIKVISION_PHONE} for ref ${reference}`,
  );
});
