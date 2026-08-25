CREATE TABLE public.bot_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.bot_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read bot_settings" ON public.bot_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated update bot_settings" ON public.bot_settings FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated insert bot_settings" ON public.bot_settings FOR INSERT TO authenticated WITH CHECK (true);

-- Seed default settings
INSERT INTO public.bot_settings (key, value) VALUES 
  ('bot_mode', '{"mode": "off", "seller_first_message": "🛍️ ඔබේ භාණ්ඩය විකුණන්න TakTak එක්ක! ඔබේ භාණ්ඩයේ photo එකක් send කරන්න, අපි ඔබට විකිණීමට උදව් කරන්නම්!", "buyer_first_message": "🛒 TakTak වෙත සාදරයෙන් පිළිගනිමු! ඔබට අවශ්‍ය දේ කියන්න, අපි හොයලා දෙන්නම්!"}');