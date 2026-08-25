
CREATE TABLE public.waha_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone_number text,
  waha_session_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'disconnected',
  role text NOT NULL DEFAULT 'bot',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.waha_sessions TO authenticated;
GRANT ALL ON public.waha_sessions TO service_role;

ALTER TABLE public.waha_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage waha sessions"
  ON public.waha_sessions FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE TRIGGER update_waha_sessions_updated_at
  BEFORE UPDATE ON public.waha_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
