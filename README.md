# TakTak — Self-Hosted Bundle

Everything runs on your own infrastructure. The **only** remaining dependency on
Lovable is the AI Gateway, reached through a small `ai-proxy` edge function
that stays hosted on Lovable and is authenticated with your own `BOT_API_KEY`
(see `AI-GATEWAY.md`). No database, no storage, no
client code depends on Lovable.

```
Browser (Vite app)  ──►  Your Supabase (Kong / PostgREST / Realtime / Storage)
                          │
                          ├── Edge Functions (Deno)  ──►  Lovable AI Gateway  (AI only)
                          │                          ──►  WAHA / Wasender     (WhatsApp)
                          │                          ──►  MinIO (S3)          (images)
                          │                          ──►  OnePay              (payments)
                          └── Postgres + pg_cron      (schedules)
```

## Contents

| Path | What it is |
|---|---|
| `frontend/` | The full Vite + React admin & seller dashboard |
| `supabase/functions/` | All 25 edge functions + `_shared/` helpers |
| `supabase/migrations/` | Complete schema history: tables, enums, RLS, grants, triggers |
| `supabase/config.toml` | Per-function `verify_jwt` settings |
| `infra/` | Docker compose for WAHA + MinIO, and Supabase setup notes |
| `scripts/` | Data import + verification scripts |
| `.env.example` | Every secret the system needs |
| `AI-GATEWAY.md` | How the stack reaches Lovable AI via `ai-proxy` + `BOT_API_KEY` |

---

## 1. Bring up Supabase

This bundle does **not** vendor the Supabase stack itself — use the official one
so you stay on supported images.

```bash
git clone --depth 1 https://github.com/supabase/supabase /opt/supabase-src
cp -r /opt/supabase-src/docker /opt/supabase
cd /opt/supabase
cp .env.example .env      # set POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY
docker compose up -d
```

Then create the shared docker network the rest of the stack joins:

```bash
docker network create taktak || true
docker network connect taktak supabase-kong
docker network connect taktak supabase-db
```

## 2. Bring up WAHA + MinIO

```bash
cd infra
cp ../.env.example ../.env    # fill it in first
docker compose up -d
```

MinIO console: `http://<vps>:9001`. Create the bucket named in `S3_BUCKET`
(default `listing-images`) and set it to public-read for downloads.

## 3. Apply the schema

```bash
cd /opt/supabase
for f in /path/to/taktak-selfhost/supabase/migrations/*.sql; do
  docker compose exec -T db psql -U postgres -d postgres -f - < "$f"
done
```

Migrations are ordered by filename and are the exact history from production,
so applying them in order reproduces the schema byte-for-byte.

Then create the storage bucket row:

```sql
insert into storage.buckets (id, name, public) values ('listing-images','listing-images', true)
on conflict (id) do nothing;
```

## 4. Deploy the edge functions

```bash
cd /path/to/taktak-selfhost
supabase functions deploy --project-ref <your-ref>     # hosted CLI
# or, for the self-hosted edge runtime:
docker compose -f /opt/supabase/docker-compose.yml restart functions
```

For self-hosted Supabase, mount `supabase/functions/` into the
`supabase-edge-functions` container at `/home/deno/functions` and restart it.
`infra/docker-compose.functions.yml` does exactly that.

Set every secret from `.env.example` on the functions container environment.
`SUPABASE_URL` **must** be the internal Kong URL (`http://kong:8000`) so
functions reach the DB without leaving the docker network.

## 5. Schedules (pg_cron)

```bash
docker compose exec -T db psql -U postgres -d postgres -f - < scripts/cron.sql
```

Edit the `base_url` and `service_key` at the top of that file first.

## 6. Frontend

```bash
cd frontend
cp .env.example .env      # VITE_SUPABASE_URL = your public Kong URL
npm install
npm run dev               # http://localhost:8080
npm run build             # dist/ — serve with nginx/caddy
```

The frontend talks only to your Supabase. Every `supabase.functions.invoke(...)`
call automatically resolves to `<VITE_SUPABASE_URL>/functions/v1/<name>`, so
nothing in the app code needs to change.

## 7. Webhooks

Point WhatsApp at your own domain:

- WAHA: `https://<your-domain>/functions/v1/waha-webhook`
- Wasender: `https://<your-domain>/functions/v1/wasender-webhook`

The `wasender-health` function re-registers the Wasender webhook every 10
minutes; make sure its `base_url` in `cron.sql` points at your domain, not
Lovable's.

---

## Data migration from Lovable Cloud

See `scripts/MIGRATION.md`. The export is taken from the Lovable dashboard
(Cloud → Advanced settings → Export data) and imported here with
`scripts/import-data.sh`. The Lovable Cloud database is **not** modified — it
keeps running exactly as it does today.

## What is NOT in this bundle

- Supabase's own docker images (pull the official stack, step 1)
- Your secrets (`.env` is yours to fill)
- Auth users for the admin dashboard — create your first admin with
  `scripts/create-admin.sql` after signing up through the app
