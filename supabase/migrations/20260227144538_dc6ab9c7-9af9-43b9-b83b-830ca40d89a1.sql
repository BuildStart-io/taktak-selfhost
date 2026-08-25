
-- Table to track sent notifications and prevent duplicates
CREATE TABLE public.notification_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  alert_id uuid REFERENCES public.buyer_alerts(id) ON DELETE CASCADE,
  listing_id uuid REFERENCES public.listings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  phone_number text NOT NULL,
  sent_at timestamp with time zone DEFAULT now(),
  status text DEFAULT 'sent',
  UNIQUE(alert_id, listing_id)
);

ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read notification_log" ON public.notification_log FOR SELECT USING (true);

-- Allow insert/update on buyer_alerts (service role only via RLS bypass, but add explicit policies for reads)
-- buyer_alerts already has a SELECT policy, no changes needed there
