-- Meals API (plan B7): atomic write functions for POST/PATCH/DELETE /api/meals, undo, history search,
-- and the purge job.
--
-- Why functions: PostgREST runs each request in its own transaction, so a meal, its items, its revision
-- row and its idempotency key could not be written atomically from route code. These functions do each
-- write in one transaction.
--
-- Security
--   * Every user-facing function is SECURITY INVOKER: it runs as the caller, so RLS from 0001 applies
--     and the user id always comes from auth.uid(), never from an argument.
--   * purge_expired() is callable by service_role only (the cron route).
--   * Helpers live in the `private` schema, which PostgREST does not expose.
--
-- Nutrition math is NOT done here: the route recalculates items and totals with src/lib/nutrition/calc.ts
-- and passes the results in. These functions only store them.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- How long a deleted meal can be restored. Mirrors UNDO_WINDOW_MS in src/lib/database/meals.ts.
create function private.meal_undo_window()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '10 seconds' $$;

-- A meal and its items as jsonb, for meal_revisions.previous_values / updated_values.
create function private.meal_snapshot(p_meal_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'name', m.name,
    'consumed_at', m.consumed_at,
    'source_type', m.source_type,
    'status', m.status,
    'version', m.version,
    'totals', jsonb_build_object(
      'calories', m.total_calories,
      'protein_g', m.total_protein_g,
      'carbs_g', m.total_carbs_g,
      'fat_g', m.total_fat_g
    ),
    'items', coalesce(
      (select jsonb_agg(to_jsonb(mi) - 'meal_id' - 'created_at' - 'updated_at' order by mi.position, mi.id)
       from public.meal_items mi
       where mi.meal_id = m.id),
      '[]'::jsonb
    )
  )
  from public.meals m
  where m.id = p_meal_id;
$$;

-- Inserts one item given in the API's MealItem shape (macros nested under "macros").
create function private.insert_meal_item(p_meal_id uuid, p_position int, p_item jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.meal_items (
    meal_id, position, food_name, quantity, unit, grams, basis_per_100g,
    calories, protein_g, carbs_g, fat_g,
    nutrition_source, source_reference, inferred, confidence, edited_by_user, assumptions
  ) values (
    p_meal_id,
    p_position,
    p_item ->> 'food_name',
    (p_item ->> 'quantity')::numeric,
    p_item ->> 'unit',
    (p_item ->> 'grams')::numeric,
    nullif(p_item -> 'basis_per_100g', 'null'::jsonb),
    (p_item -> 'macros' ->> 'calories')::numeric,
    (p_item -> 'macros' ->> 'protein_g')::numeric,
    (p_item -> 'macros' ->> 'carbs_g')::numeric,
    (p_item -> 'macros' ->> 'fat_g')::numeric,
    p_item ->> 'nutrition_source',
    p_item ->> 'source_reference',
    coalesce((p_item ->> 'inferred')::boolean, false),
    p_item ->> 'confidence',
    coalesce((p_item ->> 'edited_by_user')::boolean, false),
    p_item ->> 'assumptions'
  );
$$;

revoke all on function private.meal_undo_window() from public;
revoke all on function private.meal_snapshot(uuid) from public;
revoke all on function private.insert_meal_item(uuid, int, jsonb) from public;
grant execute on function private.meal_undo_window() to authenticated, service_role;
grant execute on function private.meal_snapshot(uuid) to authenticated, service_role;
grant execute on function private.insert_meal_item(uuid, int, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- POST /api/meals
-- ---------------------------------------------------------------------------
-- p_meals: [{ name, consumed_at, source_type, totals: Macros, items: MealItem-without-id[] }]
-- Returns { replayed: boolean, response: { meal_ids: uuid[] } }.
--
-- The idempotency row is written in the same transaction as the meals, so a retry can never create a
-- second copy. Concurrent requests with the same key are serialized by an advisory lock; the second one
-- waits, then finds the first one's row and replays it.

create function public.save_meals(p_idempotency_key text, p_meals jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_existing jsonb;
  v_meal jsonb;
  v_item jsonb;
  v_ord bigint;
  v_meal_id uuid;
  v_ids uuid[] := '{}';
  v_response jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_meals) is distinct from 'array' or jsonb_array_length(p_meals) = 0 then
    raise exception 'p_meals must be a non-empty array' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_idempotency_key, 0));

  select k.response into v_existing
  from public.idempotency_keys k
  where k.user_id = v_uid and k.key = p_idempotency_key;
  if found then
    return jsonb_build_object('replayed', true, 'response', v_existing);
  end if;

  for v_meal in select value from jsonb_array_elements(p_meals) loop
    insert into public.meals (
      user_id, name, consumed_at, source_type,
      total_calories, total_protein_g, total_carbs_g, total_fat_g
    ) values (
      v_uid,
      v_meal ->> 'name',
      (v_meal ->> 'consumed_at')::timestamptz,
      v_meal ->> 'source_type',
      (v_meal -> 'totals' ->> 'calories')::numeric,
      (v_meal -> 'totals' ->> 'protein_g')::numeric,
      (v_meal -> 'totals' ->> 'carbs_g')::numeric,
      (v_meal -> 'totals' ->> 'fat_g')::numeric
    )
    returning id into v_meal_id;

    for v_item, v_ord in select value, ordinality from jsonb_array_elements(v_meal -> 'items') with ordinality loop
      perform private.insert_meal_item(v_meal_id, (v_ord - 1)::int, v_item);
    end loop;

    insert into public.meal_revisions (meal_id, user_id, previous_values, updated_values, reason)
    values (v_meal_id, v_uid, null, private.meal_snapshot(v_meal_id), 'created');

    v_ids := v_ids || v_meal_id;
  end loop;

  v_response := jsonb_build_object('meal_ids', to_jsonb(v_ids));
  insert into public.idempotency_keys (user_id, key, response) values (v_uid, p_idempotency_key, v_response);

  return jsonb_build_object('replayed', false, 'response', v_response);
