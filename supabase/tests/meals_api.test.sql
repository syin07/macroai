-- Tests for the meals API functions in 0002_meals_api.sql. Run with `supabase test db`.
--
-- Users (ids differ from rls.test.sql so the two files never contend for the same rows)
--   A  b7a00000-...-00000000000a  approved
--   B  b7b00000-...-00000000000b  approved (must never reach A's meals)
--   C  b7c00000-...-00000000000c  confirmed but NOT on the allow-list
--
-- now() is fixed for the whole transaction, so "the undo window has passed" is simulated by moving
-- deleted_at back as postgres. Values carried between steps live in transaction-local settings (t.*).
-- Everything runs in one transaction and is rolled back.

begin;

create extension if not exists pgtap with schema extensions;

select plan(57);

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------

insert into public.approved_emails (email) values ('b7a@meals.test'), ('b7b@meals.test');

insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'b7a00000-0000-4000-8000-00000000000a',
   'authenticated', 'authenticated', 'b7a@meals.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b7b00000-0000-4000-8000-00000000000b',
   'authenticated', 'authenticated', 'b7b@meals.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b7c00000-0000-4000-8000-00000000000c',
   'authenticated', 'authenticated', 'b7c@meals.test', '', now(), '{}', '{}', now(), now());

create function public._meals_as(uid uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- A two-item meal in the shape the route sends (items and totals already recalculated).
create function public._meals_payload(meal_name text, consumed timestamptz)
returns jsonb
language sql
as $$
  select jsonb_build_array(jsonb_build_object(
    'name', meal_name,
    'consumed_at', consumed,
    'source_type', 'text',
    'totals', '{"calories": 366.833, "protein_g": 46.5, "carbs_g": 0, "fat_g": 18.9}'::jsonb,
    'items', '[
      {"food_name": "grilled chicken", "quantity": 150, "unit": "g", "grams": 150,
       "basis_per_100g": {"calories": 165, "protein_g": 31, "carbs_g": 0, "fat_g": 3.6},
       "macros": {"calories": 247.5, "protein_g": 46.5, "carbs_g": 0, "fat_g": 5.4},
       "nutrition_source": "usda", "source_reference": "171534", "inferred": false,
       "confidence": null, "edited_by_user": false, "assumptions": null},
      {"food_name": "olive oil 100%", "quantity": 1, "unit": "tbsp", "grams": null, "basis_per_100g": null,
       "macros": {"calories": 119.333, "protein_g": 0, "carbs_g": 0, "fat_g": 13.5},
       "nutrition_source": "ai", "source_reference": null, "inferred": true,
       "confidence": "low", "edited_by_user": false, "assumptions": "cooking oil"}
    ]'::jsonb
  ));
$$;

