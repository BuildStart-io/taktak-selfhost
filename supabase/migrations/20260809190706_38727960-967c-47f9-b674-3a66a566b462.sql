CREATE TABLE IF NOT EXISTS public.referral_broadcast_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.marketplace_users(id) ON DELETE CASCADE,
  phone_number text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'sent',
  error text,
  sent_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.referral_broadcast_log TO authenticated;
GRANT ALL ON public.referral_broadcast_log TO service_role;
ALTER TABLE public.referral_broadcast_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read referral_broadcast_log" ON public.referral_broadcast_log FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));