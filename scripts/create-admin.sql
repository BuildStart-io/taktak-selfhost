-- Grant admin to a user AFTER they have signed up through the app.
-- Replace the email below.
insert into public.user_roles (user_id, role)
select id, 'admin'::app_role from auth.users where email = 'you@example.com'
on conflict (user_id, role) do nothing;

select u.email, r.role from public.user_roles r join auth.users u on u.id = r.user_id;