grant execute on function public._meals_as(uuid) to authenticated;
grant execute on function public._meals_payload(text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. save_meals (12)
-- ---------------------------------------------------------------------------

select public._meals_as('b7a00000-0000-4000-8000-00000000000a');

select set_config('t.first',
  public.save_meals('7d0c1d3e-0000-4000-8000-000000000001', public._meals_payload('Lunch', '2026-10-26T19:30:00Z'))::text,
  true);
select set_config('t.meal', (current_setting('t.first')::jsonb -> 'response' -> 'meal_ids' ->> 0), true);

select is((current_setting('t.first')::jsonb ->> 'replayed')::boolean, false, 'save: first call is not a replay');
select is((select count(*)::int from public.meals where user_id = 'b7a00000-0000-4000-8000-00000000000a'), 1,
  'save: one meal stored');
select is((select user_id from public.meals where id = current_setting('t.meal')::uuid),
  'b7a00000-0000-4000-8000-00000000000a'::uuid, 'save: user_id comes from auth.uid()');
select is((select total_calories from public.meals where id = current_setting('t.meal')::uuid), 366.833,
  'save: totals stored as given (unrounded beyond numeric(10,3))');
select results_eq(
  format('select food_name, position from public.meal_items where meal_id = %L order by position', current_setting('t.meal')),
  $$ values ('grilled chicken'::text, 0), ('olive oil 100%'::text, 1) $$,
  'save: items stored in order with positions');
select is((select basis_per_100g is null from public.meal_items
           where meal_id = current_setting('t.meal')::uuid and position = 1), true,
  'save: JSON null basis becomes SQL null');
select is((select reason || ':' || (previous_values is null)::text from public.meal_revisions
           where meal_id = current_setting('t.meal')::uuid), 'created:true',
  'save: one revision with reason created and no previous values');
select is((select updated_values -> 'items' -> 0 ->> 'food_name' from public.meal_revisions
           where meal_id = current_setting('t.meal')::uuid), 'grilled chicken',
  'save: revision snapshot includes the items');
select is((select response from public.idempotency_keys where key = '7d0c1d3e-0000-4000-8000-000000000001'),
  current_setting('t.first')::jsonb -> 'response', 'save: response stored under the idempotency key');

-- Same key again: nothing new is written, the first meal ids come back.
select set_config('t.second',
  public.save_meals('7d0c1d3e-0000-4000-8000-000000000001', public._meals_payload('Lunch', '2026-10-26T19:30:00Z'))::text,
  true);
select is((current_setting('t.second')::jsonb ->> 'replayed')::boolean, true, 'save: repeat key is a replay');
select is(current_setting('t.second')::jsonb -> 'response', current_setting('t.first')::jsonb -> 'response',
  'save: replay returns the first meal ids');
select is((select count(*)::int from public.meals where user_id = 'b7a00000-0000-4000-8000-00000000000a'), 1,
  'save: replay writes no second meal');

-- ---------------------------------------------------------------------------
-- 2. Idempotency keys are per user (2)
-- ---------------------------------------------------------------------------

reset role;
select public._meals_as('b7b00000-0000-4000-8000-00000000000b');

select set_config('t.b_save',
  public.save_meals('7d0c1d3e-0000-4000-8000-000000000001', public._meals_payload('B dinner', '2026-10-26T19:30:00Z'))::text,
  true);
select set_config('t.b_meal', (current_setting('t.b_save')::jsonb -> 'response' -> 'meal_ids' ->> 0), true);
select is((current_setting('t.b_save')::jsonb ->> 'replayed')::boolean, false,
  'per-user keys: B reusing A''s key saves B''s own meal');
select isnt(current_setting('t.b_meal'), current_setting('t.meal'), 'per-user keys: B never receives A''s meal id');

-- ---------------------------------------------------------------------------
-- 3. Cross-user access (6)
-- ---------------------------------------------------------------------------

select is(public.update_meal(current_setting('t.meal')::uuid, 1, 'hijack') ->> 'status', 'not_found',
  'cross-user: B cannot update A''s meal');
select is(public.delete_meal(current_setting('t.meal')::uuid) ->> 'status', 'not_found',
  'cross-user: B cannot delete A''s meal');
select is(public.restore_meal(current_setting('t.meal')::uuid) ->> 'status', 'not_found',
  'cross-user: B cannot restore A''s meal');
select is_empty(format('select 1 from public.list_meals() where id = %L', current_setting('t.meal')),
  'cross-user: list_meals never shows A''s meal to B');

-- B's item id can't be smuggled into A's meal.
select set_config('t.b_item',
  (select id::text from public.meal_items where meal_id = current_setting('t.b_meal')::uuid and position = 0), true);

reset role;
select is((select name from public.meals where id = current_setting('t.meal')::uuid), 'Lunch',
  'cross-user: A''s meal is unchanged');
select is((select status from public.meals where id = current_setting('t.meal')::uuid), 'active',
  'cross-user: A''s meal is still active');

-- ---------------------------------------------------------------------------
-- 4. update_meal (13)
-- ---------------------------------------------------------------------------

select public._meals_as('b7a00000-0000-4000-8000-00000000000a');

select is(public.update_meal(current_setting('t.meal')::uuid, 7, 'Stale') ->> 'status', 'version_conflict',
  'update: stale version is a conflict');
select is((select name || ':' || version from public.meals where id = current_setting('t.meal')::uuid), 'Lunch:1',
  'update: a conflict changes nothing');

select is(
  public.update_meal(current_setting('t.meal')::uuid, 1, null, null,
    jsonb_build_array(jsonb_build_object('id', current_setting('t.b_item'), 'food_name', 'x', 'quantity', 1,
      'unit', 'g', 'grams', 1, 'basis_per_100g', null,
      'macros', '{"calories": 1, "protein_g": 0, "carbs_g": 0, "fat_g": 0}'::jsonb,
      'nutrition_source', 'manual', 'source_reference', null, 'inferred', false, 'confidence', null,
      'edited_by_user', true, 'assumptions', null)),
    '{"calories": 1, "protein_g": 0, "carbs_g": 0, "fat_g": 0}'::jsonb) ->> 'status',
  'invalid_item', 'update: an item id from another meal is rejected');
select is((select count(*)::int from public.meal_items where meal_id = current_setting('t.meal')::uuid), 2,
  'update: a rejected item list changes nothing');

-- Keep the chicken (now 200 g), drop the oil, add rice; move the meal to the next day.
select set_config('t.chicken',
  (select id::text from public.meal_items where meal_id = current_setting('t.meal')::uuid and position = 0), true);
select set_config('t.update',
  public.update_meal(
    current_setting('t.meal')::uuid, 1, 'Late lunch', '2026-10-27T08:00:00Z',
    jsonb_build_array(
      jsonb_build_object('id', current_setting('t.chicken'), 'food_name', 'grilled chicken', 'quantity', 200,
        'unit', 'g', 'grams', 200, 'basis_per_100g', '{"calories": 165, "protein_g": 31, "carbs_g": 0, "fat_g": 3.6}'::jsonb,
        'macros', '{"calories": 330, "protein_g": 62, "carbs_g": 0, "fat_g": 7.2}'::jsonb,
        'nutrition_source', 'usda', 'source_reference', '171534', 'inferred', false, 'confidence', null,
        'edited_by_user', true, 'assumptions', null),
      jsonb_build_object('id', null, 'food_name', 'white rice', 'quantity', 1, 'unit', 'cup', 'grams', 158,
        'basis_per_100g', '{"calories": 130, "protein_g": 2.7, "carbs_g": 28, "fat_g": 0.3}'::jsonb,
        'macros', '{"calories": 205.4, "protein_g": 4.266, "carbs_g": 44.24, "fat_g": 0.474}'::jsonb,
        'nutrition_source', 'usda', 'source_reference', '168930', 'inferred', false, 'confidence', null,
        'edited_by_user', true, 'assumptions', null)),
    '{"calories": 535.4, "protein_g": 66.266, "carbs_g": 44.24, "fat_g": 7.674}'::jsonb)::text,
  true);

select is(current_setting('t.update')::jsonb, '{"status": "ok", "version": 2}'::jsonb, 'update: ok with the new version');
select results_eq(
  format('select name, consumed_at, version, total_calories from public.meals where id = %L', current_setting('t.meal')),
  $$ values ('Late lunch'::text, '2026-10-27T08:00:00Z'::timestamptz, 2, 535.4::numeric) $$,
  'update: name, time, version and totals updated');
select results_eq(
  format('select id::text, food_name, position, edited_by_user from public.meal_items where meal_id = %L order by position',
         current_setting('t.meal')),
  format($$ values (%L, 'grilled chicken'::text, 0, true), ((select id::text from public.meal_items
           where meal_id = %L and food_name = 'white rice'), 'white rice'::text, 1, true) $$,
         current_setting('t.chicken'), current_setting('t.meal')),
  'update: kept item updated in place, missing item deleted, new item inserted');
select is((select grams from public.meal_items where id = current_setting('t.chicken')::uuid), 200::numeric,
  'update: kept item has the new grams');
select is((select count(*)::int from public.meal_revisions
           where meal_id = current_setting('t.meal')::uuid and reason = 'updated'), 1,
  'update: one revision with reason updated');
select is((select previous_values ->> 'name' || ' -> ' || (updated_values ->> 'name') from public.meal_revisions
           where meal_id = current_setting('t.meal')::uuid and reason = 'updated'), 'Lunch -> Late lunch',
  'update: revision records previous and updated values');
select is(public.update_meal(current_setting('t.meal')::uuid, 1, 'Again') ->> 'status', 'version_conflict',
  'update: the old version is stale after an update');

-- Name-only update leaves items and totals alone.
select is(public.update_meal(current_setting('t.meal')::uuid, 2, 'Lunch (late)') ->> 'version', '3',
  'update: name-only update bumps the version');
select is((select total_calories from public.meals where id = current_setting('t.meal')::uuid), 535.4::numeric,
  'update: name-only update keeps totals');

-- ---------------------------------------------------------------------------
-- 5. list_meals (7)
-- ---------------------------------------------------------------------------

select public.save_meals('7d0c1d3e-0000-4000-8000-000000000002', public._meals_payload('Breakfast', '2026-10-27T08:00:00Z'));
select public.save_meals('7d0c1d3e-0000-4000-8000-000000000003', public._meals_payload('Snack_bar', '2026-10-25T20:00:00Z'));

select is((select count(*)::int from public.list_meals()), 3, 'list: all of A''s active meals');
select results_eq(
  'select name from public.list_meals()',
  $$ select name from public.meals where user_id = 'b7a00000-0000-4000-8000-00000000000a'
     order by consumed_at desc, id desc $$,
  'list: newest consumed first, ties broken by id');
select results_eq(
  $$ select l.name from (select consumed_at, id from public.list_meals(p_limit => 1)) m,
       lateral public.list_meals(p_cursor_consumed_at => m.consumed_at, p_cursor_id => m.id, p_limit => 10) l $$,
  $$ select name from public.list_meals() offset 1 $$,
  'list: the cursor continues after the last row, without repeats');
select is((select count(*)::int from public.list_meals(p_from => '2026-10-26T00:00:00Z', p_to => '2026-10-27T08:00:00Z')),
  0, 'list: p_to is exclusive');
select is((select count(*)::int from public.list_meals(p_q => 'RICE')), 1, 'list: q matches item names, case-insensitively');
select is((select count(*)::int from public.list_meals(p_q => '_')), 1, 'list: _ in q is literal');
select is((select count(*)::int from public.list_meals(p_q => '0%')), 2, 'list: % in q is literal');

-- ---------------------------------------------------------------------------
-- 6. delete_meal / restore_meal (9)
-- ---------------------------------------------------------------------------

select set_config('t.delete', public.delete_meal(current_setting('t.meal')::uuid)::text, true);
select is(current_setting('t.delete')::jsonb ->> 'status', 'ok', 'delete: ok');
select is((current_setting('t.delete')::jsonb ->> 'undo_until')::timestamptz, now() + interval '10 seconds',
  'delete: undo_until is deleted_at + 10 s');
select is((select status || ':' || version from public.meals where id = current_setting('t.meal')::uuid),
  'pending_deletion:4', 'delete: meal pending deletion, version bumped');
select is_empty(format('select 1 from public.list_meals() where id = %L', current_setting('t.meal')),
  'delete: a pending meal is excluded from lists immediately');
select is(public.delete_meal(current_setting('t.meal')::uuid) ->> 'status', 'not_found', 'delete: twice is not_found');
select is(public.update_meal(current_setting('t.meal')::uuid, 4, 'x') ->> 'status', 'not_found',
  'delete: a pending meal cannot be edited');

select is(public.restore_meal(current_setting('t.meal')::uuid), '{"status": "ok", "version": 5}'::jsonb,
  'undo: within the window restores the meal');
select is((select status from public.meals where id = current_setting('t.meal')::uuid), 'active', 'undo: meal is active again');
select results_eq(
  format('select reason from public.meal_revisions where meal_id = %L order by created_at, reason', current_setting('t.meal')),
  $$ values ('created'::text), ('deleted'::text), ('restored'::text), ('updated'::text), ('updated'::text) $$,
  'undo: revisions for created, two updates, deleted, restored');

-- ---------------------------------------------------------------------------
-- 7. Undo window expiry and purge (6)
-- ---------------------------------------------------------------------------

select public.delete_meal(current_setting('t.meal')::uuid);
select set_config('t.breakfast', (select id::text from public.list_meals(p_q => 'Breakfast')), true);
select public.delete_meal(current_setting('t.breakfast')::uuid); -- stays inside its window

reset role;
update public.meals set deleted_at = now() - interval '11 seconds' where id = current_setting('t.meal')::uuid;
update public.idempotency_keys set created_at = now() - interval '25 hours'
  where key = '7d0c1d3e-0000-4000-8000-000000000003';
select public._meals_as('b7a00000-0000-4000-8000-00000000000a');

select is(public.restore_meal(current_setting('t.meal')::uuid) ->> 'status', 'not_found', 'undo: after the window is not_found');
select throws_ok('select public.purge_expired()', '42501', null, 'purge: users cannot run it');

reset role;
set local role service_role;
select cmp_ok((public.purge_expired() ->> 'meals')::int, '>=', 1, 'purge: reports deleted meals');
reset role;
select is((select count(*)::int from public.meals where id = current_setting('t.meal')::uuid)
        + (select count(*)::int from public.meal_items where meal_id = current_setting('t.meal')::uuid)
        + (select count(*)::int from public.meal_revisions where meal_id = current_setting('t.meal')::uuid), 0,
  'purge: meal, items and revisions are gone');
select is((select status from public.meals where id = current_setting('t.breakfast')::uuid), 'pending_deletion',
  'purge: a meal still inside its window is kept');
select is((select count(*)::int from public.idempotency_keys where key = '7d0c1d3e-0000-4000-8000-000000000003'), 0,
  'purge: idempotency keys older than 24 h are removed');

-- ---------------------------------------------------------------------------
-- 8. Who may call the functions at all (2)
-- ---------------------------------------------------------------------------

set local role anon;
select throws_ok($$ select public.save_meals('7d0c1d3e-0000-4000-8000-000000000009', '[]') $$, '42501', null,
  'grants: anon cannot call save_meals');
reset role;

select public._meals_as('b7c00000-0000-4000-8000-00000000000c');
select throws_ok(
  $$ select public.save_meals('7d0c1d3e-0000-4000-8000-000000000009', public._meals_payload('C lunch', now())) $$,
  '42501', null, 'RLS: a signed-in but unapproved user cannot save meals');
reset role;

select * from finish();

rollback;
