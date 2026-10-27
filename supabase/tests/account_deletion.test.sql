-- Account deletion (B14, PRD FR-18). Run with `supabase test db`.
--
-- DELETE /api/account deletes the user's auth.users row through the Auth admin API; everything the
-- user owns must go with it through `on delete cascade`, and the other account must be untouched.
--
-- Users
--   X  dddddddd-...-0001  the account being deleted
--   Y  dddddddd-...-0002  the other account, which must keep every row
--
-- Row ids: e1…-prefixed rows belong to X, e2…-prefixed rows to Y. Everything runs in one transaction
-- and is rolled back, so it is safe against a shared local database.

begin;

create extension if not exists pgtap with schema extensions;

select plan(44);

-- ---------------------------------------------------------------------------
-- 1. Schema coverage (2): no user-owned table can survive its user
-- ---------------------------------------------------------------------------

-- Every user_id column is a foreign key to auth.users with on delete cascade.
select is_empty($$
  select c.relname::text
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and a.attname = 'user_id' and not a.attisdropped
    and not exists (
      select 1 from pg_constraint k
      where k.conrelid = c.oid and k.contype = 'f' and k.confdeltype = 'c'
        and k.confrelid = 'auth.users'::regclass and k.conkey = array[a.attnum]
    )
$$, 'every public user_id column cascades from auth.users');

-- Every public table is either deleted by some cascade (from auth.users or from a parent row) or is
-- shared data that belongs to no user.
select is_empty($$
  select c.relname::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname not in ('nutrition_cache', 'approved_emails')
    and not exists (
      select 1 from pg_constraint k
      where k.conrelid = c.oid and k.contype = 'f' and k.confdeltype = 'c'
    )
$$, 'every public table except shared reference data is removed by a cascade');

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres, which bypasses RLS): one row in every user table for X and for Y
-- ---------------------------------------------------------------------------

insert into public.approved_emails (email) values ('x@b14-delete.test'), ('y@b14-delete.test');

insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'dddddddd-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'x@b14-delete.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'dddddddd-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'y@b14-delete.test', '', now(), '{}', '{}', now(), now());
-- profiles and account_preferences come from the on_auth_user_created trigger.

insert into public.nutrition_goals
  (id, user_id, calorie_target, protein_target_g, carbs_target_g, fat_target_g, effective_from)
values
  ('e1000000-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000001', 2000, 150, 200, 60, '2026-01-01'),
  ('e2000000-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000002', 2500, 180, 250, 80, '2026-01-01');

insert into public.meals (id, user_id, name, consumed_at, source_type) values
  ('e1000000-0000-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000001', 'X lunch', now(), 'text'),
  ('e2000000-0000-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000002', 'Y lunch', now(), 'text');

insert into public.meal_items
  (id, meal_id, food_name, quantity, unit, grams, calories, protein_g, carbs_g, fat_g, nutrition_source)
values
  ('e1000000-0000-4000-8000-000000000005', 'e1000000-0000-4000-8000-000000000004',
   'banana', 1, 'piece', 118, 105, 1.3, 27, 0.4, 'usda'),
  ('e2000000-0000-4000-8000-000000000005', 'e2000000-0000-4000-8000-000000000004',
   'egg', 2, 'piece', 100, 143, 12.6, 0.7, 9.5, 'usda');

insert into public.conversations (id, user_id) values
  ('e1000000-0000-4000-8000-000000000007', 'dddddddd-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-000000000007', 'dddddddd-0000-4000-8000-000000000002');

insert into public.messages (id, conversation_id, user_id, role, content, related_meal_id) values
  ('e1000000-0000-4000-8000-000000000008', 'e1000000-0000-4000-8000-000000000007',
   'dddddddd-0000-4000-8000-000000000001', 'assistant', 'logged', 'e1000000-0000-4000-8000-000000000004'),
  ('e2000000-0000-4000-8000-000000000008', 'e2000000-0000-4000-8000-000000000007',
   'dddddddd-0000-4000-8000-000000000002', 'assistant', 'logged', 'e2000000-0000-4000-8000-000000000004');

insert into public.user_memories (id, user_id, category, content, source_message_id) values
  ('e1000000-0000-4000-8000-000000000009', 'dddddddd-0000-4000-8000-000000000001',
   'frequent_food', 'banana most mornings', 'e1000000-0000-4000-8000-000000000008'),
  ('e2000000-0000-4000-8000-000000000009', 'dddddddd-0000-4000-8000-000000000002',
   'portion', 'eggs are large', 'e2000000-0000-4000-8000-000000000008');

insert into public.meal_revisions (id, meal_id, user_id, updated_values, reason) values
  ('e1000000-0000-4000-8000-000000000010', 'e1000000-0000-4000-8000-000000000004',
   'dddddddd-0000-4000-8000-000000000001', '{}', 'created'),
  ('e2000000-0000-4000-8000-000000000010', 'e2000000-0000-4000-8000-000000000004',
   'dddddddd-0000-4000-8000-000000000002', '{}', 'created');

