-- Run after the monthly, total-play-time, and live-rate migrations. All fixtures and checks are rolled back,
-- including the temporary auth users. Any failed assertion aborts the query.
begin;
create temporary table monthly_checks (name text not null, passed boolean not null);
create function pg_temp.monthly_assert(p_name text, p_ok boolean)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'Monthly leaderboard check failed: %', p_name; end if;
  insert into monthly_checks values (p_name, true);
end $$;

do $$
declare
  v_user uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_missing uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_extra uuid;
  v_index integer;
  v_result jsonb;
  v_state jsonb := '{"version":3,"contentVersion":2,"lifetimeRevenue":10,"elapsed":0,"coins":300}'::jsonb;
  v_new_state jsonb := '{"version":3,"contentVersion":2,"lifetimeRevenue":110.75,"elapsed":4.5,"coins":400.75}'::jsonb;
  v_deltas jsonb := '[{"month":"2030-01-01","revenue":60.25,"seconds":2.5},{"month":"2030-02-01","revenue":40.5,"seconds":2}]'::jsonb;
begin
  insert into auth.users (id) values (v_user), (v_other);
  perform public.factory_prepare(v_user, v_state, gen_random_uuid(), 'fixture-one');
  perform public.factory_prepare(v_other, v_state, gen_random_uuid(), 'fixture-two');
  update public.factory_states set score = 10 where user_id in (v_user, v_other);
  perform pg_temp.monthly_assert('new factory starts with zero total play time', (select play_seconds = 0 from public.factory_states where user_id = v_user));

  v_result := public.factory_leaderboard_at(v_user, '2023-12-31T14:59:59.999Z');
  perform pg_temp.monthly_assert('KST before January boundary', v_result ->> 'month' = '2023-12');
  perform pg_temp.monthly_assert('year boundary reset instant', v_result ->> 'resetsAt' = '2023-12-31T15:00:00Z');
  perform pg_temp.monthly_assert('timezone is explicit', v_result ->> 'timezone' = 'Asia/Seoul');
  perform pg_temp.monthly_assert('missing monthly score is zero', (v_result #>> '{me,score}')::numeric = 0);
  perform pg_temp.monthly_assert('missing recent sales rate is zero', (v_result #>> '{me,goldPerSecond}')::numeric = 0);
  perform pg_temp.monthly_assert('new leaderboard player has zero total play time', (v_result #>> '{me,playSeconds}')::numeric = 0);
  perform pg_temp.monthly_assert('lifetime score is excluded', (select score = 10 and state ->> 'lifetimeRevenue' = '10' from public.factory_states where user_id = v_user));
  perform pg_temp.monthly_assert('unknown factory has null me', public.factory_leaderboard_at(v_missing, '2024-01-01T00:00:00Z') -> 'me' = 'null'::jsonb);

  insert into public.factory_monthly_scores (user_id, month, revenue, seconds) values
    (v_user, '2023-12-01', 999999, 100),
    (v_user, '2024-01-01', 100.75, 20.15),
    (v_other, '2024-01-01', 100.25, 10),
    (v_user, '2024-02-01', 200.5, 50),
    (v_user, '2025-02-01', 20, 10);
  v_result := public.factory_leaderboard_at(v_user, '2023-12-31T15:00:00Z');
  perform pg_temp.monthly_assert('January starts exactly at Korean midnight', v_result ->> 'month' = '2024-01');
  perform pg_temp.monthly_assert('only selected month contributes', (v_result #>> '{me,score}')::numeric = 100);
  perform pg_temp.monthly_assert('monthly revenue never becomes a recent sales rate', (v_result #>> '{me,goldPerSecond}')::numeric = 0);
  perform pg_temp.monthly_assert('floor score ties share rank', v_result #>> '{me,rank}' = public.factory_leaderboard_at(v_other, '2023-12-31T15:00:00Z') #>> '{me,rank}');
  perform pg_temp.monthly_assert('next reset follows January length', v_result ->> 'resetsAt' = '2024-01-31T15:00:00Z');

  v_result := public.factory_leaderboard_at(v_user, '2024-02-29T14:59:59.999Z');
  perform pg_temp.monthly_assert('leap February remains active until midnight', v_result ->> 'month' = '2024-02' and (v_result #>> '{me,score}')::numeric = 200);
  perform pg_temp.monthly_assert('leap February reset instant', v_result ->> 'resetsAt' = '2024-02-29T15:00:00Z');
  v_result := public.factory_leaderboard_at(v_user, '2024-02-29T15:00:00Z');
  perform pg_temp.monthly_assert('reset occurs without any sync or scheduled job', v_result ->> 'month' = '2024-03' and (v_result #>> '{me,score}')::numeric = 0 and (v_result #>> '{me,goldPerSecond}')::numeric = 0);
  v_result := public.factory_leaderboard_at(v_user, '2025-02-28T14:59:59Z');
  perform pg_temp.monthly_assert('ordinary February reset instant', v_result ->> 'resetsAt' = '2025-02-28T15:00:00Z');
  perform pg_temp.monthly_assert('old month records remain intact', (select revenue = 200.5 from public.factory_monthly_scores where user_id = v_user and month = '2024-02-01'));

  v_result := public.factory_commit_monthly(v_user, 0, v_request, 'first', v_new_state, 110, '월간 공장', '[]', 0, 0, v_deltas);
  perform pg_temp.monthly_assert('monthly commit increments revision', (v_result ->> 'revision')::integer = 1);
  perform pg_temp.monthly_assert('commit updates permanent factory', (select state = v_new_state and score = 110 and nickname = '월간 공장' from public.factory_states where user_id = v_user));
  perform pg_temp.monthly_assert('active first month delta', (select revenue = 60.25 and seconds = 2.5 from public.factory_monthly_scores where user_id = v_user and month = '2030-01-01'));
  perform pg_temp.monthly_assert('active second month delta', (select revenue = 40.5 and seconds = 2 from public.factory_monthly_scores where user_id = v_user and month = '2030-02-01'));
  perform pg_temp.monthly_assert('accepted split-month deltas add fractional total play time', (select play_seconds = 4.5 from public.factory_states where user_id = v_user));
  v_result := public.factory_commit_monthly(v_user, 0, v_request, 'first', v_new_state, 110, '월간 공장', '[]', 0, 0, v_deltas);
  perform pg_temp.monthly_assert('request replay is identified', (v_result ->> 'replayed')::boolean and (v_result ->> 'appliedRevision')::integer = 1);
  perform pg_temp.monthly_assert('request replay never doubles monthly score', (select revenue = 40.5 and seconds = 2 from public.factory_monthly_scores where user_id = v_user and month = '2030-02-01'));
  perform pg_temp.monthly_assert('request replay never doubles total play time', (select play_seconds = 4.5 from public.factory_states where user_id = v_user));
  v_result := public.factory_commit_monthly(v_user, 0, v_request, 'first', v_new_state, 110, '월간 공장', '[]', 100.75, 4.5, v_deltas);
  perform pg_temp.monthly_assert('existing receipt replay takes precedence over old offline contract', (v_result ->> 'replayed')::boolean and (select play_seconds = 4.5 from public.factory_states where user_id = v_user));
  v_result := public.factory_prepare(v_user, v_state, v_request, 'first');
  perform pg_temp.monthly_assert('prepare replay sees monthly receipt', (v_result ->> 'replayed')::boolean and (v_result ->> 'revision')::integer = 1);
  v_result := public.factory_commit_monthly(v_user, 1, v_request, 'changed', v_new_state, 110, '월간 공장', '[]', 0, 0, '[]');
  perform pg_temp.monthly_assert('changed replay payload rejected', v_result ->> 'error' = 'request_id_reused');
  v_result := public.factory_commit_monthly(v_user, 0, gen_random_uuid(), 'conflict', v_new_state, 110, '월간 공장', '[]', 0, 0, '[]');
  perform pg_temp.monthly_assert('CAS rejects stale revision', v_result ->> 'error' = 'revision_conflict');
  perform pg_temp.monthly_assert('conflict leaves monthly data untouched', (select revenue = 60.25 from public.factory_monthly_scores where user_id = v_user and month = '2030-01-01'));
  perform pg_temp.monthly_assert('conflict leaves total play time untouched', (select play_seconds = 4.5 from public.factory_states where user_id = v_user));
  v_result := public.factory_commit_monthly(v_user, 0, gen_random_uuid(), 'stale-old-worker', v_new_state, 110, '월간 공장', '[]', 1, 1, '[]');
  perform pg_temp.monthly_assert('CAS conflict takes precedence over old offline contract', v_result ->> 'error' = 'revision_conflict');

  v_result := public.factory_commit_monthly(v_user, 1, gen_random_uuid(), 'negative', v_new_state, 110, '월간 공장', '[]', 0, 0, '[{"month":"2030-02-01","revenue":-1,"seconds":1}]');
  perform pg_temp.monthly_assert('negative delta rejected', v_result ->> 'error' = 'invalid_monthly');
  v_result := public.factory_commit_monthly(v_user, 1, gen_random_uuid(), 'wrong-day', v_new_state, 110, '월간 공장', '[]', 0, 0, '[{"month":"2030-02-02","revenue":0,"seconds":1}]');
  perform pg_temp.monthly_assert('non-month-start date rejected', v_result ->> 'error' = 'invalid_monthly');
  v_result := public.factory_commit_monthly(v_user, 1, gen_random_uuid(), 'mismatch', v_new_state, 110, '월간 공장', '[]', 0, 0, '[{"month":"2030-02-01","revenue":99,"seconds":1}]');
  perform pg_temp.monthly_assert('monthly and lifetime mismatch rejected', v_result ->> 'error' = 'invalid_monthly');
  v_result := public.factory_commit_monthly(v_user, 1, gen_random_uuid(), 'over-cap', v_new_state, 110, '월간 공장', '[]', 0, 0, '[{"month":"2030-02-01","revenue":0,"seconds":121}]');
  perform pg_temp.monthly_assert('active seconds cap enforced', v_result ->> 'error' = 'invalid_monthly');
  v_result := public.factory_commit_monthly(v_user, 1, gen_random_uuid(), 'sum-over-cap', v_new_state, 110, '월간 공장', '[]', 0, 0, '[{"month":"2030-01-01","revenue":0,"seconds":60},{"month":"2030-02-01","revenue":0,"seconds":60.01}]');
  perform pg_temp.monthly_assert('combined active seconds cap enforced', v_result ->> 'error' = 'invalid_monthly');
  v_result := public.factory_commit_monthly(v_user, 1, gen_random_uuid(), 'negative-seconds', v_new_state, 110, '월간 공장', '[]', 0, 0, '[{"month":"2030-02-01","revenue":0,"seconds":-1}]');
  perform pg_temp.monthly_assert('negative active seconds rejected', v_result ->> 'error' = 'invalid_monthly');
  v_result := public.factory_commit_monthly(v_user, 1, gen_random_uuid(), 'offline-earnings', v_new_state, 110, '월간 공장', '[]', 1, 0, '[]');
  perform pg_temp.monthly_assert('old worker offline earnings rejected', v_result ->> 'error' = 'update_required');
  v_result := public.factory_commit_monthly(v_user, 1, gen_random_uuid(), 'offline-seconds', v_new_state, 110, '월간 공장', '[]', 0, 1, '[]');
  perform pg_temp.monthly_assert('old worker offline seconds rejected', v_result ->> 'error' = 'update_required');
  v_result := public.factory_commit_monthly(v_user, 1, gen_random_uuid(), 'null-offline-seconds', v_new_state, 110, '월간 공장', '[]', 0, null, '[]');
  perform pg_temp.monthly_assert('missing offline contract rejected', v_result ->> 'error' = 'update_required');
  v_result := public.factory_commit_monthly(v_user, 1, gen_random_uuid(), 'content-downgrade', jsonb_set(v_new_state, '{contentVersion}', '1'), 110, '월간 공장', '[]', 0, 0, '[]');
  perform pg_temp.monthly_assert('old content rejected', v_result ->> 'error' = 'update_required');
  v_result := public.factory_commit_monthly(v_user, 1, gen_random_uuid(), 'save-downgrade', jsonb_set(v_new_state, '{version}', '2'), 110, '월간 공장', '[]', 0, 0, '[]');
  perform pg_temp.monthly_assert('save format downgrade rejected', v_result ->> 'error' = 'update_required');
  update public.factory_states set state = jsonb_set(state, '{contentVersion}', '3') where user_id = v_user;
  v_result := public.factory_commit_monthly(v_user, 1, gen_random_uuid(), 'future-downgrade', v_new_state, 110, '월간 공장', '[]', 0, 0, '[]');
  perform pg_temp.monthly_assert('future content remains protected', v_result ->> 'error' = 'update_required');
  update public.factory_states set state = v_new_state where user_id = v_user;
  v_result := public.factory_commit(v_user, 1, gen_random_uuid(), 'old-worker', v_new_state, 110, '월간 공장', '[]', 0, 0);
  perform pg_temp.monthly_assert('old worker commit cannot omit monthly accounting', v_result ->> 'error' = 'update_required');
  perform pg_temp.monthly_assert('all rejected writes preserve revision', (select revision = 1 from public.factory_states where user_id = v_user));
  perform pg_temp.monthly_assert('all rejected writes preserve total play time', (select play_seconds = 4.5 from public.factory_states where user_id = v_user));

  v_new_state := jsonb_set(v_new_state, '{lifetimeRevenue}', '112');
  v_result := public.factory_commit_monthly(v_user, 1, gen_random_uuid(), 'boundary-tick', v_new_state, 112, '월간 공장', '[]', 0, 0, '[{"month":"2030-03-01","revenue":1.25,"seconds":0}]');
  perform pg_temp.monthly_assert('boundary tick accepts revenue with zero elapsed seconds', (v_result ->> 'revision')::integer = 2);
  v_result := public.factory_leaderboard_at(v_user, '2030-02-28T15:00:00Z');
  perform pg_temp.monthly_assert('monthly-only revenue has no recent sales rate', (v_result #>> '{me,score}')::numeric = 1 and (v_result #>> '{me,goldPerSecond}')::numeric = 0);
  perform pg_temp.monthly_assert('zero-duration revenue does not add total play time', (v_result #>> '{me,playSeconds}')::numeric = 4.5);
  perform pg_temp.monthly_assert('leaderboard entries expose total play time', exists (select 1 from jsonb_array_elements(v_result -> 'entries') as entry where entry ->> 'nickname' = '월간 공장' and (entry ->> 'playSeconds')::numeric = 4.5));
  v_result := public.factory_leaderboard_at(v_user, '2030-03-31T15:00:00Z');
  perform pg_temp.monthly_assert('monthly reset preserves total play time', (v_result #>> '{me,score}')::numeric = 0 and (v_result #>> '{me,playSeconds}')::numeric = 4.5);

  v_new_state := jsonb_set(v_new_state, '{elapsed}', '0');
  v_result := public.factory_commit_monthly(v_user, 2, gen_random_uuid(), 'prestige', v_new_state, 112, '월간 공장', '[]', 0, 0, '[]');
  perform pg_temp.monthly_assert('prestige resets run elapsed but preserves total play time', (v_result ->> 'revision')::integer = 3 and (select state ->> 'elapsed' = '0' and play_seconds = 4.5 from public.factory_states where user_id = v_user));
  v_new_state := jsonb_set(v_new_state, '{elapsed}', '0.25');
  v_result := public.factory_commit_monthly(v_user, 3, gen_random_uuid(), 'after-prestige', v_new_state, 112, '월간 공장', '[]', 0, 0, '[{"month":"2030-04-01","revenue":0,"seconds":0.25}]');
  perform pg_temp.monthly_assert('post-prestige play continues lifetime counter', (v_result ->> 'revision')::integer = 4 and (select play_seconds = 4.75 from public.factory_states where user_id = v_user));
  v_result := public.factory_commit_monthly(v_user, 4, gen_random_uuid(), 'fresh-load', v_new_state, 112, '월간 공장', '[]', 0, 0, '[]');
  perform pg_temp.monthly_assert('loading without active time does not add play time', (v_result ->> 'revision')::integer = 5 and (select play_seconds = 4.75 from public.factory_states where user_id = v_user));
  v_result := public.factory_commit_monthly(v_other, 0, gen_random_uuid(), 'active-cap', jsonb_set(v_state, '{elapsed}', '120'), 10, 'fixture-two', '[]', 0, 0, '[{"month":"2030-04-01","revenue":0,"seconds":120}]');
  perform pg_temp.monthly_assert('exact active seconds cap is accepted', (v_result ->> 'revision')::integer = 1 and (select play_seconds = 120 from public.factory_states where user_id = v_other));

  begin
    update public.factory_states set play_seconds = -1 where user_id = v_user;
    perform pg_temp.monthly_assert('negative total play time is constrained', false);
  exception when check_violation then
    perform pg_temp.monthly_assert('negative total play time is constrained', true);
  end;
  begin
    update public.factory_states set play_seconds = 'Infinity'::numeric where user_id = v_user;
    perform pg_temp.monthly_assert('infinite total play time is constrained', false);
  exception when check_violation then
    perform pg_temp.monthly_assert('infinite total play time is constrained', true);
  end;
  begin
    update public.factory_states set play_seconds = 'NaN'::numeric where user_id = v_user;
    perform pg_temp.monthly_assert('NaN total play time is constrained', false);
  exception when check_violation then
    perform pg_temp.monthly_assert('NaN total play time is constrained', true);
  end;
  perform pg_temp.monthly_assert('constraint failures preserve total play time', (select play_seconds = 4.75 from public.factory_states where user_id = v_user));

  -- A personal row remains available even when it falls outside the top 20.
  for v_index in 1..21 loop
    v_extra := gen_random_uuid();
    insert into auth.users (id) values (v_extra);
    perform public.factory_prepare(v_extra, v_state, gen_random_uuid(), 'fixture-ranked');
    insert into public.factory_monthly_scores (user_id, month, revenue, seconds)
      values (v_extra, '2030-04-01', 100 + v_index, 1);
  end loop;
  v_result := public.factory_leaderboard_at(v_user, '2030-03-31T15:00:00Z');
  perform pg_temp.monthly_assert('top leaderboard remains capped at twenty', jsonb_array_length(v_result -> 'entries') = 20);
  perform pg_temp.monthly_assert('all top entries expose numeric total play time', not exists (select 1 from jsonb_array_elements(v_result -> 'entries') as entry where jsonb_typeof(entry -> 'playSeconds') is distinct from 'number'));
  perform pg_temp.monthly_assert('personal row outside top twenty includes total play time', (v_result #>> '{me,rank}')::integer > 20 and (v_result #>> '{me,playSeconds}')::numeric = 4.75);
  perform pg_temp.monthly_assert('monthly revenue still determines rank despite higher total play time', (v_result #>> '{me,score}')::numeric = 0 and not exists (select 1 from jsonb_array_elements(v_result -> 'entries') as entry where entry ->> 'nickname' = '월간 공장'));

  perform pg_temp.monthly_assert('monthly table enables RLS', (select relrowsecurity from pg_class where oid = 'public.factory_monthly_scores'::regclass));
  perform pg_temp.monthly_assert('anonymous role cannot insert total play time', not has_column_privilege('anon', 'public.factory_states', 'play_seconds', 'INSERT'));
  perform pg_temp.monthly_assert('anonymous role cannot update total play time', not has_column_privilege('anon', 'public.factory_states', 'play_seconds', 'UPDATE'));
  perform pg_temp.monthly_assert('authenticated role cannot insert total play time', not has_column_privilege('authenticated', 'public.factory_states', 'play_seconds', 'INSERT'));
  perform pg_temp.monthly_assert('authenticated role cannot update total play time', not has_column_privilege('authenticated', 'public.factory_states', 'play_seconds', 'UPDATE'));
  perform pg_temp.monthly_assert('anonymous role cannot read monthly rows', not has_table_privilege('anon', 'public.factory_monthly_scores', 'SELECT'));
  perform pg_temp.monthly_assert('authenticated role cannot write monthly rows', not has_table_privilege('authenticated', 'public.factory_monthly_scores', 'INSERT'));
  perform pg_temp.monthly_assert('anonymous role cannot call clock helper', not has_function_privilege('anon', 'public.factory_leaderboard_at(uuid,timestamp with time zone)', 'EXECUTE'));
  perform pg_temp.monthly_assert('authenticated role cannot commit monthly data', not has_function_privilege('authenticated', 'public.factory_commit_monthly(uuid,bigint,uuid,text,jsonb,numeric,text,jsonb,numeric,numeric,jsonb)', 'EXECUTE'));
  perform pg_temp.monthly_assert('server can commit monthly data', has_function_privilege('service_role', 'public.factory_commit_monthly(uuid,bigint,uuid,text,jsonb,numeric,text,jsonb,numeric,numeric,jsonb)', 'EXECUTE'));
  perform pg_temp.monthly_assert('new functions retain invoker security', not exists (select 1 from pg_proc where oid in ('public.factory_commit_monthly(uuid,bigint,uuid,text,jsonb,numeric,text,jsonb,numeric,numeric,jsonb)'::regprocedure, 'public.factory_leaderboard_at(uuid,timestamp with time zone)'::regprocedure) and prosecdef));
end $$;

select count(*) as passed, bool_and(passed) as all_passed from monthly_checks;
rollback;
