-- Accurate live playtime starts at this update. Historical elapsed/monthly
-- seconds included offline simulation and cannot reconstruct active play.
-- Keep the counter outside game state so prestige and month changes preserve it.
alter table public.factory_states
  add column play_seconds numeric not null default 0
  check (play_seconds >= 0 and play_seconds < 'Infinity'::numeric);

create or replace function public.factory_commit_monthly(
  p_user_id uuid, p_expected_revision bigint, p_request_id uuid, p_hash text,
  p_state jsonb, p_score numeric, p_nickname text, p_results jsonb,
  p_offline_earned numeric, p_offline_seconds numeric, p_monthly jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_state public.factory_states%rowtype;
  v_request public.factory_requests%rowtype;
  v_result jsonb;
  v_delta jsonb;
  v_month date;
  v_revenue numeric;
  v_seconds numeric;
  v_total_revenue numeric := 0;
  v_total_seconds numeric := 0;
  v_lifetime_delta numeric;
begin
  select * into strict v_state from public.factory_states where user_id = p_user_id for update;
  v_result := jsonb_build_object('state', v_state.state, 'revision', v_state.revision, 'nickname', v_state.nickname);
  select * into v_request from public.factory_requests where user_id = p_user_id and request_id = p_request_id;
  if found then
    if v_request.payload_hash <> p_hash then return jsonb_build_object('error', 'request_id_reused'); end if;
    return v_result || jsonb_build_object('replayed', true, 'appliedRevision', v_request.applied_revision,
      'results', v_request.results, 'offlineEarned', v_request.offline_earned, 'offlineSeconds', v_request.offline_seconds);
  end if;
  if v_state.revision <> p_expected_revision then
    return v_result || jsonb_build_object('error', 'revision_conflict');
  end if;
  -- Current workers send only live active time. Refuse legacy offline accrual
  -- rather than count absent hours as playtime. Old receipts remain replayable.
  if p_offline_earned is distinct from 0 or p_offline_seconds is distinct from 0 then
    return jsonb_build_object('error', 'update_required');
  end if;
  if jsonb_typeof(p_state -> 'version') is distinct from 'number'
    or jsonb_typeof(p_state -> 'contentVersion') is distinct from 'number' then
    return jsonb_build_object('error', 'update_required');
  end if;
  if (p_state ->> 'contentVersion')::numeric < 2 then
    return jsonb_build_object('error', 'update_required');
  end if;
  if jsonb_typeof(v_state.state -> 'version') = 'number'
    and (p_state ->> 'version')::numeric < (v_state.state ->> 'version')::numeric then
    return jsonb_build_object('error', 'update_required');
  end if;
  if jsonb_typeof(v_state.state -> 'contentVersion') = 'number'
    and (p_state ->> 'contentVersion')::numeric < (v_state.state ->> 'contentVersion')::numeric then
    return jsonb_build_object('error', 'update_required');
  end if;
  -- At most 120 active seconds can cross one month boundary. Validate all
  -- deltas before changing state, lifetime playtime, or the monthly ledger.
  if jsonb_typeof(p_monthly) is distinct from 'array' then
    return jsonb_build_object('error', 'invalid_monthly');
  end if;
  if jsonb_array_length(p_monthly) > 2 then
    return jsonb_build_object('error', 'invalid_monthly');
  end if;
  for v_delta in select value from jsonb_array_elements(p_monthly) loop
    if jsonb_typeof(v_delta -> 'month') is distinct from 'string'
      or (v_delta ->> 'month') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-01$'
      or jsonb_typeof(v_delta -> 'revenue') is distinct from 'number'
      or jsonb_typeof(v_delta -> 'seconds') is distinct from 'number' then
      return jsonb_build_object('error', 'invalid_monthly');
    end if;
    v_month := (v_delta ->> 'month')::date;
    v_revenue := (v_delta ->> 'revenue')::numeric;
    v_seconds := (v_delta ->> 'seconds')::numeric;
    if not (v_revenue >= 0 and v_revenue < 'Infinity'::numeric
      and v_seconds >= 0 and v_seconds <= 120.000001) then
      return jsonb_build_object('error', 'invalid_monthly');
    end if;
    v_total_revenue := v_total_revenue + v_revenue;
    v_total_seconds := v_total_seconds + v_seconds;
  end loop;
  if jsonb_typeof(p_state -> 'lifetimeRevenue') is distinct from 'number' then
    return jsonb_build_object('error', 'invalid_monthly');
  end if;
  v_lifetime_delta := (p_state ->> 'lifetimeRevenue')::numeric
    - coalesce((v_state.state ->> 'lifetimeRevenue')::numeric, 0);
  -- JavaScript sums are floating point; retain fractions without requiring the
  -- text encodings of two arithmetically equivalent sums to match bit for bit.
  if v_total_seconds > 120.000001 or v_lifetime_delta < -0.000001
    or abs(v_total_revenue - v_lifetime_delta)
      > greatest(0.000001, abs((p_state ->> 'lifetimeRevenue')::numeric) * 0.000000000001) then
    return jsonb_build_object('error', 'invalid_monthly');
  end if;
  update public.factory_states set state = p_state, revision = revision + 1, score = p_score,
    nickname = p_nickname, play_seconds = play_seconds + v_total_seconds, updated_at = clock_timestamp()
  where user_id = p_user_id returning * into v_state;
  for v_delta in select value from jsonb_array_elements(p_monthly) loop
    insert into public.factory_monthly_scores as monthly (user_id, month, revenue, seconds)
    values (p_user_id, (v_delta ->> 'month')::date,
      (v_delta ->> 'revenue')::numeric, (v_delta ->> 'seconds')::numeric)
    on conflict (user_id, month) do update set
      revenue = monthly.revenue + excluded.revenue,
      seconds = monthly.seconds + excluded.seconds;
  end loop;
  insert into public.factory_requests(user_id, request_id, payload_hash, applied_revision, results, offline_earned, offline_seconds)
  values (p_user_id, p_request_id, p_hash, v_state.revision, p_results, p_offline_earned, p_offline_seconds);
  delete from public.factory_requests where user_id = p_user_id and created_at < now() - interval '7 days';
  return jsonb_build_object('state', v_state.state, 'revision', v_state.revision, 'nickname', v_state.nickname,
    'results', p_results, 'offlineEarned', p_offline_earned, 'offlineSeconds', p_offline_seconds);
end $$;

create or replace function public.factory_leaderboard_at(p_user_id uuid, p_now timestamptz)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with season as (
    select date_trunc('month', p_now at time zone 'Asia/Seoul') as month_start
  ), scores as (
    select factories.user_id, factories.nickname, factories.play_seconds, floor(coalesce(monthly.revenue, 0)) as score,
      case when monthly.seconds > 0 then monthly.revenue / monthly.seconds else 0 end as gold_per_second
    from public.factory_states as factories
    cross join season
    left join public.factory_monthly_scores as monthly
      on monthly.user_id = factories.user_id and monthly.month = season.month_start::date
  ), ranked as (
    select *, rank() over (order by score desc) as place from scores
  ), top_entries as (
    select * from ranked order by score desc, user_id limit 20
  )
  select jsonb_build_object(
    'month', to_char(season.month_start, 'YYYY-MM'),
    'timezone', 'Asia/Seoul',
    'resetsAt', to_char(((season.month_start + interval '1 month') at time zone 'Asia/Seoul')
      at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('rank', place, 'nickname', nickname,
      'score', score, 'goldPerSecond', gold_per_second, 'playSeconds', play_seconds) order by score desc, user_id)
      from top_entries), '[]'::jsonb),
    'me', (select jsonb_build_object('rank', place, 'nickname', nickname, 'score', score,
      'goldPerSecond', gold_per_second, 'playSeconds', play_seconds) from ranked where user_id = p_user_id)
  ) from season;
$$;

revoke all on function public.factory_commit_monthly(uuid, bigint, uuid, text, jsonb, numeric, text, jsonb, numeric, numeric, jsonb) from public, anon, authenticated;
revoke all on function public.factory_leaderboard_at(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.factory_commit_monthly(uuid, bigint, uuid, text, jsonb, numeric, text, jsonb, numeric, numeric, jsonb) to service_role;
grant execute on function public.factory_leaderboard_at(uuid, timestamptz) to service_role;
