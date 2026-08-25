-- 1. Roles infrastructure
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own roles" ON public.user_roles;
CREATE POLICY "Users can view their own roles"
ON public.user_roles FOR SELECT TO authenticated
USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- Existing dashboard accounts are staff: grant them admin
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'admin'::public.app_role FROM auth.users
ON CONFLICT (user_id, role) DO NOTHING;

-- 2. Lock down public-readable tables to admins only
DROP POLICY IF EXISTS "Public read alerts" ON public.buyer_alerts;
CREATE POLICY "Admins read buyer_alerts" ON public.buyer_alerts
FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE ALL ON public.buyer_alerts FROM anon;
GRANT SELECT ON public.buyer_alerts TO authenticated;
GRANT ALL ON public.buyer_alerts TO service_role;

DROP POLICY IF EXISTS "Public read messages" ON public.chat_messages;
CREATE POLICY "Admins read chat_messages" ON public.chat_messages
FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE ALL ON public.chat_messages FROM anon;
GRANT SELECT ON public.chat_messages TO authenticated;
GRANT ALL ON public.chat_messages TO service_role;

DROP POLICY IF EXISTS "Public read leads" ON public.leads;
CREATE POLICY "Admins read leads" ON public.leads
FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE ALL ON public.leads FROM anon;
GRANT SELECT ON public.leads TO authenticated;
GRANT ALL ON public.leads TO service_role;

DROP POLICY IF EXISTS "Public read users" ON public.marketplace_users;
CREATE POLICY "Admins read marketplace_users" ON public.marketplace_users
FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE ALL ON public.marketplace_users FROM anon;
GRANT SELECT ON public.marketplace_users TO authenticated;
GRANT ALL ON public.marketplace_users TO service_role;

DROP POLICY IF EXISTS "Public read notification_log" ON public.notification_log;
CREATE POLICY "Admins read notification_log" ON public.notification_log
FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE ALL ON public.notification_log FROM anon;
GRANT SELECT ON public.notification_log TO authenticated;
GRANT ALL ON public.notification_log TO service_role;

DROP POLICY IF EXISTS "Public read revenue" ON public.revenue;
CREATE POLICY "Admins read revenue" ON public.revenue
FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE ALL ON public.revenue FROM anon;
GRANT SELECT ON public.revenue TO authenticated;
GRANT ALL ON public.revenue TO service_role;

DROP POLICY IF EXISTS "Public read searches" ON public.search_history;
CREATE POLICY "Admins read search_history" ON public.search_history
FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE ALL ON public.search_history FROM anon;
GRANT SELECT ON public.search_history TO authenticated;
GRANT ALL ON public.search_history TO service_role;

-- 3. bot_settings: admin-only read/write (was: any authenticated, WITH CHECK true)
DROP POLICY IF EXISTS "Public read bot_settings" ON public.bot_settings;
DROP POLICY IF EXISTS "Authenticated insert bot_settings" ON public.bot_settings;
DROP POLICY IF EXISTS "Authenticated update bot_settings" ON public.bot_settings;

CREATE POLICY "Admins read bot_settings" ON public.bot_settings
FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins insert bot_settings" ON public.bot_settings
FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins update bot_settings" ON public.bot_settings
FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

REVOKE ALL ON public.bot_settings FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.bot_settings TO authenticated;
GRANT ALL ON public.bot_settings TO service_role;

-- 4. waha_sessions: admin-only (was: any authenticated, USING true / WITH CHECK true)
DROP POLICY IF EXISTS "Authenticated users can manage waha sessions" ON public.waha_sessions;
CREATE POLICY "Admins manage waha_sessions" ON public.waha_sessions
FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

REVOKE ALL ON public.waha_sessions FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.waha_sessions TO authenticated;
GRANT ALL ON public.waha_sessions TO service_role;

-- 5. Storage policies for listing-images (public bucket: reads allowed, writes admin-only)
DROP POLICY IF EXISTS "Public read listing images" ON storage.objects;
CREATE POLICY "Public read listing images" ON storage.objects
FOR SELECT USING (bucket_id = 'listing-images');

DROP POLICY IF EXISTS "Admins upload listing images" ON storage.objects;
CREATE POLICY "Admins upload listing images" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'listing-images' AND public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins update listing images" ON storage.objects;
CREATE POLICY "Admins update listing images" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'listing-images' AND public.has_role(auth.uid(), 'admin'))
WITH CHECK (bucket_id = 'listing-images' AND public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins delete listing images" ON storage.objects;
CREATE POLICY "Admins delete listing images" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'listing-images' AND public.has_role(auth.uid(), 'admin'));