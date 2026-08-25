# How the self-hosted stack reaches Lovable AI

## The constraint

`LOVABLE_API_KEY` is provisioned and managed by Lovable, tied to your workspace
billing, and **its value is never revealed** — not in the dashboard, not in
chat, not via any tool. You cannot copy it into a self-hosted `.env`.

There is also no way to mint a second Lovable AI key: one key per project.

## The solution — `ai-proxy`

One small edge function stays hosted on Lovable. It is the *only* thing left
running there.

```
self-hosted function
   │  POST https://<lovable-project>/functions/v1/ai-proxy/chat/completions
   │  Authorization: Bearer <BOT_API_KEY>
   ▼
ai-proxy   (on Lovable — holds LOVABLE_API_KEY)
   │  POST https://ai.gateway.lovable.dev/v1/chat/completions
   │  Authorization: Bearer <LOVABLE_API_KEY>
   ▼
Lovable AI Gateway
```

`BOT_API_KEY` is **your** key. You choose the value, you store it as a Lovable
secret, and you put the same value in your self-hosted `.env`. Rotating it is a
two-line change on both sides. If it ever leaks, rotate it — your Lovable AI
key is untouched.

## Why the app code didn't have to change

`ai-proxy` accepts the same `Authorization: Bearer ...` header shape and the
same OpenAI-compatible request body the functions already send. So in the
bundle, every gateway call was rewritten from a hardcoded URL to:

```ts
fetch((Deno.env.get("AI_GATEWAY_URL") || "https://ai.gateway.lovable.dev/v1") + "/chat/completions", ...)
```

Nothing else changed — same models, same prompts, same parsing. All 7 call
sites are covered:

| Function | Call site | Purpose |
|---|---|---|
| `wasender-webhook` | 1988 | main conversational reply |
| `wasender-webhook` | 2367 | listing detail extraction |
| `wasender-webhook` | 2437 | non-search intent classification |
| `wasender-webhook` | 2517 | buyer alert parsing |
| `wasender-webhook` | 3074 | bank slip vision extraction |
| `wasender-webhook` | 3339 | slip reference normalisation |
| `send-payment-followups` | 806 | follow-up personalisation |

Leave `AI_GATEWAY_URL` unset and the functions call the gateway directly —
useful if you ever move off the proxy to your own provider key.

## Configuration

**On Lovable** (already set up):
- `ai-proxy` deployed at `/functions/v1/ai-proxy`
- secrets: `LOVABLE_API_KEY` (managed), `BOT_API_KEY` (yours)

**On your VPS** (`.env`):
```
AI_GATEWAY_URL=https://<your-lovable-project>.supabase.co/functions/v1/ai-proxy
LOVABLE_API_KEY=<the same BOT_API_KEY value>
```

Yes, the variable is still named `LOVABLE_API_KEY` on your side — that's
deliberate, so not a single line of the 9,300 lines of function code needed
editing. It holds your `BOT_API_KEY`, and the real Lovable key never leaves
Lovable.

## What the proxy allows

Only these gateway paths: `/chat/completions`, `/embeddings`,
`/images/generations`, `/images/edits`. Anything else returns 400.

Gateway errors pass straight through with their real status codes, so your
existing handling still works:

- `402` — workspace out of AI credits (add credits in Lovable)
- `429` — rate limited, `Retry-After` is forwarded
- `400` — bad request (model name, payload size)
- `401` from the proxy itself — wrong `BOT_API_KEY`

## Test it

```bash
curl -sS -X POST \
  "https://<your-lovable-project>.supabase.co/functions/v1/ai-proxy/chat/completions" \
  -H "Authorization: Bearer $BOT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"google/gemini-2.5-flash-lite","messages":[{"role":"user","content":"say ok"}]}'
```

A `200` with a completion means the whole AI path is wired correctly.

## Not covered by the proxy

`push-notion-analytics` uses Lovable's **connector** gateway (a different
service that also authenticates with `LOVABLE_API_KEY`), not the AI gateway.
Self-hosted, replace it with a direct Notion integration token — set
`NOTION_TOKEN` and `NOTION_DATABASE_ID` and point the fetch at
`https://api.notion.com/v1/pages`. It is an optional analytics job; the bot
does not depend on it.
