#!/usr/bin/env bash
# Print row counts for every TakTak table on the self-hosted database.
set -euo pipefail
PSQL="${PSQL:-docker compose -f /opt/supabase/docker-compose.yml exec -T db psql -U postgres -d postgres}"

$PSQL -c "
select relname as table, n_live_tup as approx_rows
from pg_stat_user_tables
where schemaname = 'public'
order by relname;
"

$PSQL -c "
select 'listings'  as t, count(*) from public.listings
union all select 'marketplace_users', count(*) from public.marketplace_users
union all select 'chat_messages',     count(*) from public.chat_messages
union all select 'payments',          count(*) from public.payments
union all select 'revenue',           count(*) from public.revenue
union all select 'referrals',         count(*) from public.referrals
order by 1;
"
