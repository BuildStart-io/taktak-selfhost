#!/usr/bin/env bash
# Import a Lovable Cloud export into the self-hosted Postgres.
# Usage: ./scripts/import-data.sh <export-dir>
#
# Accepts either per-table CSV files (<table>.csv) or a single .sql dump.
set -euo pipefail

DIR="${1:-scripts/export}"
PSQL="${PSQL:-docker compose -f /opt/supabase/docker-compose.yml exec -T db psql -U postgres -d postgres}"

TABLES=(
  marketplace_users
  listings
  payments
  leads
  buyer_alerts
  chat_messages
  search_history
  notification_log
  revenue
  referrals
  referral_rewards
  referral_payouts
  referral_broadcast_log
  seller_otps
  seller_sessions
  seller_otp_log
  bot_settings
  waha_sessions
)

if [ ! -d "$DIR" ]; then
  echo "Export directory '$DIR' not found." >&2
  exit 1
fi

# Single SQL dump path
DUMP=$(ls "$DIR"/*.sql 2>/dev/null | head -1 || true)
if [ -n "$DUMP" ]; then
  echo "==> Importing SQL dump: $DUMP"
  $PSQL -v ON_ERROR_STOP=1 <<SQL
set session_replication_role = replica;
\i /dev/stdin
set session_replication_role = origin;
SQL
  exit 0
fi

echo "==> Importing CSVs from $DIR (triggers disabled)"
$PSQL -c "set session_replication_role = replica;" >/dev/null

for t in "${TABLES[@]}"; do
  f="$DIR/$t.csv"
  if [ ! -f "$f" ]; then
    echo "  -- skip $t (no $t.csv)"
    continue
  fi
  echo "  -> $t"
  $PSQL -v ON_ERROR_STOP=1 -c "\copy public.$t from stdin with (format csv, header true)" < "$f"
done

$PSQL -c "set session_replication_role = origin;" >/dev/null
echo "==> Done. Run ./scripts/verify-migration.sh"
