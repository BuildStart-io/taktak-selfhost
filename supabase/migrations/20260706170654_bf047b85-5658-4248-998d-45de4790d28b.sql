-- Add pending_payment to listing_status enum
ALTER TYPE listing_status ADD VALUE IF NOT EXISTS 'pending_payment';

-- Add payment tracking columns to listings
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS payment_reference text,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS listing_fee numeric;

CREATE INDEX IF NOT EXISTS idx_listings_payment_reference ON public.listings(payment_reference);

-- Create payments table
CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  listing_id uuid REFERENCES public.listings(id) ON DELETE SET NULL,
  seller_id uuid REFERENCES public.marketplace_users(id) ON DELETE SET NULL,
  phone_number text,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'LKR',
  status text NOT NULL DEFAULT 'pending',
  provider text NOT NULL DEFAULT 'onepay',
  provider_transaction_id text,
  redirect_url text,
  gateway_response jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages payments"
  ON public.payments FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE TRIGGER update_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_payments_listing ON public.payments(listing_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON public.payments(status);