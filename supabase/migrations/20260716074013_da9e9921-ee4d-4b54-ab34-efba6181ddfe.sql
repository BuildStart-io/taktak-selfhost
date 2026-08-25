
-- Delivery log for seller OTPs (diagnostics + auditing)
CREATE TABLE public.seller_otp_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  otp_id UUID REFERENCES public.seller_otps(id) ON DELETE SET NULL,
  provider TEXT,           -- 'waha' | 'wasender'
  chat_id TEXT,            -- e.g. 94XXXXXXXXX@c.us or @lid
  status TEXT NOT NULL,    -- 'sent' | 'failed'
  http_status INT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.seller_otp_log TO service_role;

ALTER TABLE public.seller_otp_log ENABLE ROW LEVEL SECURITY;

-- Only service role reads/writes this table (edge functions). No client access.
CREATE POLICY "No client access to seller_otp_log"
  ON public.seller_otp_log FOR SELECT
  USING (false);

CREATE INDEX idx_seller_otp_log_phone ON public.seller_otp_log(phone_number, created_at DESC);
