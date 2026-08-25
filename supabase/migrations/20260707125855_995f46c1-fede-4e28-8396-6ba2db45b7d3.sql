ALTER TABLE public.marketplace_users
ADD COLUMN IF NOT EXISTS bot_state JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.marketplace_users.bot_state IS 'Ephemeral per-user WhatsApp bot state. Shape: { mode: "selling"|"buying"|"idle", collecting: string[], last_question: string|null, pending_listing_id: uuid|null, updated_at: timestamp }';