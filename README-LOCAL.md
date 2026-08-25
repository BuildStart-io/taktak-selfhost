# TakTak Local Development Guide

This guide describes how to run the TakTak WhatsApp AI marketplace locally using Docker Compose, without relying on any VPS or remote services (except Lovable AI Gateway for inference).

## Prerequisites

- Docker and Docker Compose (v2+)
- Node.js (v18+)

## 1. Initial Setup

The `.env` file has already been generated with secure, local JWT keys and necessary Supabase environment variables. 
The keys were generated using Node's `crypto` module to create HS256 JWTs with a 32-byte hexadecimal secret. 
If you need to regenerate the keys manually, you can run the following commands:
```bash
# Generate a new 32-byte hex secret
openssl rand -hex 32

# In a Node.js shell, generate an HS256 JWT for 'anon' and 'service_role' using that secret:
node -e "
const crypto = require('crypto');
const secret = '<YOUR_HEX_SECRET>';
const payload = (role) => Buffer.from(JSON.stringify({role, iss: 'supabase', iat: Math.floor(Date.now()/1000), exp: 1799535600})).toString('base64url');
const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const sign = (role) => crypto.createHmac('sha256', secret).update(header + '.' + payload(role)).digest('base64url');
console.log('ANON_KEY=', header + '.' + payload('anon') + '.' + sign('anon'));
console.log('SERVICE_ROLE_KEY=', header + '.' + payload('service_role') + '.' + sign('service_role'));
"
```

### Action Required
Before starting, open `.env` and fill in the missing `<<FILL ME>>` values for your WhatsApp providers (`WASENDER_API_TOKEN`, etc.), OnePay, and live `S3_ACCESS_KEY` / `S3_SECRET_KEY` (if you intend to pull from your live MinIO bucket).

## 2. Start the Infrastructure

The infrastructure combines the official Supabase stack, WAHA, and the Deno Edge Functions into a single `docker-compose.yml` file.

```bash
cd infra
docker compose up -d
```

### Published Ports

| Service | Port | Local URL |
|---|---|---|
| Supabase API Gateway (PostgREST, Auth, Storage) | `8000` | `http://localhost:8000` |
| Supabase Studio | `3000` | `http://localhost:3000` |
| PostgreSQL Database | `5432` | `postgresql://postgres:postgres@localhost:5432/postgres` |
| WAHA (WhatsApp HTTP API) | `3001` | `http://localhost:3001` |
| Edge Functions (Deno) | `9998` | `http://localhost:9998/functions/v1/...` |

*(Note: MinIO has been removed from the local stack. Local S3 uploads will go to the local Supabase Storage API at `http://localhost:8000/storage/v1/s3` to keep your live MinIO untouched while staying byte-compatible.)*

## 3. Database Migrations and pg_cron

Once the database is healthy (check `docker compose logs -f db`), apply the migrations:

```bash
# Since the DB is on localhost:5432, you can use local psql or docker exec
docker compose exec -T db psql -U postgres -d postgres -f /docker-entrypoint-initdb.d/migrate.sql
# Or point it directly to the migrations folder:
for f in ../supabase/migrations/*.sql; do
  docker compose exec -T db psql -U postgres -d postgres -f - < "$f"
done
```

Then register the pg_cron jobs using the updated local URLs:
```bash
docker compose exec -T db psql -U postgres -d postgres -f - < ../scripts/cron.sql
```

## 4. Run the Frontend

The frontend `.env` is already configured to point to `http://localhost:8000`.
```bash
cd frontend
npm install
npm run dev
```

## Useful Commands

- **Logs:** `docker compose logs -f [service_name]` (e.g. `docker compose logs -f functions`)
- **Stop:** `docker compose down`
- **Reset Everything (Destroy Data):** `docker compose down -v`

## Troubleshooting

- **Containers failing to start:** Ensure you don't have existing services bound to ports `8000`, `3000`, `5432`, `3001`, or `9998`.
- **Edge Functions Error (`Connection Refused`):** Verify that the functions container can reach `api-gw:8000`. The internal `.env` `SUPABASE_URL` is set correctly.
- **S3 Uploads Failing:** Verify that your `S3_ACCESS_KEY` and `S3_SECRET_KEY` match the `S3_PROTOCOL_ACCESS_KEY_ID` and `S3_PROTOCOL_ACCESS_KEY_SECRET` in `docker-compose.yml` (these are automatically passed from `.env`).

## Moving to VPS Later

When moving this to a live VPS:
1. Re-enable MinIO or switch completely to the Supabase Storage bucket.
2. Change `VITE_SUPABASE_URL` and `PUBLIC_SUPABASE_URL` to your real domain (e.g., `https://api.yourdomain.com`).
3. Setup a reverse proxy (Kong, Nginx, or Caddy) to terminate TLS for the API gateway and Studio.
4. Replace all generated `.env` secrets with new ones, and do **not** use the default `postgres` password.
