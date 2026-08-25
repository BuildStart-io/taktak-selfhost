SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'wasender-webhook-health-10m';

SELECT cron.schedule(
  'wasender-webhook-health-10m',
  '*/10 * * * *',
  $command$
  SELECT net.http_post(
    url := 'https://ipqmlizuuqswtmnukulw.supabase.co/functions/v1/wasender-health',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlwcW1saXp1dXFzd3RtbnVrdWx3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwOTg3OTEsImV4cCI6MjA4NzY3NDc5MX0._RQBut6h5qzfjTUKurjKsIOgy9lTbwZyia08MX5X42s"}'::jsonb,
    body := '{}'::jsonb
  );
  $command$
);