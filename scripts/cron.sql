-- pg_cron schedules for the self-hosted stack.
-- EDIT the two settings below before running.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- >>> EDIT THESE <<<
--   base_url    : public URL of your functions gateway
--   service_key : your self-hosted SUPABASE_SERVICE_ROLE_KEY
do $$
declare
  base_url text := 'http://api-gw:8000/functions/v1';
  service_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE2NDE3NjkyMDAsImV4cCI6MTc5OTUzNTYwMH0.xBBL5W0kwJrYsm8eQvJ-qpkEHyDmScIRMgmiO1gCMao';
  jobs text[][] := array[
    -- [job name, cron schedule, function name]
    ['taktak-payment-followups',  '*/10 * * * *', 'send-payment-followups-taktak'],
    ['taktak-referral-broadcast', '*/12 * * * *', 'send-referral-broadcast-taktak'],
    ['taktak-notify-buyers',      '*/5 * * * *',  'notify-buyers-taktak'],
    ['taktak-onepay-reconcile',   '*/5 * * * *',  'reconcile-onepay-pending-taktak'],
    ['taktak-wasender-health',    '*/10 * * * *', 'wasender-health-taktak'],
    ['taktak-waha-health',        '*/10 * * * *', 'waha-health-taktak'],
    ['taktak-revenue-report',     '30 2 * * *',   'send-revenue-report-taktak'],
    ['taktak-notion-analytics',   '0 3 * * *',    'push-notion-analytics-taktak']
  ];
  j text[];
begin
  foreach j slice 1 in array jobs loop
    perform cron.unschedule(j[1]) where exists (select 1 from cron.job where jobname = j[1]);
    perform cron.schedule(
      j[1],
      j[2],
      format($f$
        select net.http_post(
          url    := %L,
          headers:= jsonb_build_object(
                      'Content-Type','application/json',
                      'Authorization','Bearer %s'),
          body   := '{"source":"cron"}'::jsonb
        );
      $f$, base_url || '/' || j[3], service_key)
    );
  end loop;
end $$;

select jobname, schedule from cron.job order by jobname;
