-- RLS tests for 0001_init.sql. Run with `supabase test db`.
--
-- Users
--   A  11111111-...  approved, confirmed
--   B  22222222-...  approved, confirmed (the "other" account A must never touch)
--   C  33333333-...  confirmed but NOT on the allow-list
--   D  44444444-...  on the allow-list but email NOT confirmed
--   E  55555555-...  on the allow-list, signed up with a mixed-case email
--
-- Row ids: a0000000-... rows belong to A, b0000000-... to B, c0000000-... to C.
-- Everything runs in one transaction and is rolled back.

begin;

create extension if not exists pgtap with schema extensions;

select plan(123);

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres, which bypasses RLS)
-- ---------------------------------------------------------------------------

insert into public.approved_emails (email) values
  ('a@rls.test'), ('b@rls.test'), ('d@rls.test'), ('e@rls.test');

insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
   'authenticated', 'authenticated', 'a@rls.test', '', now(), '{}', '{"full_name": "User A"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222',
   'authenticated', 'authenticated', 'b@rls.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333',
   'authenticated', 'authenticated', 'c@rls.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '44444444-4444-4444-4444-444444444444',
   'authenticated', 'authenticated', 'd@rls.test', '', null, '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '55555555-5555-5555-5555-555555555555',
   'authenticated', 'authenticated', 'E@RLS.Test', '', now(), '{}', '{}', now(), now());

insert into public.nutrition_goals
  (id, user_id, calorie_target, protein_target_g, carbs_target_g, fat_target_g, effective_from)
