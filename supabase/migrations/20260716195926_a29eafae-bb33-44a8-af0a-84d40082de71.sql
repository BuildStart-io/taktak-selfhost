
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS payment_followup_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_listings_pending_followup
  ON public.listings (created_at)
  WHERE status = 'pending_payment' AND payment_followup_sent_at IS NULL;

INSERT INTO public.bot_settings (key, value)
VALUES (
  'payment_followup',
  jsonb_build_object(
    'enabled', true,
    'delay_hours', 6,
    'message',
    E'👋 ආයුබෝවන්!\n\nඔබගේ Listing එක තවම activate වී නැහැ — ගෙවීම සම්පූර්ණ කලාට පසුව එය ක්ෂණිකව live වෙනවා. 🚀\n\nපහත අපගේ සාර්ථක Sellers කිහිප දෙනෙකුගේ අත්දැකීම් බලන්න 👇\n\n_ගෙවීමට උදව් අවශ්‍ය නම් මෙතනට reply කරන්න._',
    'images', '[]'::jsonb
  )
)
ON CONFLICT (key) DO NOTHING;
