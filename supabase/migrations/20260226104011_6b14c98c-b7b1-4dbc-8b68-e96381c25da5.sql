
-- Product categories enum
CREATE TYPE public.product_condition AS ENUM ('new', 'like_new', 'good', 'fair', 'poor');
CREATE TYPE public.listing_status AS ENUM ('active', 'sold', 'expired', 'removed', 'pending');
CREATE TYPE public.user_type AS ENUM ('buyer', 'seller', 'both');
CREATE TYPE public.chat_intent AS ENUM ('buy', 'sell', 'search', 'negotiate', 'check_availability', 'greeting', 'unknown');

-- Marketplace users (WhatsApp users)
CREATE TABLE public.marketplace_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT UNIQUE NOT NULL,
  display_name TEXT,
  user_type user_type DEFAULT 'buyer',
  preferred_language TEXT DEFAULT 'en',
  district TEXT,
  city TEXT,
  is_verified BOOLEAN DEFAULT false,
  trust_score NUMERIC(3,1) DEFAULT 5.0,
  successful_sales INTEGER DEFAULT 0,
  successful_purchases INTEGER DEFAULT 0,
  is_flagged BOOLEAN DEFAULT false,
  flag_reason TEXT,
  subscription_type TEXT DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Product listings
CREATE TABLE public.listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID REFERENCES public.marketplace_users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  price NUMERIC(12,2) NOT NULL,
  condition product_condition DEFAULT 'good',
  city TEXT NOT NULL,
  district TEXT NOT NULL,
  images TEXT[] DEFAULT '{}',
  status listing_status DEFAULT 'active',
  is_sponsored BOOLEAN DEFAULT false,
  is_boosted BOOLEAN DEFAULT false,
  boost_expires_at TIMESTAMPTZ,
  views_count INTEGER DEFAULT 0,
  match_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '30 days')
);

-- Search history
CREATE TABLE public.search_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.marketplace_users(id) ON DELETE CASCADE NOT NULL,
  query_text TEXT NOT NULL,
  detected_product TEXT,
  detected_category TEXT,
  detected_location TEXT,
  detected_intent chat_intent DEFAULT 'search',
  filters JSONB DEFAULT '{}',
  results_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Chat messages log
CREATE TABLE public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.marketplace_users(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_text TEXT,
  message_type TEXT DEFAULT 'text',
  intent chat_intent,
  session_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Notifications / alerts
CREATE TABLE public.buyer_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.marketplace_users(id) ON DELETE CASCADE NOT NULL,
  search_query TEXT NOT NULL,
  product_keyword TEXT,
  category TEXT,
  location TEXT,
  max_price NUMERIC(12,2),
  is_active BOOLEAN DEFAULT true,
  is_premium BOOLEAN DEFAULT false,
  last_notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Transactions / leads
CREATE TABLE public.leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id UUID REFERENCES public.marketplace_users(id) ON DELETE SET NULL,
  seller_id UUID REFERENCES public.marketplace_users(id) ON DELETE SET NULL,
  listing_id UUID REFERENCES public.listings(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'initiated' CHECK (status IN ('initiated', 'contacted', 'negotiating', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Revenue tracking
CREATE TABLE public.revenue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.marketplace_users(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('subscription', 'sponsored', 'boost', 'premium_alert')),
  amount NUMERIC(10,2) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.marketplace_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buyer_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revenue ENABLE ROW LEVEL SECURITY;

-- Service role policies (edge functions use service role key)
-- Allow service role full access (edge functions)
CREATE POLICY "Service role full access" ON public.marketplace_users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON public.listings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON public.search_history FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON public.chat_messages FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON public.buyer_alerts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON public.leads FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON public.revenue FOR ALL USING (true) WITH CHECK (true);

-- Public read for listings (admin dashboard uses anon key)
CREATE POLICY "Public read listings" ON public.listings FOR SELECT USING (true);
CREATE POLICY "Public read users" ON public.marketplace_users FOR SELECT USING (true);
CREATE POLICY "Public read searches" ON public.search_history FOR SELECT USING (true);
CREATE POLICY "Public read messages" ON public.chat_messages FOR SELECT USING (true);
CREATE POLICY "Public read alerts" ON public.buyer_alerts FOR SELECT USING (true);
CREATE POLICY "Public read leads" ON public.leads FOR SELECT USING (true);
CREATE POLICY "Public read revenue" ON public.revenue FOR SELECT USING (true);

-- Indexes
CREATE INDEX idx_listings_status ON public.listings(status);
CREATE INDEX idx_listings_district ON public.listings(district);
CREATE INDEX idx_listings_category ON public.listings(category);
CREATE INDEX idx_listings_seller ON public.listings(seller_id);
CREATE INDEX idx_search_user ON public.search_history(user_id);
CREATE INDEX idx_chat_phone ON public.chat_messages(phone_number);
CREATE INDEX idx_chat_user ON public.chat_messages(user_id);
CREATE INDEX idx_alerts_user ON public.buyer_alerts(user_id);
CREATE INDEX idx_users_phone ON public.marketplace_users(phone_number);

-- Updated at trigger
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_marketplace_users_updated_at BEFORE UPDATE ON public.marketplace_users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_listings_updated_at BEFORE UPDATE ON public.listings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_leads_updated_at BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
