-- Backfill profiles and account_preferences for auth users created before 0001's
-- on_auth_user_created trigger existed (e.g. the first prod sign-ins, which happened
-- before the schema was pushed). Mirrors handle_new_user(); idempotent.

insert into public.profiles (id, display_name, timezone)
select
  u.id,
  coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'),
  'UTC'
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;

insert into public.account_preferences (user_id, theme, save_mode)
select u.id, 'system', 'confirm'
from auth.users u
left join public.account_preferences a on a.user_id = u.id
where a.user_id is null;
