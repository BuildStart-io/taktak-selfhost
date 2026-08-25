#!/usr/bin/env bash
# Mirror listing images still hosted on Lovable Cloud Storage into your MinIO
# bucket, then rewrite the URLs in the self-hosted database.
#
#   OLD_STORAGE_BASE : public base URL of the Lovable Cloud storage bucket
#   S3_PUBLIC_URL    : public base URL of your MinIO bucket
#
# Requires: mc (MinIO client) configured as alias `local`, curl, jq, psql.
set -euo pipefail

: "${OLD_STORAGE_BASE:?set OLD_STORAGE_BASE}"
: "${S3_PUBLIC_URL:?set S3_PUBLIC_URL}"
: "${S3_BUCKET:=listing-images}"
PSQL="${PSQL:-docker compose -f /opt/supabase/docker-compose.yml exec -T db psql -U postgres -d postgres}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> Collecting image URLs still pointing at $OLD_STORAGE_BASE"
$PSQL -At -c "
  select distinct unnest(images)
  from public.listings
  where array_to_string(images, ',') like '%${OLD_STORAGE_BASE}%'
" > "$TMP/urls.txt"

COUNT=$(wc -l < "$TMP/urls.txt" | tr -d ' ')
echo "    $COUNT object(s) to mirror"

while read -r url; do
  [ -z "$url" ] && continue
  key="${url#"$OLD_STORAGE_BASE"/}"
  key="${key#/}"
  out="$TMP/$(basename "$key")"
  if curl -fsSL "$url" -o "$out"; then
    mc cp --quiet "$out" "local/$S3_BUCKET/$key" >/dev/null
    echo "  ok  $key"
  else
    echo "  FAIL $key" >&2
  fi
done < "$TMP/urls.txt"

echo "==> Rewriting URLs in the database"
$PSQL -v ON_ERROR_STOP=1 -c "
  update public.listings
  set images = (
    select array_agg(replace(i, '${OLD_STORAGE_BASE}', '${S3_PUBLIC_URL}'))
    from unnest(images) i
  )
  where array_to_string(images, ',') like '%${OLD_STORAGE_BASE}%';
"
echo "==> Done."
