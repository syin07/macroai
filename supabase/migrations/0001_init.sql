-- MacroAI initial schema: tables (PRD §7.1), indexes (PRD §7.4), RLS, approved accounts.
--
-- Security model
--   * Every user-owned table has RLS: user_id = auth.uid() and is_approved().
--   * meal_items has no user_id; ownership goes through the parent meal.
--   * Cross-table references (message -> conversation, revision -> meal, ...) use
--     composite (id, user_id) foreign keys, so a row can never point at another
--     user's row, even from service-role code paths.
--   * nutrition_cache is shared reference data: readable by approved users,
--     writable only by the service role (which bypasses RLS).
--   * approved_emails has RLS and no policies: only the service role can read it.
--   * Audit-style tables (meal_revisions, ai_usage, idempotency_keys) are
--     select + insert only for users, so nobody can erase their AI-cap usage.
--
-- Nutrient quantities are numeric(10,3); rounding happens only for display.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Approved accounts
-- ---------------------------------------------------------------------------

create table public.approved_emails (
  email text primary key check (email = lower(email))
);

alter table public.approved_emails enable row level security;

-- True when the signed-in user's confirmed email is on the allow-list.
create function public.is_approved()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    join public.approved_emails a on a.email = lower(u.email)
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
  );
$$;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  timezone text not null default 'UTC',          -- IANA zone; set during onboarding
  onboarding_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.account_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  theme text not null default 'system' check (theme in ('system', 'light', 'dark')),
  save_mode text not null default 'confirm' check (save_mode in ('confirm', 'auto')),
  assistant_style text not null default 'casual' check (assistant_style in ('casual', 'detailed')),
  updated_at timestamptz not null default now()
);

create table public.nutrition_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  calorie_target numeric(10,3) not null check (calorie_target >= 0),
  protein_target_g numeric(10,3) not null check (protein_target_g >= 0),
  carbs_target_g numeric(10,3) not null check (carbs_target_g >= 0),
  fat_target_g numeric(10,3) not null check (fat_target_g >= 0),
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  unique (user_id, effective_from),
  check (effective_to is null or effective_to > effective_from)
);

create table public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  consumed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source_type text not null check (source_type in ('text', 'photo', 'barcode', 'manual')),
  total_calories numeric(10,3) not null default 0 check (total_calories >= 0),
  total_protein_g numeric(10,3) not null default 0 check (total_protein_g >= 0),
  total_carbs_g numeric(10,3) not null default 0 check (total_carbs_g >= 0),
  total_fat_g numeric(10,3) not null default 0 check (total_fat_g >= 0),
  status text not null default 'active' check (status in ('active', 'pending_deletion')),
  deleted_at timestamptz,
  version int not null default 1,
  -- No photo column: photos are never stored (FR-15).
  unique (id, user_id),
  check ((status = 'pending_deletion') = (deleted_at is not null))
);

create table public.meal_items (
  id uuid primary key default gen_random_uuid(),
  meal_id uuid not null references public.meals (id) on delete cascade,
  position int not null default 0,               -- display order within the meal
  food_name text not null,
  quantity numeric(10,3) not null check (quantity >= 0),
  unit text not null,
  grams numeric(10,3) check (grams >= 0),
  basis_per_100g jsonb check (
    basis_per_100g is null
    or (jsonb_typeof(basis_per_100g) = 'object'
        and basis_per_100g ?& array['calories', 'protein_g', 'carbs_g', 'fat_g'])
  ),
  calories numeric(10,3) not null check (calories >= 0),
  protein_g numeric(10,3) not null check (protein_g >= 0),
  carbs_g numeric(10,3) not null check (carbs_g >= 0),
  fat_g numeric(10,3) not null check (fat_g >= 0),
  nutrition_source text not null
    check (nutrition_source in ('usda', 'open_food_facts', 'label', 'web', 'ai', 'manual')),
  source_reference text,
  inferred boolean not null default false,
  confidence text check (confidence in ('high', 'medium', 'low')),
  edited_by_user boolean not null default false,
  assumptions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.nutrition_cache (
  query_key text not null,                       -- normalized query, barcode, or food name
  source text not null check (source in ('usda', 'open_food_facts', 'web')),
  source_reference text,
  per_100g jsonb not null check (
    jsonb_typeof(per_100g) = 'object'
    and per_100g ?& array['calories', 'protein_g', 'carbs_g', 'fat_g']
  ),
  portions jsonb,
  fetched_at timestamptz not null default now(),
  primary key (query_key, source)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  client_message_id uuid,                        -- replay key for POST /api/ai/chat
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text not null default '',
  cards jsonb not null default '[]'::jsonb check (jsonb_typeof(cards) = 'array'),
  tool_payload jsonb,                            -- structured tool call / result
  had_image boolean not null default false,      -- the image itself is never stored
  related_meal_id uuid,
  status text not null default 'sent' check (status in ('sent', 'pending', 'error', 'deleted')),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, client_message_id),
  foreign key (conversation_id, user_id)
    references public.conversations (id, user_id) on delete cascade,
  foreign key (related_meal_id, user_id)
    references public.meals (id, user_id) on delete set null (related_meal_id)
);

create table public.user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null check (category in (
    'frequent_food', 'portion', 'brand', 'dietary', 'preparation',
    'correction', 'response_style', 'assumption'
  )),
  content text not null,
  source_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (source_message_id, user_id)
    references public.messages (id, user_id) on delete set null (source_message_id)
);

