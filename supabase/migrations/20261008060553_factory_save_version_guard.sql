-- During deployment, an older Edge invocation can read a save already migrated
-- by a newer invocation. Revision CAS alone cannot detect that downgrade when
-- the older worker observed the current revision. Preserve the newer save.
create or replace function public.factory_commit(
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
  if jsonb_typeof(v_state.state -> 'version') = 'number' then
    if jsonb_typeof(p_state -> 'version') is distinct from 'number' then
      return jsonb_build_object('error', 'update_required');
    end if;
    if (p_state ->> 'version')::numeric < (v_state.state ->> 'version')::numeric then
      return jsonb_build_object('error', 'update_required');
    end if;
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

revoke all on function public.factory_commit(uuid, bigint, uuid, text, jsonb, numeric, text, jsonb, numeric, numeric) from public, anon, authenticated;
grant execute on function public.factory_commit(uuid, bigint, uuid, text, jsonb, numeric, text, jsonb, numeric, numeric) to service_role;
