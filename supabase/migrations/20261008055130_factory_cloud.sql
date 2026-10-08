-- Only Edge Functions, using server credentials, may call these RPCs or access
-- game data. Clients never write state or leaderboard scores directly.
create table public.factory_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  revision bigint not null default 0 check (revision >= 0),
  nickname text not null check (char_length(nickname) between 2 and 20),
  score numeric not null default 0 check (score >= 0 and score < 'Infinity'::numeric),
  updated_at timestamptz not null default now()
);
create index factory_states_score_idx on public.factory_states (score desc, user_id);

create table public.factory_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  payload_hash text not null,
  applied_revision bigint not null,
  results jsonb not null,
  offline_earned numeric not null,
  offline_seconds numeric not null,
  created_at timestamptz not null default now(),
  primary key (user_id, request_id)
);
create index factory_requests_expiry_idx on public.factory_requests (user_id, created_at);

create table public.factory_request_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null,
  window_start timestamptz not null,
  hits integer not null,
  primary key (user_id, scope)
);

alter table public.factory_states enable row level security;
alter table public.factory_requests enable row level security;
alter table public.factory_request_limits enable row level security;
revoke all on public.factory_states, public.factory_requests, public.factory_request_limits from public, anon, authenticated;
grant all on public.factory_states, public.factory_requests, public.factory_request_limits to service_role;

create function public.factory_admit(p_user_id uuid, p_scope text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_hits integer; v_limit integer; v_window timestamptz := date_trunc('minute', clock_timestamp());
begin
  v_limit := case p_scope when 'sync' then 120 when 'leaderboard' then 30 else 0 end;
  if v_limit = 0 then return false; end if;
  insert into public.factory_request_limits as limits (user_id, scope, window_start, hits)
  values (p_user_id, p_scope, v_window, 1)
  on conflict (user_id, scope) do update set
    hits = case when limits.window_start = v_window then least(limits.hits + 1, 1000000) else 1 end,
    window_start = v_window
  returning hits into v_hits;
  return v_hits <= v_limit;
end $$;

create function public.factory_prepare(p_user_id uuid, p_initial_state jsonb, p_request_id uuid, p_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_state public.factory_states%rowtype; v_request public.factory_requests%rowtype; v_result jsonb;
begin
  insert into public.factory_states (user_id, state, nickname)
  values (p_user_id, p_initial_state, '공장-' || left(p_user_id::text, 8))
  on conflict (user_id) do nothing;
  -- Keep the read coherent with a concurrent commit: row lock also serializes
  -- request lookup with the state/revision returned for an idempotent replay.
  select * into strict v_state from public.factory_states where user_id = p_user_id for update;
  v_result := jsonb_build_object('state', v_state.state, 'revision', v_state.revision, 'nickname', v_state.nickname);
  select * into v_request from public.factory_requests where user_id = p_user_id and request_id = p_request_id;
  if found then
    if v_request.payload_hash <> p_hash then return jsonb_build_object('error', 'request_id_reused'); end if;
    return v_result || jsonb_build_object('replayed', true, 'appliedRevision', v_request.applied_revision,
      'results', v_request.results, 'offlineEarned', v_request.offline_earned, 'offlineSeconds', v_request.offline_seconds);
  end if;
  return v_result;
end $$;

create function public.factory_commit(
  p_user_id uuid, p_expected_revision bigint, p_request_id uuid, p_hash text,
  p_state jsonb, p_score numeric, p_nickname text, p_results jsonb,
  p_offline_earned numeric, p_offline_seconds numeric
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_state public.factory_states%rowtype; v_request public.factory_requests%rowtype; v_result jsonb;
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
  update public.factory_states set state = p_state, revision = revision + 1, score = p_score,
    nickname = p_nickname, updated_at = clock_timestamp()
  where user_id = p_user_id returning * into v_state;
  insert into public.factory_requests(user_id, request_id, payload_hash, applied_revision, results, offline_earned, offline_seconds)
  values (p_user_id, p_request_id, p_hash, v_state.revision, p_results, p_offline_earned, p_offline_seconds);
  -- Store only compact receipts (never a full snapshot per request). After seven
  -- days an old economic request still cannot repeat: its revision is stale.
  delete from public.factory_requests where user_id = p_user_id and created_at < now() - interval '7 days';
  return jsonb_build_object('state', v_state.state, 'revision', v_state.revision, 'nickname', v_state.nickname,
    'results', p_results, 'offlineEarned', p_offline_earned, 'offlineSeconds', p_offline_seconds);
end $$;

create function public.factory_leaderboard(p_user_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with ranked as (
    select user_id, nickname, score, rank() over (order by score desc) as place
    from public.factory_states
  ), top_entries as (
    select nickname, score, place, user_id from ranked order by score desc, user_id limit 20
  )
  select jsonb_build_object(
    'entries', coalesce((select jsonb_agg(jsonb_build_object('rank', place, 'nickname', nickname, 'score', score)
      order by score desc, user_id) from top_entries), '[]'::jsonb),
    'me', (select jsonb_build_object('rank', place, 'nickname', nickname, 'score', score) from ranked where user_id = p_user_id)
  );
$$;

revoke all on function public.factory_admit(uuid, text) from public, anon, authenticated;
revoke all on function public.factory_prepare(uuid, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.factory_commit(uuid, bigint, uuid, text, jsonb, numeric, text, jsonb, numeric, numeric) from public, anon, authenticated;
revoke all on function public.factory_leaderboard(uuid) from public, anon, authenticated;
grant execute on function public.factory_admit(uuid, text) to service_role;
grant execute on function public.factory_prepare(uuid, jsonb, uuid, text) to service_role;
grant execute on function public.factory_commit(uuid, bigint, uuid, text, jsonb, numeric, text, jsonb, numeric, numeric) to service_role;
grant execute on function public.factory_leaderboard(uuid) to service_role;