create table public.meal_revisions (
  id uuid primary key default gen_random_uuid(),
  meal_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  previous_values jsonb,                         -- null for reason 'created'
  updated_values jsonb,
  reason text not null check (reason in ('created', 'updated', 'deleted', 'restored')),
  created_at timestamptz not null default now(),
  foreign key (meal_id, user_id)
    references public.meals (id, user_id) on delete cascade
);

-- Only used if temporary photo storage is ever enabled (FR-15). Unused by default.
create table public.temporary_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  storage_path text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  deleted_at timestamptz
);

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  endpoint text not null,
  model text not null,
  input_tokens int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  -- Per-call costs are fractions of a cent, so this needs more scale than (10,3).
  estimated_cost_usd numeric(12,8) not null default 0 check (estimated_cost_usd >= 0)
);

create table public.idempotency_keys (
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

create trigger set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.account_preferences
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.meals
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.meal_items
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.user_memories
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- New-user bootstrap: profile + default preferences
-- ---------------------------------------------------------------------------

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, timezone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    'UTC'
  );

  insert into public.account_preferences (user_id, theme, save_mode)
  values (new.id, 'system', 'confirm');

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Indexes (PRD §7.4)
-- ---------------------------------------------------------------------------

-- Meals by user and consumed time; matches the (consumed_at, id) cursor in GET /api/meals.
create index meals_user_consumed_idx on public.meals (user_id, consumed_at desc, id desc);
create index meal_items_meal_idx on public.meal_items (meal_id, position);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at, id);
create index messages_user_created_idx on public.messages (user_id, created_at desc, id desc);
create index user_memories_user_category_idx on public.user_memories (user_id, category);
create index conversations_user_updated_idx on public.conversations (user_id, updated_at desc);
create index meal_revisions_meal_idx on public.meal_revisions (meal_id, created_at);
create index ai_usage_user_created_idx on public.ai_usage (user_id, created_at);
create index idempotency_keys_created_idx on public.idempotency_keys (created_at);
create index temporary_uploads_expires_idx on public.temporary_uploads (expires_at)
  where deleted_at is null;
-- nutrition_cache lookups by query_key use its primary key (query_key, source).

-- Food-name search (GET /api/meals?q=, search_meal_history).
create index meals_name_trgm_idx on public.meals
  using gin (name extensions.gin_trgm_ops);
create index meal_items_food_name_trgm_idx on public.meal_items
  using gin (food_name extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- auth.uid() and is_approved() are wrapped in (select ...) so Postgres evaluates
-- them once per statement instead of once per row.

alter table public.profiles enable row level security;
alter table public.account_preferences enable row level security;
alter table public.nutrition_goals enable row level security;
alter table public.meals enable row level security;
alter table public.meal_items enable row level security;
alter table public.nutrition_cache enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.user_memories enable row level security;
alter table public.meal_revisions enable row level security;
alter table public.temporary_uploads enable row level security;
alter table public.ai_usage enable row level security;
alter table public.idempotency_keys enable row level security;

-- profiles / account_preferences: created by the trigger, deleted by cascade.
create policy "profiles: owner select" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) and (select public.is_approved()));
create policy "profiles: owner update" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) and (select public.is_approved()))
  with check (id = (select auth.uid()) and (select public.is_approved()));

create policy "account_preferences: owner select" on public.account_preferences
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()));
create policy "account_preferences: owner update" on public.account_preferences
  for update to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()))
  with check (user_id = (select auth.uid()) and (select public.is_approved()));

-- Fully user-managed tables.
create policy "nutrition_goals: owner all" on public.nutrition_goals
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()))
  with check (user_id = (select auth.uid()) and (select public.is_approved()));

create policy "meals: owner all" on public.meals
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()))
  with check (user_id = (select auth.uid()) and (select public.is_approved()));

create policy "meal_items: owner of parent meal" on public.meal_items
  for all to authenticated
  using (
    (select public.is_approved())
    and exists (
      select 1 from public.meals m
      where m.id = meal_items.meal_id and m.user_id = (select auth.uid())
    )
  )
  with check (
    (select public.is_approved())
    and exists (
      select 1 from public.meals m
      where m.id = meal_items.meal_id and m.user_id = (select auth.uid())
    )
  );

create policy "conversations: owner all" on public.conversations
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()))
  with check (user_id = (select auth.uid()) and (select public.is_approved()));

create policy "messages: owner all" on public.messages
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()))
  with check (user_id = (select auth.uid()) and (select public.is_approved()));

create policy "user_memories: owner all" on public.user_memories
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()))
  with check (user_id = (select auth.uid()) and (select public.is_approved()));

create policy "temporary_uploads: owner all" on public.temporary_uploads
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()))
  with check (user_id = (select auth.uid()) and (select public.is_approved()));

-- Append-only for users; the purge job and account deletion use the service role.
create policy "meal_revisions: owner select" on public.meal_revisions
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()));
create policy "meal_revisions: owner insert" on public.meal_revisions
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_approved()));

create policy "ai_usage: owner select" on public.ai_usage
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()));
create policy "ai_usage: owner insert" on public.ai_usage
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_approved()));

create policy "idempotency_keys: owner select" on public.idempotency_keys
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()));
create policy "idempotency_keys: owner insert" on public.idempotency_keys
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_approved()));

-- Shared reference data: any approved user may read; only the service role writes.
create policy "nutrition_cache: approved read" on public.nutrition_cache
  for select to authenticated
  using ((select public.is_approved()));