values
  ('a0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 2000, 150, 200, 60, '2026-01-01'),
  ('b0000000-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 2500, 180, 250, 80, '2026-01-01');

insert into public.meals (id, user_id, name, consumed_at, source_type) values
  ('a0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'A lunch', now(), 'text'),
  ('b0000000-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'B lunch', now(), 'text'),
  ('c0000000-0000-0000-0000-000000000004', '33333333-3333-3333-3333-333333333333', 'C lunch', now(), 'text');

insert into public.meal_items
  (id, meal_id, food_name, quantity, unit, grams, calories, protein_g, carbs_g, fat_g, nutrition_source)
values
  ('a0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000004',
   'banana', 1, 'piece', 118, 105, 1.3, 27, 0.4, 'usda'),
  ('b0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000004',
   'egg', 2, 'piece', 100, 143, 12.6, 0.7, 9.5, 'usda');

insert into public.conversations (id, user_id) values
  ('a0000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111'),
  ('b0000000-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222222'),
  ('c0000000-0000-0000-0000-000000000007', '33333333-3333-3333-3333-333333333333');

insert into public.messages (id, conversation_id, user_id, role, content) values
  ('a0000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000007',
   '11111111-1111-1111-1111-111111111111', 'user', 'a banana'),
  ('b0000000-0000-0000-0000-000000000008', 'b0000000-0000-0000-0000-000000000007',
   '22222222-2222-2222-2222-222222222222', 'user', 'two eggs');

insert into public.user_memories (id, user_id, category, content, source_message_id) values
  ('a0000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111',
   'frequent_food', 'banana most mornings', 'a0000000-0000-0000-0000-000000000008'),
  ('b0000000-0000-0000-0000-000000000009', '22222222-2222-2222-2222-222222222222',
   'portion', 'eggs are large', 'b0000000-0000-0000-0000-000000000008');

insert into public.meal_revisions (id, meal_id, user_id, updated_values, reason) values
  ('a0000000-0000-0000-0000-000000000010', 'a0000000-0000-0000-0000-000000000004',
   '11111111-1111-1111-1111-111111111111', '{}', 'created'),
  ('b0000000-0000-0000-0000-000000000010', 'b0000000-0000-0000-0000-000000000004',
   '22222222-2222-2222-2222-222222222222', '{}', 'created');

insert into public.temporary_uploads (id, user_id, storage_path, expires_at) values
  ('a0000000-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111111', 'tmp/a', now() + interval '1 hour'),
  ('b0000000-0000-0000-0000-000000000011', '22222222-2222-2222-2222-222222222222', 'tmp/b', now() + interval '1 hour');

insert into public.ai_usage (id, user_id, endpoint, model, input_tokens, output_tokens, estimated_cost_usd) values
  ('a0000000-0000-0000-0000-000000000012', '11111111-1111-1111-1111-111111111111', 'chat', 'test-model', 100, 50, 0.00012345),
  ('b0000000-0000-0000-0000-000000000012', '22222222-2222-2222-2222-222222222222', 'chat', 'test-model', 100, 50, 0.00012345);

insert into public.idempotency_keys (user_id, key, response) values
  ('11111111-1111-1111-1111-111111111111', 'a-key', '{}'),
  ('22222222-2222-2222-2222-222222222222', 'b-key', '{}');

insert into public.nutrition_cache (query_key, source, source_reference, per_100g) values
  ('banana raw', 'usda', '173944', '{"calories": 89, "protein_g": 1.09, "carbs_g": 22.84, "fat_g": 0.33}');

-- Helpers (rolled back with the transaction).

-- Every table a user could reach through the API, for "sees nothing" checks.
create function public._rls_all_tables()
returns setof text
language sql
as $$
  values ('profiles'), ('account_preferences'), ('nutrition_goals'), ('meals'),
         ('meal_items'), ('nutrition_cache'), ('conversations'), ('messages'),
         ('user_memories'), ('meal_revisions'), ('temporary_uploads'), ('ai_usage'),
         ('idempotency_keys'), ('approved_emails');
$$;

-- User-owned tables, with a filter selecting B's rows and a no-op SET clause.
create function public._rls_owned_tables()
returns table (tbl text, b_rows text, a_rows text, noop_set text)
language sql
as $$
  values
    ('profiles',            'id = ''22222222-2222-2222-2222-222222222222''',
                            'id = ''11111111-1111-1111-1111-111111111111''',      'display_name = display_name'),
    ('account_preferences', 'user_id = ''22222222-2222-2222-2222-222222222222''',
                            'user_id = ''11111111-1111-1111-1111-111111111111''', 'theme = theme'),
    ('nutrition_goals',     'user_id = ''22222222-2222-2222-2222-222222222222''',
                            'user_id = ''11111111-1111-1111-1111-111111111111''', 'calorie_target = calorie_target'),
    ('meals',               'user_id = ''22222222-2222-2222-2222-222222222222''',
                            'user_id = ''11111111-1111-1111-1111-111111111111''', 'name = name'),
    ('meal_items',          'meal_id = ''b0000000-0000-0000-0000-000000000004''',
                            'meal_id = ''a0000000-0000-0000-0000-000000000004''', 'food_name = food_name'),
    ('conversations',       'user_id = ''22222222-2222-2222-2222-222222222222''',
                            'user_id = ''11111111-1111-1111-1111-111111111111''', 'title = title'),
    ('messages',            'user_id = ''22222222-2222-2222-2222-222222222222''',
                            'user_id = ''11111111-1111-1111-1111-111111111111''', 'content = content'),
    ('user_memories',       'user_id = ''22222222-2222-2222-2222-222222222222''',
                            'user_id = ''11111111-1111-1111-1111-111111111111''', 'content = content'),
    ('meal_revisions',      'user_id = ''22222222-2222-2222-2222-222222222222''',
                            'user_id = ''11111111-1111-1111-1111-111111111111''', 'reason = reason'),
    ('temporary_uploads',   'user_id = ''22222222-2222-2222-2222-222222222222''',
                            'user_id = ''11111111-1111-1111-1111-111111111111''', 'storage_path = storage_path'),
    ('ai_usage',            'user_id = ''22222222-2222-2222-2222-222222222222''',
                            'user_id = ''11111111-1111-1111-1111-111111111111''', 'model = model'),
    ('idempotency_keys',    'user_id = ''22222222-2222-2222-2222-222222222222''',
                            'user_id = ''11111111-1111-1111-1111-111111111111''', 'key = key');
$$;

create function public._rls_sees_nothing(who text)
returns setof text
language plpgsql
as $$
declare
  t text;
begin
  for t in select * from public._rls_all_tables() loop
    return next is_empty(format('select 1 from public.%I', t), format('%s cannot read %s', who, t));
  end loop;
end;
$$;

-- Switch to a signed-in user, the way PostgREST does it.
create function public._rls_as(uid uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. New-user trigger (4)
-- ---------------------------------------------------------------------------

select is((select timezone from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'UTC', 'trigger: profile created with timezone UTC');
select is((select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'User A', 'trigger: display_name taken from auth metadata');
select is((select theme from public.account_preferences where user_id = '11111111-1111-1111-1111-111111111111'),
  'system', 'trigger: theme defaults to system');
select is((select save_mode from public.account_preferences where user_id = '11111111-1111-1111-1111-111111111111'),
  'confirm', 'trigger: save_mode defaults to confirm');

-- ---------------------------------------------------------------------------
-- 2. is_approved() (4)
-- ---------------------------------------------------------------------------

select public._rls_as('11111111-1111-1111-1111-111111111111');
select ok(public.is_approved(), 'is_approved: approved, confirmed user');
reset role;

select public._rls_as('33333333-3333-3333-3333-333333333333');
select ok(not public.is_approved(), 'is_approved: confirmed user not on the allow-list');
reset role;

select public._rls_as('44444444-4444-4444-4444-444444444444');
select ok(not public.is_approved(), 'is_approved: allow-listed email that is not confirmed');
reset role;

select public._rls_as('55555555-5555-5555-5555-555555555555');
select ok(public.is_approved(), 'is_approved: email match is case-insensitive');
reset role;

-- ---------------------------------------------------------------------------
-- As user A
-- ---------------------------------------------------------------------------

select public._rls_as('11111111-1111-1111-1111-111111111111');

-- 3. Positive controls: A can use its own rows (12 + 3)

select isnt_empty(format('select 1 from public.%I where %s', tbl, a_rows), format('A can read own %s', tbl))
from public._rls_owned_tables();

select lives_ok($$
  insert into public.meals (id, user_id, name, consumed_at, source_type)
  values ('a0000000-0000-0000-0000-000000000020', '11111111-1111-1111-1111-111111111111', 'A dinner', now(), 'manual')
$$, 'A can insert own meal');

select lives_ok($$
  insert into public.meal_items (meal_id, food_name, quantity, unit, calories, protein_g, carbs_g, fat_g, nutrition_source)
  values ('a0000000-0000-0000-0000-000000000020', 'rice', 1, 'cup', 205, 4.3, 45, 0.4, 'manual')
$$, 'A can insert an item into own meal');

select isnt_empty($$
  update public.meals set name = 'A lunch (edited)'
  where id = 'a0000000-0000-0000-0000-000000000004' returning 1
$$, 'A can update own meal');

-- 4. A cannot select / update / delete B's rows in any table (36)

select is_empty(format('select 1 from public.%I where %s', tbl, b_rows), format('A cannot select B''s %s', tbl))
from public._rls_owned_tables();

select is_empty(format('update public.%I set %s where %s returning 1', tbl, noop_set, b_rows),
  format('A cannot update B''s %s', tbl))
from public._rls_owned_tables();

select is_empty(format('delete from public.%I where %s returning 1', tbl, b_rows), format('A cannot delete B''s %s', tbl))
from public._rls_owned_tables();

-- 5. A cannot insert rows owned by B (12)

select throws_ok($$ insert into public.profiles (id) values ('22222222-2222-2222-2222-222222222222') $$,
  '42501', null, 'A cannot insert a profile for B');
select throws_ok($$ insert into public.account_preferences (user_id) values ('22222222-2222-2222-2222-222222222222') $$,
  '42501', null, 'A cannot insert preferences for B');
select throws_ok($$
  insert into public.nutrition_goals (user_id, calorie_target, protein_target_g, carbs_target_g, fat_target_g, effective_from)
  values ('22222222-2222-2222-2222-222222222222', 1, 1, 1, 1, '2026-02-01')
$$, '42501', null, 'A cannot insert goals for B');
select throws_ok($$
  insert into public.meals (user_id, name, consumed_at, source_type)
  values ('22222222-2222-2222-2222-222222222222', 'x', now(), 'text')
$$, '42501', null, 'A cannot insert a meal for B');
select throws_ok($$
  insert into public.meal_items (meal_id, food_name, quantity, unit, calories, protein_g, carbs_g, fat_g, nutrition_source)
  values ('b0000000-0000-0000-0000-000000000004', 'x', 1, 'g', 0, 0, 0, 0, 'manual')
$$, '42501', null, 'A cannot insert an item into B''s meal');
select throws_ok($$ insert into public.conversations (user_id) values ('22222222-2222-2222-2222-222222222222') $$,
  '42501', null, 'A cannot insert a conversation for B');
select throws_ok($$
  insert into public.messages (conversation_id, user_id, role)
  values ('b0000000-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222222', 'user')
$$, '42501', null, 'A cannot insert a message for B');
select throws_ok($$
  insert into public.user_memories (user_id, category, content)
  values ('22222222-2222-2222-2222-222222222222', 'brand', 'x')
$$, '42501', null, 'A cannot insert a memory for B');
select throws_ok($$
  insert into public.meal_revisions (meal_id, user_id, reason)
  values ('b0000000-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222', 'created')
$$, '42501', null, 'A cannot insert a revision for B');
select throws_ok($$
  insert into public.temporary_uploads (user_id, storage_path, expires_at)
  values ('22222222-2222-2222-2222-222222222222', 'x', now())
$$, '42501', null, 'A cannot insert an upload for B');
select throws_ok($$
  insert into public.ai_usage (user_id, endpoint, model)
  values ('22222222-2222-2222-2222-222222222222', 'chat', 'x')
$$, '42501', null, 'A cannot insert AI usage for B');
select throws_ok($$
  insert into public.idempotency_keys (user_id, key, response)
  values ('22222222-2222-2222-2222-222222222222', 'k', '{}')
$$, '42501', null, 'A cannot insert an idempotency key for B');

-- 6. A cannot move own rows to B or link them to B's rows (6)

select throws_ok($$
  update public.meals set user_id = '22222222-2222-2222-2222-222222222222'
  where id = 'a0000000-0000-0000-0000-000000000004'
$$, '42501', null, 'A cannot hand own meal to B');
select throws_ok($$
  update public.meal_items set meal_id = 'b0000000-0000-0000-0000-000000000004'
  where id = 'a0000000-0000-0000-0000-000000000005'
$$, '42501', null, 'A cannot move own item into B''s meal');
select throws_ok($$
  insert into public.messages (conversation_id, user_id, role)
  values ('b0000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'user')
$$, '23503', null, 'A cannot post into B''s conversation');
select throws_ok($$
  insert into public.messages (conversation_id, user_id, role, related_meal_id)
  values ('a0000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'assistant',
          'b0000000-0000-0000-0000-000000000004')
$$, '23503', null, 'A cannot link a message to B''s meal');
select throws_ok($$
  insert into public.user_memories (user_id, category, content, source_message_id)
  values ('11111111-1111-1111-1111-111111111111', 'brand', 'x', 'b0000000-0000-0000-0000-000000000008')
$$, '23503', null, 'A cannot cite B''s message as a memory source');
select throws_ok($$
  insert into public.meal_revisions (meal_id, user_id, reason)
  values ('b0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'updated')
$$, '23503', null, 'A cannot write a revision for B''s meal');

-- 7. Append-only tables: A cannot rewrite or erase own history (6)

select is_empty($$ update public.ai_usage set input_tokens = 0
  where user_id = '11111111-1111-1111-1111-111111111111' returning 1 $$, 'A cannot update own ai_usage');
select is_empty($$ delete from public.ai_usage
  where user_id = '11111111-1111-1111-1111-111111111111' returning 1 $$, 'A cannot delete own ai_usage (AI cap)');
select is_empty($$ update public.meal_revisions set reason = 'updated'
  where user_id = '11111111-1111-1111-1111-111111111111' returning 1 $$, 'A cannot update own meal_revisions');
select is_empty($$ delete from public.meal_revisions
  where user_id = '11111111-1111-1111-1111-111111111111' returning 1 $$, 'A cannot delete own meal_revisions');
select is_empty($$ update public.idempotency_keys set response = '{"forged": true}'
  where user_id = '11111111-1111-1111-1111-111111111111' returning 1 $$, 'A cannot update own idempotency_keys');
select is_empty($$ delete from public.idempotency_keys
  where user_id = '11111111-1111-1111-1111-111111111111' returning 1 $$, 'A cannot delete own idempotency_keys');

-- 8. approved_emails is invisible to users (2)

select is_empty($$ select 1 from public.approved_emails $$, 'A cannot read approved_emails');
select throws_ok($$ insert into public.approved_emails (email) values ('attacker@rls.test') $$,
  '42501', null, 'A cannot add to approved_emails');

-- 9. nutrition_cache: readable, not writable (4)

select isnt_empty($$ select 1 from public.nutrition_cache where query_key = 'banana raw' $$,
  'A can read nutrition_cache');
select throws_ok($$
  insert into public.nutrition_cache (query_key, source, per_100g)
  values ('poison', 'web', '{"calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0}')
$$, '42501', null, 'A cannot insert into nutrition_cache');
select is_empty($$ update public.nutrition_cache set per_100g = '{"calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0}'
  returning 1 $$, 'A cannot update nutrition_cache');
select is_empty($$ delete from public.nutrition_cache returning 1 $$, 'A cannot delete from nutrition_cache');

reset role;

-- ---------------------------------------------------------------------------
-- 10. Unapproved user C sees nothing, not even own rows (14 + 2)
-- ---------------------------------------------------------------------------

select public._rls_as('33333333-3333-3333-3333-333333333333');

select * from public._rls_sees_nothing('unapproved user');

select throws_ok($$
  insert into public.meals (user_id, name, consumed_at, source_type)
  values ('33333333-3333-3333-3333-333333333333', 'x', now(), 'text')
$$, '42501', null, 'unapproved user cannot insert own meal');
select is_empty($$ update public.profiles set display_name = 'x'
  where id = '33333333-3333-3333-3333-333333333333' returning 1 $$, 'unapproved user cannot update own profile');

reset role;

-- ---------------------------------------------------------------------------
-- 11. Signed-out (anon) sees nothing (14)
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;

select * from public._rls_sees_nothing('anon');

reset role;

-- ---------------------------------------------------------------------------
-- 12. The service role can write nutrition_cache (1)
-- ---------------------------------------------------------------------------

set local role service_role;

select lives_ok($$
  insert into public.nutrition_cache (query_key, source, source_reference, per_100g)
  values ('egg whole raw', 'usda', '171287', '{"calories": 143, "protein_g": 12.6, "carbs_g": 0.72, "fat_g": 9.51}')
$$, 'service role can insert into nutrition_cache');

reset role;

-- ---------------------------------------------------------------------------
-- 13. B's data and the shared cache are untouched (3)
-- ---------------------------------------------------------------------------

select is((select name from public.meals where id = 'b0000000-0000-0000-0000-000000000004'),
  'B lunch', 'B''s meal is unchanged');
select is((select count(*) from public.meal_items where meal_id = 'b0000000-0000-0000-0000-000000000004'),
  1::bigint, 'B''s meal items are intact');
select is((select per_100g ->> 'calories' from public.nutrition_cache where query_key = 'banana raw'),
  '89', 'nutrition_cache row is unchanged');

select * from finish();

rollback;
