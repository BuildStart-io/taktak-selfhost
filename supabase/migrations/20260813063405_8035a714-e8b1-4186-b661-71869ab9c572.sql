SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'wasender-webhook-health-10m';

SELECT cron.schedule(
  'wasender-webhook-health-10m',
  '*/10 * * * *',
  $command$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url', true) || '/functions/v1/wasender-health',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.anon_key', true)
    ),
    body := '{}'::jsonb
  );
  $command$
);