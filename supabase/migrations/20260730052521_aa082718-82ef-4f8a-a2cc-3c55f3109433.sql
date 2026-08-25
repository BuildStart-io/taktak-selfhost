DROP POLICY IF EXISTS "Public read listing images" ON storage.objects;
CREATE POLICY "Admins list listing images" ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'listing-images' AND public.has_role(auth.uid(), 'admin'));

REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;