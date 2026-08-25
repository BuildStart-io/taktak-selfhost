insert into public.bot_settings (key, value)
values ('referral_broadcast', '{"enabled": true}'::jsonb)
on conflict (key) do update set value = public.bot_settings.value || '{"enabled": true}'::jsonb, updated_at = now();