insert into public.temporary_uploads (id, user_id, storage_path, expires_at) values
  ('e1000000-0000-4000-8000-000000000011', 'dddddddd-0000-4000-8000-000000000001', 'tmp/x', now() + interval '1 hour'),
  ('e2000000-0000-4000-8000-000000000011', 'dddddddd-0000-4000-8000-000000000002', 'tmp/y', now() + interval '1 hour');

insert into public.ai_usage (id, user_id, endpoint, model, input_tokens, output_tokens) values
  ('e1000000-0000-4000-8000-000000000012', 'dddddddd-0000-4000-8000-000000000001', 'ai/chat', 'test-model', 100, 50),
  ('e2000000-0000-4000-8000-000000000012', 'dddddddd-0000-4000-8000-000000000002', 'ai/chat', 'test-model', 100, 50);

insert into public.idempotency_keys (user_id, key, response) values
  ('dddddddd-0000-4000-8000-000000000001', 'x-key', '{}'),
  ('dddddddd-0000-4000-8000-000000000002', 'y-key', '{}');

insert into public.nutrition_cache (query_key, source, source_reference, per_100g) values
  ('b14 delete test banana', 'usda', '173944', '{"calories": 89, "protein_g": 1.09, "carbs_g": 22.84, "fat_g": 0.33}');

-- Each user table with the filter that selects one user's rows (%1$s = user id, %2$s = the user's
-- meal_items id, since meal_items has no user column).
create function public._b14_owned_tables()
returns table (tbl text, filter text)
language sql
as $$
  values
    ('profiles',            'id = %1$L'),
    ('account_preferences', 'user_id = %1$L'),
    ('nutrition_goals',     'user_id = %1$L'),
    ('meals',               'user_id = %1$L'),
    ('meal_items',          'id = %2$L'),
    ('conversations',       'user_id = %1$L'),
    ('messages',            'user_id = %1$L'),
    ('user_memories',       'user_id = %1$L'),
    ('meal_revisions',      'user_id = %1$L'),
    ('temporary_uploads',   'user_id = %1$L'),
    ('ai_usage',            'user_id = %1$L'),
    ('idempotency_keys',    'user_id = %1$L');
$$;

-- Rows in `tbl` matching `filter`.
create function public._b14_count(tbl text, filter text)
returns int
language plpgsql
as $$
declare
  n int;
begin
  execute format('select count(*) from public.%I where %s', tbl, filter) into n;
  return n;
end;
$$;

-- Public tables holding a user_id that no longer exists in auth.users.
create function public._b14_orphans()
returns setof text
language plpgsql
as $$
declare
  t text;
begin
  for t in
    select c.relname::text
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and a.attname = 'user_id' and not a.attisdropped
  loop
    if public._b14_count(t, 'user_id not in (select id from auth.users)') > 0 then
      return next t;
    end if;
  end loop;
end;
$$;

-- One test per table: does `who` have exactly `expected` rows there?
create function public._b14_row_counts(who text, uid uuid, prefix text, expected int)
returns setof text
language plpgsql
as $$
declare
  r record;
begin
  for r in select * from public._b14_owned_tables() loop
    return next is(
      public._b14_count(r.tbl, format(r.filter, uid, prefix || '000000-0000-4000-8000-000000000005')),
      expected,
      format('%s has %s row(s) in %s', who, expected, r.tbl));
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. Before (12): X has a row in every user table
-- ---------------------------------------------------------------------------

select public._b14_row_counts('X before deletion', 'dddddddd-0000-4000-8000-000000000001', 'e1', 1);

-- ---------------------------------------------------------------------------
-- 3. Delete X the way the Auth admin API does: delete the auth.users row
-- ---------------------------------------------------------------------------

delete from auth.users where id = 'dddddddd-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- 4. After (24): X has nothing left; Y has everything
-- ---------------------------------------------------------------------------

select public._b14_row_counts('X after deletion', 'dddddddd-0000-4000-8000-000000000001', 'e1', 0);
select public._b14_row_counts('Y after X''s deletion', 'dddddddd-0000-4000-8000-000000000002', 'e2', 1);

-- ---------------------------------------------------------------------------
-- 5. No orphans, shared data and Y's links intact (6)
-- ---------------------------------------------------------------------------

select is_empty('select * from public._b14_orphans()', 'no public row points at a deleted user');

select is_empty(
  $$ select 1 from public.meal_items i where not exists (select 1 from public.meals m where m.id = i.meal_id) $$,
  'no meal_items are left without a meal');

select is(
  (select count(*)::int from public.nutrition_cache where query_key = 'b14 delete test banana'),
  1, 'shared nutrition_cache rows are untouched');

select is(
  (select count(*)::int from public.approved_emails where email in ('x@b14-delete.test', 'y@b14-delete.test')),
  2, 'approved_emails is an allow-list, not user data: deletion leaves it alone');

select is(
  (select related_meal_id from public.messages where id = 'e2000000-0000-4000-8000-000000000008'),
  'e2000000-0000-4000-8000-000000000004'::uuid, 'Y''s message still links to Y''s meal');

select is(
  (select source_message_id from public.user_memories where id = 'e2000000-0000-4000-8000-000000000009'),
  'e2000000-0000-4000-8000-000000000008'::uuid, 'Y''s memory still links to Y''s message');

select * from finish();

rollback;
