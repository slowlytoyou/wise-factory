-- Run after the live-rate migration. Fixtures and checks are fully rolled back.
-- Fixed clocks make the trailing wall-time window and month boundaries exact.
begin;
create temporary table live_checks (name text not null, passed boolean not null);
create function pg_temp.live_assert(p_name text, p_ok boolean)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'Live leaderboard check failed: %', p_name; end if;
  insert into live_checks values (p_name, true);
end $$;

do $$
declare
  v_user uuid := gen_random_uuid();
  v_clock_user uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_legacy_request uuid := gen_random_uuid();
  v_now bigint := (extract(epoch from '2030-01-01T00:00:00Z'::timestamptz) * 1000)::bigint;
  v_boundary bigint := (extract(epoch from '2030-02-28T15:00:00Z'::timestamptz) * 1000)::bigint;
  v_state jsonb;
  v_first_state jsonb;
  v_candidate jsonb;
  v_result jsonb;
  v_samples jsonb;
  v_invalid jsonb;
  v_invalid_name text;
begin
  v_state := jsonb_build_object('version', 3, 'contentVersion', 2,
    'lifetimeRevenue', 0, 'elapsed', 0, 'coins', 300, 'savedAt', v_now - 10000);
  insert into auth.users (id) values (v_user), (v_clock_user);
  perform public.factory_prepare(v_user, v_state, gen_random_uuid(), 'live-fixture');
  perform public.factory_prepare(v_clock_user, v_state, gen_random_uuid(), 'clock-fixture');
  perform pg_temp.live_assert('new factory starts with empty recent sales',
    (select recent_sales = '[]'::jsonb from public.factory_states where user_id = v_user));

  -- Read-time filtering is independent of new syncs, monthly time, or playtime.
  update public.factory_states set recent_sales = jsonb_build_array(
    jsonb_build_object('at', v_now - 60000, 'revenue', 600),
    jsonb_build_object('at', v_now - 59999, 'revenue', 60),
    jsonb_build_object('at', v_now - 1, 'revenue', 60),
    jsonb_build_object('at', v_now, 'revenue', 60),
    jsonb_build_object('at', v_now + 1000, 'revenue', 6000))
  where user_id = v_clock_user;
  v_result := public.factory_leaderboard_at(v_clock_user, to_timestamp(v_now / 1000.0));
  perform pg_temp.live_assert('window duration metadata is sixty seconds', (v_result ->> 'rateWindowSeconds')::integer = 60);
  perform pg_temp.live_assert('refresh metadata is three seconds', (v_result ->> 'refreshIntervalSeconds')::integer = 3);
  perform pg_temp.live_assert('window excludes exact sixty-second cutoff and future samples',
    (v_result #>> '{me,goldPerSecond}')::numeric = 3);
  perform pg_temp.live_assert('recent sales do not create monthly score or playtime',
    (v_result #>> '{me,score}')::numeric = 0 and (v_result #>> '{me,playSeconds}')::numeric = 0);
  update public.factory_states set recent_sales = recent_sales - 4 where user_id = v_clock_user;
  v_result := public.factory_leaderboard_at(v_clock_user, to_timestamp((v_now + 1) / 1000.0));
  perform pg_temp.live_assert('one millisecond advances the exact trailing window',
    (v_result #>> '{me,goldPerSecond}')::numeric = 2);
  v_result := public.factory_leaderboard_at(v_clock_user, to_timestamp((v_now + 59999) / 1000.0));
  perform pg_temp.live_assert('idle rate decays without a commit', (v_result #>> '{me,goldPerSecond}')::numeric = 1);
  v_result := public.factory_leaderboard_at(v_clock_user, to_timestamp((v_now + 60000) / 1000.0));
  perform pg_temp.live_assert('sixty seconds without sales returns zero', (v_result #>> '{me,goldPerSecond}')::numeric = 0);
  update public.factory_states set recent_sales = jsonb_build_array(
    jsonb_build_object('at', v_boundary - 1000, 'revenue', 90)), play_seconds = 42.5
  where user_id = v_clock_user;
  insert into public.factory_monthly_scores (user_id, month, revenue, seconds)
    values (v_clock_user, '2030-02-01', 123, 100);
  v_result := public.factory_leaderboard_at(v_clock_user, to_timestamp((v_boundary - 1) / 1000.0));
  perform pg_temp.live_assert('before month boundary rate is independent of monthly average',
    (v_result #>> '{me,score}')::numeric = 123 and (v_result #>> '{me,goldPerSecond}')::numeric = 1.5);
  v_result := public.factory_leaderboard_at(v_clock_user, to_timestamp(v_boundary / 1000.0));
  perform pg_temp.live_assert('month boundary resets only monthly score',
    (v_result #>> '{me,score}')::numeric = 0 and (v_result #>> '{me,goldPerSecond}')::numeric = 1.5
    and (v_result #>> '{me,playSeconds}')::numeric = 42.5);

  v_first_state := v_state || jsonb_build_object('savedAt', v_now, 'elapsed', 10, 'lifetimeRevenue', 90, 'coins', 390);
  v_samples := jsonb_build_array(jsonb_build_object('at', v_now - 9000, 'revenue', 30),
    jsonb_build_object('at', v_now, 'revenue', 60));
  v_result := public.factory_commit_live(v_user, 0, v_request, 'first-live', v_first_state, 90, '실시간 공장',
    '[]', 0, 0, '[{"month":"2030-01-01","revenue":90,"seconds":10}]', v_samples);
  perform pg_temp.live_assert('live commit increments revision once', (v_result ->> 'revision')::integer = 1);
  perform pg_temp.live_assert('live commit stores individual sale timestamps',
    (select recent_sales = v_samples from public.factory_states where user_id = v_user));
  perform pg_temp.live_assert('live commit preserves monthly and lifetime accounting',
    (select revenue = 90 and seconds = 10 from public.factory_monthly_scores where user_id = v_user and month = '2030-01-01')
    and (select play_seconds = 10 and state = v_first_state from public.factory_states where user_id = v_user));
  v_result := public.factory_leaderboard_at(v_user, to_timestamp(v_now / 1000.0));
  perform pg_temp.live_assert('first ten seconds still use a fixed sixty-second divisor',
    (v_result #>> '{me,goldPerSecond}')::numeric = 1.5);
  perform pg_temp.live_assert('entries and personal row expose the same live rate',
    exists (select 1 from jsonb_array_elements(v_result -> 'entries') as entry
      where entry ->> 'nickname' = '실시간 공장' and (entry ->> 'goldPerSecond')::numeric = 1.5));

  v_result := public.factory_commit_live(v_user, 0, v_request, 'first-live', v_first_state, 90, '실시간 공장',
    '[]', 0, 0, '[]', null);
  perform pg_temp.live_assert('receipt replay takes precedence over malformed samples', (v_result ->> 'replayed')::boolean);
  perform pg_temp.live_assert('replay never duplicates recent sales or playtime',
    (select recent_sales = v_samples and play_seconds = 10 and revision = 1 from public.factory_states where user_id = v_user));
  v_result := public.factory_commit_live(v_user, 1, v_request, 'different-hash', v_first_state, 90, '실시간 공장',
    '[]', 0, 0, '[]', null);
  perform pg_temp.live_assert('changed replay payload remains rejected', v_result ->> 'error' = 'request_id_reused');
  v_result := public.factory_commit_live(v_user, 0, gen_random_uuid(), 'stale-live', v_first_state, 90, '실시간 공장',
    '[]', 0, 0, '[]', null);
  perform pg_temp.live_assert('CAS conflict takes precedence over malformed samples', v_result ->> 'error' = 'revision_conflict');

  v_state := v_first_state || jsonb_build_object('savedAt', v_now + 60000, 'elapsed', 70, 'lifetimeRevenue', 150, 'coins', 450);
  v_samples := jsonb_build_array(jsonb_build_object('at', v_now + 5000, 'revenue', 60));
  v_result := public.factory_commit_live(v_user, 1, gen_random_uuid(), 'next-live', v_state, 150, '실시간 공장',
    '[]', 0, 0, '[{"month":"2030-01-01","revenue":60,"seconds":60}]', v_samples);
  perform pg_temp.live_assert('next commit prunes expired history including exact cutoff',
    (v_result ->> 'revision')::integer = 2 and (select recent_sales = v_samples from public.factory_states where user_id = v_user));
  v_result := public.factory_leaderboard_at(v_user, to_timestamp((v_now + 60000) / 1000.0));
  perform pg_temp.live_assert('old sale time is retained instead of sync time', (v_result #>> '{me,goldPerSecond}')::numeric = 1);

  v_candidate := v_state || jsonb_build_object('savedAt', v_now + 65000, 'elapsed', 75, 'lifetimeRevenue', 151);
  for v_invalid_name, v_invalid in select * from (values
    ('non-array samples', '{}'::jsonb),
    ('null samples', 'null'::jsonb),
    ('missing sample fields', '[{}]'::jsonb),
    ('future sample', jsonb_build_array(jsonb_build_object('at', v_now + 65001, 'revenue', 1))),
    ('sample before previous save', jsonb_build_array(jsonb_build_object('at', v_now + 59999, 'revenue', 1))),
    ('fractional timestamp', jsonb_build_array(jsonb_build_object('at', v_now + 62000.5, 'revenue', 1))),
    ('string timestamp', jsonb_build_array(jsonb_build_object('at', (v_now + 62000)::text, 'revenue', 1))),
    ('zero revenue sample', jsonb_build_array(jsonb_build_object('at', v_now + 62000, 'revenue', 0))),
    ('negative revenue sample', jsonb_build_array(jsonb_build_object('at', v_now + 62000, 'revenue', -1))),
    ('string revenue', jsonb_build_array(jsonb_build_object('at', v_now + 62000, 'revenue', '1'))),
    ('sample revenue does not equal lifetime delta', jsonb_build_array(jsonb_build_object('at', v_now + 62000, 'revenue', 2))),
    ('missing sales for positive lifetime delta', '[]'::jsonb),
    ('duplicate sample timestamps', jsonb_build_array(jsonb_build_object('at', v_now + 62000, 'revenue', 0.5),
      jsonb_build_object('at', v_now + 62000, 'revenue', 0.5))),
    ('unordered sample timestamps', jsonb_build_array(jsonb_build_object('at', v_now + 62001, 'revenue', 0.5),
      jsonb_build_object('at', v_now + 62000, 'revenue', 0.5)))
  ) as cases(name, samples) loop
    v_result := public.factory_commit_live(v_user, 2, gen_random_uuid(), v_invalid_name, v_candidate, 151, '실시간 공장',
      '[]', 0, 0, '[{"month":"2030-01-01","revenue":1,"seconds":5}]', v_invalid);
    perform pg_temp.live_assert(v_invalid_name || ' rejected', v_result ->> 'error' = 'invalid_sales');
  end loop;
  select jsonb_agg(jsonb_build_object('at', v_now + 60001 + n, 'revenue', 1)) into v_invalid from generate_series(0, 121) as n;
  v_result := public.factory_commit_live(v_user, 2, gen_random_uuid(), 'sample-count', v_candidate, 151, '실시간 공장',
    '[]', 0, 0, '[{"month":"2030-01-01","revenue":1,"seconds":5}]', v_invalid);
  perform pg_temp.live_assert('more than 121 new samples rejected', v_result ->> 'error' = 'invalid_sales');
  perform pg_temp.live_assert('invalid sales leave state and recent history unchanged',
    (select revision = 2 and state = v_state and recent_sales = v_samples and play_seconds = 70
      from public.factory_states where user_id = v_user));
  perform pg_temp.live_assert('invalid sales leave monthly ledger unchanged',
    (select revenue = 150 and seconds = 70 from public.factory_monthly_scores where user_id = v_user and month = '2030-01-01'));
  perform pg_temp.live_assert('invalid sales create no receipt',
    (select count(*) = 2 from public.factory_requests where user_id = v_user));

  v_state := v_candidate;
  v_samples := jsonb_build_array(jsonb_build_object('at', v_now + 60000, 'revenue', 1));
  v_result := public.factory_commit_live(v_user, 2, gen_random_uuid(), 'inclusive-lower', v_state, 151, '실시간 공장',
    '[]', 0, 0, '[{"month":"2030-01-01","revenue":1,"seconds":5}]', v_samples);
  perform pg_temp.live_assert('previous save boundary is accepted for rounded tick timestamp',
    (v_result ->> 'revision')::integer = 3 and (select recent_sales = v_samples from public.factory_states where user_id = v_user));
  v_candidate := v_state || jsonb_build_object('savedAt', v_now + 200000, 'elapsed', 195, 'lifetimeRevenue', 152);
  v_result := public.factory_commit_live(v_user, 3, gen_random_uuid(), 'interval-cap', v_candidate, 152, '실시간 공장',
    '[]', 0, 0, '[{"month":"2030-01-01","revenue":1,"seconds":120}]',
    jsonb_build_array(jsonb_build_object('at', v_now + 79999, 'revenue', 1)));
  perform pg_temp.live_assert('sales older than maximum active interval rejected', v_result ->> 'error' = 'invalid_sales');
  v_state := v_candidate;
  v_result := public.factory_commit_live(v_user, 3, gen_random_uuid(), 'interval-boundary', v_state, 152, '실시간 공장',
    '[]', 0, 0, '[{"month":"2030-01-01","revenue":1,"seconds":120}]',
    jsonb_build_array(jsonb_build_object('at', v_now + 80000, 'revenue', 1)));
  perform pg_temp.live_assert('exact active interval boundary accepted', (v_result ->> 'revision')::integer = 4);
  perform pg_temp.live_assert('valid old interval sales count monthly but are absent from live window',
    (select recent_sales = '[]'::jsonb and play_seconds = 195 from public.factory_states where user_id = v_user)
    and (select revenue = 152 from public.factory_monthly_scores where user_id = v_user and month = '2030-01-01'));

  -- A rolling deployment can briefly receive an old worker commit. It must not
  -- advertise inherited history as if the missing sale timestamps were known.
  update public.factory_states set recent_sales = jsonb_build_array(jsonb_build_object('at', v_now + 200000, 'revenue', 60))
    where user_id = v_user;
  v_state := v_state || jsonb_build_object('savedAt', v_now + 201000, 'elapsed', 196);
  v_result := public.factory_commit_monthly(v_user, 4, v_legacy_request, 'legacy-live', v_state, 152, '실시간 공장',
    '[]', 0, 0, '[{"month":"2030-01-01","revenue":0,"seconds":1}]');
  perform pg_temp.live_assert('legacy worker commit remains supported and clears unverifiable live rate',
    (v_result ->> 'revision')::integer = 5 and (select recent_sales = '[]'::jsonb from public.factory_states where user_id = v_user));
  v_state := v_state || jsonb_build_object('savedAt', v_now + 202000, 'elapsed', 197, 'lifetimeRevenue', 212);
  v_samples := jsonb_build_array(jsonb_build_object('at', v_now + 202000, 'revenue', 60));
  v_result := public.factory_commit_live(v_user, 5, gen_random_uuid(), 'after-legacy', v_state, 212, '실시간 공장',
    '[]', 0, 0, '[{"month":"2030-01-01","revenue":60,"seconds":1}]', v_samples);
  perform pg_temp.live_assert('new worker resumes sale history after old worker',
    (v_result ->> 'revision')::integer = 6 and (select recent_sales = v_samples from public.factory_states where user_id = v_user));
  v_result := public.factory_commit_monthly(v_user, 4, v_legacy_request, 'legacy-live', v_state, 212, '실시간 공장',
    '[]', 0, 0, '[]');
  perform pg_temp.live_assert('legacy replay preserves newer sale history',
    (v_result ->> 'replayed')::boolean and (select recent_sales = v_samples from public.factory_states where user_id = v_user));
  v_result := public.factory_commit_live(v_user, 0, v_request, 'first-live', v_first_state, 90, '실시간 공장',
    '[]', 0, 0, '[]', null);
  perform pg_temp.live_assert('old live replay preserves latest history and state',
    (v_result ->> 'replayed')::boolean and (select recent_sales = v_samples and state = v_state and revision = 6
      from public.factory_states where user_id = v_user));
  v_candidate := v_state || jsonb_build_object('savedAt', v_now + 203000, 'elapsed', 198, 'lifetimeRevenue', 213);
  v_result := public.factory_commit_live(v_user, 6, gen_random_uuid(), 'invalid-monthly-live', v_candidate, 213, '실시간 공장',
    '[]', 0, 0, '[{"month":"2030-01-01","revenue":2,"seconds":1}]',
    jsonb_build_array(jsonb_build_object('at', v_now + 203000, 'revenue', 1)));
  perform pg_temp.live_assert('monthly validation failures propagate through live wrapper', v_result ->> 'error' = 'invalid_monthly');
  perform pg_temp.live_assert('failed monthly validation never replaces recent sales',
    (select recent_sales = v_samples and revision = 6 and state = v_state from public.factory_states where user_id = v_user));

  v_state := v_candidate;
  v_result := public.factory_commit_live(v_user, 6, gen_random_uuid(), 'merge-live-history', v_state, 213, '실시간 공장',
    '[]', 0, 0, '[{"month":"2030-01-01","revenue":1,"seconds":1}]',
    jsonb_build_array(jsonb_build_object('at', v_now + 203000, 'revenue', 1)));
  v_samples := v_samples || jsonb_build_array(jsonb_build_object('at', v_now + 203000, 'revenue', 1));
  perform pg_temp.live_assert('valid new sales merge with unexpired previous sales',
    (v_result ->> 'revision')::integer = 7 and (select recent_sales = v_samples from public.factory_states where user_id = v_user));
  v_result := public.factory_leaderboard_at(v_user, to_timestamp((v_now + 203000) / 1000.0));
  perform pg_temp.live_assert('merged history has the exact fixed-window rate',
    (v_result #>> '{me,goldPerSecond}')::numeric = 61::numeric / 60);
  v_state := v_state || jsonb_build_object('savedAt', v_now + 204000, 'elapsed', 199);
  v_result := public.factory_commit_live(v_user, 7, gen_random_uuid(), 'idle-with-history', v_state, 213, '실시간 공장',
    '[]', 0, 0, '[{"month":"2030-01-01","revenue":0,"seconds":1}]', '[]');
  perform pg_temp.live_assert('empty sales sync retains unexpired previous history',
    (v_result ->> 'revision')::integer = 8 and (select recent_sales = v_samples from public.factory_states where user_id = v_user));
  v_state := v_state || jsonb_build_object('savedAt', v_now + 263000, 'elapsed', 258);
  v_result := public.factory_commit_live(v_user, 8, gen_random_uuid(), 'idle-expired-history', v_state, 213, '실시간 공장',
    '[]', 0, 0, '[{"month":"2030-01-01","revenue":0,"seconds":59}]', '[]');
  perform pg_temp.live_assert('empty sales sync prunes history at exact expiration',
    (v_result ->> 'revision')::integer = 9 and (select recent_sales = '[]'::jsonb and play_seconds = 258 from public.factory_states where user_id = v_user));

  perform pg_temp.live_assert('anonymous role cannot read recent sales', not has_column_privilege('anon', 'public.factory_states', 'recent_sales', 'SELECT'));
  perform pg_temp.live_assert('authenticated role cannot read recent sales', not has_column_privilege('authenticated', 'public.factory_states', 'recent_sales', 'SELECT'));
  perform pg_temp.live_assert('anonymous role cannot write recent sales', not has_column_privilege('anon', 'public.factory_states', 'recent_sales', 'UPDATE'));
  perform pg_temp.live_assert('authenticated role cannot write recent sales', not has_column_privilege('authenticated', 'public.factory_states', 'recent_sales', 'UPDATE'));
  perform pg_temp.live_assert('anonymous role cannot commit live sales', not has_function_privilege('anon', 'public.factory_commit_live(uuid,bigint,uuid,text,jsonb,numeric,text,jsonb,numeric,numeric,jsonb,jsonb)', 'EXECUTE'));
  perform pg_temp.live_assert('authenticated role cannot commit live sales', not has_function_privilege('authenticated', 'public.factory_commit_live(uuid,bigint,uuid,text,jsonb,numeric,text,jsonb,numeric,numeric,jsonb,jsonb)', 'EXECUTE'));
  perform pg_temp.live_assert('server can commit live sales', has_function_privilege('service_role', 'public.factory_commit_live(uuid,bigint,uuid,text,jsonb,numeric,text,jsonb,numeric,numeric,jsonb,jsonb)', 'EXECUTE'));
  perform pg_temp.live_assert('live RPC retains invoker security', not (select prosecdef from pg_proc where oid = 'public.factory_commit_live(uuid,bigint,uuid,text,jsonb,numeric,text,jsonb,numeric,numeric,jsonb,jsonb)'::regprocedure));
end $$;

select count(*) as passed, bool_and(passed) as all_passed from live_checks;
rollback;
