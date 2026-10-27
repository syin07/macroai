-- Approved accounts. Runs on `supabase db reset` locally.
-- For the hosted dev/prod projects: `supabase db push --include-seed`, or run this in the SQL editor.
-- Emails must be lowercase (enforced by a check constraint).

insert into public.approved_emails (email) values
  ('sandy07.yin@gmail.com'),
  ('ken-placeholder@example.invalid')
on conflict (email) do nothing;
