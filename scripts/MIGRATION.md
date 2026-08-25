# Migrating data from Lovable Cloud → self-hosted

The Lovable Cloud database is **never modified** by this process. It keeps
serving live WhatsApp traffic exactly as it does today; you are taking a
read-only copy.

## Step 1 — export from Lovable Cloud

In the Lovable editor: **Cloud → Advanced settings → Export data**.

That produces a full export of the `public` schema. Download it and place the
files in `scripts/export/`.

> Exporting is only available from that screen — there is no import there, and
> dumps cannot be taken from chat.

## Step 2 — apply the schema on the self-hosted side first

```bash
cd /opt/supabase
for f in ../taktak-selfhost/supabase/migrations/*.sql; do
  docker compose exec -T db psql -U postgres -d postgres -f - < "$f"
done
```

Do this **before** importing data — the export carries rows, the migrations
carry the tables, enums, RLS policies, grants and triggers.

## Step 3 — import

```bash
./scripts/import-data.sh scripts/export
```

The script imports in foreign-key-safe order:

```
marketplace_users → listings → payments → leads → buyer_alerts
→ chat_messages → search_history → notification_log → revenue
→ referrals → referral_rewards → referral_payouts → referral_broadcast_log
→ seller_otps → seller_sessions → seller_otp_log → bot_settings → waha_sessions
```

Triggers are disabled during the load (`session_replication_role = replica`)
so `updated_at` triggers don't rewrite historical timestamps, then re-enabled.

## Step 4 — verify

```bash
./scripts/verify-migration.sh
```

Prints row counts per table. Compare them against the counts shown in the
Lovable Cloud table view. They must match exactly before you consider the
migration done.

## Step 5 — storage / images

Listing images live in two places:

1. **MinIO / VPS S3** (`S3_BUCKET`) — already yours. Nothing to migrate; just
   point `S3_ENDPOINT` at the same bucket.
2. **Supabase Storage bucket `listing-images`** on Lovable Cloud — older
   images. Mirror them:

```bash
./scripts/mirror-storage.sh
```

It reads the public URLs out of `listings.images` and re-uploads anything
still hosted on Lovable Cloud into your MinIO bucket, then rewrites the URLs
in the self-hosted database. Run it only against the self-hosted DB.

## Important: divergence

The moment you point WhatsApp webhooks at the self-hosted stack, the two
databases start diverging. There is no supported two-way sync. Recommended
sequence:

1. Migrate + verify (traffic still on Lovable) ← *you are here*
2. Test the self-hosted stack with a second WhatsApp number
3. Re-run the import with a fresh export right before cutover
4. Flip the webhooks, disable the Lovable cron jobs
5. Keep Lovable Cloud as a frozen read-only backup
