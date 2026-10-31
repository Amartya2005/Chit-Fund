-- Supabase exposes tables in the "public" schema through its REST (PostgREST) API.
-- ChitKart never uses that API: the backend connects with Prisma as the table owner,
-- which bypasses RLS. Enabling RLS with no policies blocks anon/authenticated API
-- access to every table (e.g. User.passwordHash, RefreshToken.token) without
-- affecting the backend. Harmless on non-Supabase PostgreSQL.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\_prisma%' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
