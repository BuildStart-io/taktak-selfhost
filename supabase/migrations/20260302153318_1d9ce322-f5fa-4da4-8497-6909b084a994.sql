
-- Seller OTPs for WhatsApp-based authentication
CREATE TABLE public.seller_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number text NOT NULL,
  otp_code text NOT NULL,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used boolean DEFAULT false
);

ALTER TABLE public.seller_otps ENABLE ROW LEVEL SECURITY;

-- No direct public access - only edge functions with service role can access
CREATE POLICY "No direct access to otps" ON public.seller_otps FOR SELECT USING (false);

-- Seller sessions for persistent login
CREATE TABLE public.seller_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number text NOT NULL,
  session_token text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '30 days'),
  is_active boolean DEFAULT true
);

ALTER TABLE public.seller_sessions ENABLE ROW LEVEL SECURITY;

-- No direct public access - only edge functions with service role can access
CREATE POLICY "No direct access to sessions" ON public.seller_sessions FOR SELECT USING (false);

-- Index for fast lookups
CREATE INDEX idx_seller_otps_phone ON public.seller_otps(phone_number, used, expires_at);
CREATE INDEX idx_seller_sessions_token ON public.seller_sessions(session_token, is_active);
CREATE INDEX idx_seller_sessions_phone ON public.seller_sessions(phone_number, is_active);