end;
$$;

-- ---------------------------------------------------------------------------
-- PATCH /api/meals/:id
-- ---------------------------------------------------------------------------
-- Null arguments mean "unchanged". When p_items is given it replaces the item list: items with an id
-- are updated in place, items without one are inserted, and existing items not listed are deleted.
-- p_totals must be given together with p_items.
-- Returns { status: "ok", version } | { status: "not_found" } | { status: "version_conflict", version }
--       | { status: "invalid_item" } (an item id that isn't on this meal, or listed twice).

create function public.update_meal(
  p_meal_id uuid,
  p_version int,
  p_name text default null,
  p_consumed_at timestamptz default null,
  p_items jsonb default null,
  p_totals jsonb default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_meal public.meals%rowtype;
  v_previous jsonb;
  v_keep uuid[];
  v_item jsonb;
  v_ord bigint;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if (p_items is null) <> (p_totals is null) then
    raise exception 'p_items and p_totals go together' using errcode = '22023';
  end if;

  select * into v_meal from public.meals m where m.id = p_meal_id and m.user_id = v_uid for update;
  if not found or v_meal.status <> 'active' then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_meal.version <> p_version then
    return jsonb_build_object('status', 'version_conflict', 'version', v_meal.version);
  end if;

  if p_items is not null then
    select coalesce(array_agg((i ->> 'id')::uuid), '{}') into v_keep
    from jsonb_array_elements(p_items) i
    where i ->> 'id' is not null;

    if cardinality(v_keep) <> (select count(distinct k) from unnest(v_keep) k)
       or exists (
         select 1 from unnest(v_keep) k
         where not exists (select 1 from public.meal_items mi where mi.meal_id = p_meal_id and mi.id = k)
       ) then
      return jsonb_build_object('status', 'invalid_item');
    end if;
  end if;

  v_previous := private.meal_snapshot(p_meal_id);

  update public.meals set
    name = coalesce(p_name, name),
    consumed_at = coalesce(p_consumed_at, consumed_at),
    total_calories = coalesce((p_totals ->> 'calories')::numeric, total_calories),
    total_protein_g = coalesce((p_totals ->> 'protein_g')::numeric, total_protein_g),
    total_carbs_g = coalesce((p_totals ->> 'carbs_g')::numeric, total_carbs_g),
    total_fat_g = coalesce((p_totals ->> 'fat_g')::numeric, total_fat_g),
    version = version + 1
  where id = p_meal_id;

  if p_items is not null then
    delete from public.meal_items mi where mi.meal_id = p_meal_id and mi.id <> all (v_keep);

    for v_item, v_ord in select value, ordinality from jsonb_array_elements(p_items) with ordinality loop
      if v_item ->> 'id' is null then
        perform private.insert_meal_item(p_meal_id, (v_ord - 1)::int, v_item);
      else
        update public.meal_items set
          position = (v_ord - 1)::int,
          food_name = v_item ->> 'food_name',
          quantity = (v_item ->> 'quantity')::numeric,
          unit = v_item ->> 'unit',
          grams = (v_item ->> 'grams')::numeric,
          basis_per_100g = nullif(v_item -> 'basis_per_100g', 'null'::jsonb),
          calories = (v_item -> 'macros' ->> 'calories')::numeric,
          protein_g = (v_item -> 'macros' ->> 'protein_g')::numeric,
          carbs_g = (v_item -> 'macros' ->> 'carbs_g')::numeric,
          fat_g = (v_item -> 'macros' ->> 'fat_g')::numeric,
          nutrition_source = v_item ->> 'nutrition_source',
          source_reference = v_item ->> 'source_reference',
          inferred = coalesce((v_item ->> 'inferred')::boolean, false),
          confidence = v_item ->> 'confidence',
          edited_by_user = coalesce((v_item ->> 'edited_by_user')::boolean, false),
          assumptions = v_item ->> 'assumptions'
        where id = (v_item ->> 'id')::uuid and meal_id = p_meal_id;
      end if;
    end loop;
  end if;

  insert into public.meal_revisions (meal_id, user_id, previous_values, updated_values, reason)
  values (p_meal_id, v_uid, v_previous, private.meal_snapshot(p_meal_id), 'updated');

  return jsonb_build_object('status', 'ok', 'version', v_meal.version + 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- DELETE /api/meals/:id and POST /api/meals/:id/undo
-- ---------------------------------------------------------------------------
-- Soft delete: the meal stops counting at once (every read filters status = 'active') and is
-- hard-deleted by purge_expired() once the undo window has passed. Both bump version.

create function public.delete_meal(p_meal_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_deleted_at timestamptz;
  v_consumed_at timestamptz;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  update public.meals
  set status = 'pending_deletion', deleted_at = now(), version = version + 1
  where id = p_meal_id and user_id = v_uid and status = 'active'
  returning deleted_at, consumed_at into v_deleted_at, v_consumed_at;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  insert into public.meal_revisions (meal_id, user_id, previous_values, updated_values, reason)
  values (p_meal_id, v_uid, jsonb_build_object('status', 'active'),
          jsonb_build_object('status', 'pending_deletion', 'deleted_at', v_deleted_at), 'deleted');

  return jsonb_build_object(
    'status', 'ok',
    'undo_until', v_deleted_at + private.meal_undo_window(),
    'consumed_at', v_consumed_at
  );
end;
$$;

create function public.restore_meal(p_meal_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_version int;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  update public.meals
  set status = 'active', deleted_at = null, version = version + 1
  where id = p_meal_id
    and user_id = v_uid
    and status = 'pending_deletion'
    and deleted_at > now() - private.meal_undo_window()
  returning version into v_version;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  insert into public.meal_revisions (meal_id, user_id, previous_values, updated_values, reason)
  values (p_meal_id, v_uid, jsonb_build_object('status', 'pending_deletion'),
          jsonb_build_object('status', 'active'), 'restored');

  return jsonb_build_object('status', 'ok', 'version', v_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- GET /api/meals
-- ---------------------------------------------------------------------------
-- Active meals, newest consumed first, keyset-paginated on (consumed_at, id). p_to is exclusive.
-- p_q matches the meal name or any item name (case-insensitive substring; uses the trigram indexes).

create function public.list_meals(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_q text default null,
  p_cursor_consumed_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit int default 30
)
returns setof public.meals
language sql
stable
security invoker
set search_path = ''
as $$
  with pattern as (
    select '%' || replace(replace(replace(p_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  )
  select m.*
  from public.meals m, pattern
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and (p_from is null or m.consumed_at >= p_from)
    and (p_to is null or m.consumed_at < p_to)
    and (p_cursor_consumed_at is null or (m.consumed_at, m.id) < (p_cursor_consumed_at, p_cursor_id))
    and (
      p_q is null
      or m.name ilike pattern.pat
      or exists (
        select 1 from public.meal_items mi
        where mi.meal_id = m.id and mi.food_name ilike pattern.pat
      )
    )
  order by m.consumed_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 101);
$$;

-- ---------------------------------------------------------------------------
-- Purge job (service role only; /api/cron/purge)
-- ---------------------------------------------------------------------------
-- Hard-deletes meals past their undo window (items and revisions cascade), idempotency keys older than
-- 24 h, and expired temporary_uploads rows. Photo storage is never enabled (FR-15), so there are no
-- storage objects behind temporary_uploads to remove.

create function public.purge_expired()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_meals int;
  v_keys int;
  v_uploads int;
begin
  delete from public.meals
  where status = 'pending_deletion' and deleted_at <= now() - private.meal_undo_window();
  get diagnostics v_meals = row_count;

  delete from public.idempotency_keys where created_at < now() - interval '24 hours';
  get diagnostics v_keys = row_count;

  delete from public.temporary_uploads where expires_at < now();
  get diagnostics v_uploads = row_count;

  return jsonb_build_object('meals', v_meals, 'idempotency_keys', v_keys, 'temporary_uploads', v_uploads);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.save_meals(text, jsonb) from public, anon;
revoke all on function public.update_meal(uuid, int, text, timestamptz, jsonb, jsonb) from public, anon;
revoke all on function public.delete_meal(uuid) from public, anon;
revoke all on function public.restore_meal(uuid) from public, anon;
revoke all on function public.list_meals(timestamptz, timestamptz, text, timestamptz, uuid, int) from public, anon;
revoke all on function public.purge_expired() from public, anon, authenticated;

grant execute on function public.save_meals(text, jsonb) to authenticated;
grant execute on function public.update_meal(uuid, int, text, timestamptz, jsonb, jsonb) to authenticated;
grant execute on function public.delete_meal(uuid) to authenticated;
grant execute on function public.restore_meal(uuid) to authenticated;
grant execute on function public.list_meals(timestamptz, timestamptz, text, timestamptz, uuid, int) to authenticated;
grant execute on function public.purge_expired() to service_role;
