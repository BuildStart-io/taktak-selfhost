
-- Drop overly permissive "Service role full access" policies
DROP POLICY "Service role full access" ON public.marketplace_users;
DROP POLICY "Service role full access" ON public.listings;
DROP POLICY "Service role full access" ON public.search_history;
DROP POLICY "Service role full access" ON public.chat_messages;
DROP POLICY "Service role full access" ON public.buyer_alerts;
DROP POLICY "Service role full access" ON public.leads;
DROP POLICY "Service role full access" ON public.revenue;
