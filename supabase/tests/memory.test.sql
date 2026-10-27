-- Tests for B13 memory storage (0006_memory_candidates.sql). Run with `supabase test db`.
--
-- Users (ids differ from the other test files so they never contend for the same rows)
--   A  b1300000-...-00000000000a  approved
--   B  b1300000-...-00000000000b  approved (A must never reach B's rows)
--   C  b1300000-...-00000000000c  confirmed but NOT on the allow-list
--
-- Everything runs in one transaction and is rolled back.

begin;

create extension if not exists pgtap with schema extensions;

select plan(18);

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres, which bypasses RLS)
-- ---------------------------------------------------------------------------

insert into public.approved_emails (email) values ('b13a@memory.test'), ('b13b@memory.test');

insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'b1300000-0000-4000-8000-00000000000a',
   'authenticated', 'authenticated', 'b13a@memory.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b1300000-0000-4000-8000-00000000000b',
   'authenticated', 'authenticated', 'b13b@memory.test', '', now(), '{}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b1300000-0000-4000-8000-00000000000c',
   'authenticated', 'authenticated', 'b13c@memory.test', '', now(), '{}', '{}', now(), now());

insert into public.memory_candidates (id, user_id, category, content) values
  ('b13a0000-0000-4000-8000-000000000001', 'b1300000-0000-4000-8000-00000000000a', 'frequent_food', 'Fairlife Core Power 26g'),
  ('b13b0000-0000-4000-8000-000000000001', 'b1300000-0000-4000-8000-00000000000b', 'portion', 'Two large eggs'),
  ('b13c0000-0000-4000-8000-000000000001', 'b1300000-0000-4000-8000-00000000000c', 'brand', 'Oatly');

insert into public.user_memories (id, user_id, category, content, deleted_at) values
  ('b13a0000-0000-4000-8000-000000000002', 'b1300000-0000-4000-8000-00000000000a', 'brand', 'Usually Oatly barista', null),
  ('b13a0000-0000-4000-8000-000000000003', 'b1300000-0000-4000-8000-00000000000a', 'portion', 'Deleted one', now());

create function public._b13_as(uid uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Schema (3)
-- ---------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.memory_candidates'::regclass),
  'memory_candidates has RLS enabled');
select throws_ok($$
  insert into public.memory_candidates (user_id, category, content)
  values ('b1300000-0000-4000-8000-00000000000a', 'mood', 'x')
$$, '23514', null, 'category is checked');
select throws_ok($$
  insert into public.memory_candidates (user_id, category, content, occurrences)
  values ('b1300000-0000-4000-8000-00000000000a', 'brand', 'x', 0)
$$, '23514', null, 'occurrences must be at least 1');

-- ---------------------------------------------------------------------------
-- 2. As A (11)
-- ---------------------------------------------------------------------------

select public._b13_as('b1300000-0000-4000-8000-00000000000a');

select results_eq($$ select id from public.memory_candidates $$,
  $$ values ('b13a0000-0000-4000-8000-000000000001'::uuid) $$, 'A sees only its own candidates');
select lives_ok($$
  insert into public.memory_candidates (user_id, category, content)
  values ('b1300000-0000-4000-8000-00000000000a', 'portion', 'Two slices of toast')
$$, 'A can insert its own candidate');
select isnt_empty($$
  update public.memory_candidates set occurrences = occurrences + 1, last_seen_at = now()
  where id = 'b13a0000-0000-4000-8000-000000000001' returning 1
$$, 'A can bump its own candidate');
select isnt_empty($$
  delete from public.memory_candidates where id = 'b13a0000-0000-4000-8000-000000000001' returning 1
$$, 'A can delete its own candidate');

select is_empty($$ select 1 from public.memory_candidates where user_id = 'b1300000-0000-4000-8000-00000000000b' $$,
  'A cannot select B''s candidates');
select is_empty($$
  update public.memory_candidates set occurrences = 99 where user_id = 'b1300000-0000-4000-8000-00000000000b' returning 1
$$, 'A cannot update B''s candidates');
select is_empty($$
  delete from public.memory_candidates where user_id = 'b1300000-0000-4000-8000-00000000000b' returning 1
$$, 'A cannot delete B''s candidates');
select throws_ok($$
  insert into public.memory_candidates (user_id, category, content)
  values ('b1300000-0000-4000-8000-00000000000b', 'brand', 'x')
$$, '42501', null, 'A cannot insert a candidate for B');

-- Soft delete (DELETE /api/memories/:id) is an UPDATE of deleted_at under the owner policy.
select isnt_empty($$
  update public.user_memories set deleted_at = now()
  where id = 'b13a0000-0000-4000-8000-000000000002' and deleted_at is null returning 1
$$, 'A can soft-delete its own memory');
select is_empty($$
  update public.user_memories set deleted_at = now()
  where id = 'b13a0000-0000-4000-8000-000000000003' and deleted_at is null returning 1
$$, 'an already-deleted memory is not matched again');
select is((select count(*)::int from public.user_memories where deleted_at is null), 0,
  'A has no live memories left');

reset role;

-- ---------------------------------------------------------------------------
-- 3. Unapproved C (2)
-- ---------------------------------------------------------------------------

select public._b13_as('b1300000-0000-4000-8000-00000000000c');
select is_empty($$ select 1 from public.memory_candidates $$, 'unapproved C cannot read even its own candidates');
select throws_ok($$
  insert into public.memory_candidates (user_id, category, content)
  values ('b1300000-0000-4000-8000-00000000000c', 'brand', 'x')
$$, '42501', null, 'unapproved C cannot insert candidates');
reset role;

-- ---------------------------------------------------------------------------
-- 4. Account deletion cascades (2)
-- ---------------------------------------------------------------------------

delete from auth.users where id = 'b1300000-0000-4000-8000-00000000000a';
select is((select count(*)::int from public.memory_candidates where user_id = 'b1300000-0000-4000-8000-00000000000a'), 0,
  'deleting A removes A''s candidates');
select is((select count(*)::int from public.memory_candidates where user_id = 'b1300000-0000-4000-8000-00000000000b'), 1,
  'B''s candidates are untouched');

select * from finish();
rollback;
