
-- Referral code per marketplace user
ALTER TABLE public.marketplace_users
  ADD COLUMN IF NOT EXISTS referral_code text UNIQUE,
  ADD COLUMN IF NOT EXISTS payout_account jsonb DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES public.marketplace_users(id) ON DELETE CASCADE,
  referred_id uuid NOT NULL REFERENCES public.marketplace_users(id) ON DELETE CASCADE,
  referred_phone text NOT NULL,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referrals_unique_referred UNIQUE (referred_id),
  CONSTRAINT referrals_unique_phone UNIQUE (referred_phone),
  CONSTRAINT referrals_no_self CHECK (referrer_id <> referred_id)
);
GRANT ALL ON public.referrals TO service_role;
GRANT SELECT ON public.referrals TO authenticated;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read referrals" ON public.referrals FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TABLE IF NOT EXISTS public.referral_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES public.marketplace_users(id) ON DELETE CASCADE,
  referred_id uuid REFERENCES public.marketplace_users(id) ON DELETE SET NULL,
  reward_type text NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  listing_id uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- anti-abuse: one seller reward per listing, one buyer reward per referred user
CREATE UNIQUE INDEX IF NOT EXISTS referral_rewards_unique_listing
  ON public.referral_rewards (listing_id) WHERE reward_type = 'seller_listing';
CREATE UNIQUE INDEX IF NOT EXISTS referral_rewards_unique_buyer
  ON public.referral_rewards (referred_id) WHERE reward_type = 'buyer_search';
GRANT ALL ON public.referral_rewards TO service_role;
GRANT SELECT ON public.referral_rewards TO authenticated;
ALTER TABLE public.referral_rewards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read referral_rewards" ON public.referral_rewards FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TABLE IF NOT EXISTS public.referral_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.marketplace_users(id) ON DELETE CASCADE,
  amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  account_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  admin_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.referral_payouts TO service_role;
GRANT SELECT, UPDATE ON public.referral_payouts TO authenticated;
ALTER TABLE public.referral_payouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read referral_payouts" ON public.referral_payouts FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins update referral_payouts" ON public.referral_payouts FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_referral_payouts_updated_at
  BEFORE UPDATE ON public.referral_payouts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.bot_settings (key, value)
VALUES ('referral', '{"enabled": true, "seller_percent": 20, "buyer_reward": 5, "min_redeem": 1000, "bot_number": "94722756169"}'::jsonb)
ON CONFLICT DO NOTHING;
