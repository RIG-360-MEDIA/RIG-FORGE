-- StandupDigest: one digest per company per day (was one per day in total).
-- Render runs `prisma generate` only, never a migration, so this was applied
-- to production by hand on 14 Oct 2026, BEFORE deploying the code that needs it.
-- Safe for the old code too: it only looked rows up by date.
CREATE UNIQUE INDEX IF NOT EXISTS "StandupDigest_organizationId_date_key"
  ON public."StandupDigest" ("organizationId", "date");
DROP INDEX IF EXISTS public."StandupDigest_date_key";
