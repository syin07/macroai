-- B13 memory: pending memory candidates (PRD FR-13, §5.8).
--
-- The second pass after a chat turn proposes at most one memory. An explicit statement ("my usual
-- shake is ...") is saved to user_memories straight away; anything else is only a candidate until it
-- comes up a second time ("the same correction twice"). This table holds those first sightings so the
-- repeat can be counted across turns. A candidate is not a memory: it is never sent to the model,
-- listed, or exported, and is removed when it is promoted or goes 30 days without a repeat
-- (src/lib/memory/extract.ts).
--
-- user_id cascades from auth.users, so account deletion removes candidates with everything else
-- (supabase/tests/account_deletion.test.sql checks that for every table).

create table public.memory_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null check (category in (
    'frequent_food', 'portion', 'brand', 'dietary', 'preparation',
    'correction', 'response_style', 'assumption'
  )),
  content text not null check (char_length(content) between 1 and 500),
  occurrences int not null default 1 check (occurrences >= 1),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index memory_candidates_user_seen_idx on public.memory_candidates (user_id, last_seen_at);

-- Retrieval, dedup, and GET /api/memories all read a user's live memories.
create index user_memories_user_live_idx on public.user_memories (user_id, created_at desc)
  where deleted_at is null;

alter table public.memory_candidates enable row level security;

create policy "memory_candidates: owner all" on public.memory_candidates
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()))
  with check (user_id = (select auth.uid()) and (select public.is_approved()));
