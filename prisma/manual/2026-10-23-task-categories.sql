-- Task categories: a company-wide list of kinds of work (Electrical, Plumbing,
-- Drawings...) that a project's tasks are grouped by, plus Task.categoryId.
-- Render runs `prisma generate` only, never a migration, so apply this to
-- production by hand BEFORE deploying the code that needs it. Additive only:
-- the old code ignores the new table and column, so it is safe to run first.
-- Idempotent: safe to run twice.

ALTER TABLE public."Task" ADD COLUMN IF NOT EXISTS "categoryId" TEXT;

CREATE TABLE IF NOT EXISTS public."TaskCategory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT 'rig360',
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaskCategory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TaskCategory_organizationId_idx" ON public."TaskCategory"("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "TaskCategory_organizationId_name_key" ON public."TaskCategory"("organizationId", "name");
CREATE INDEX IF NOT EXISTS "Task_categoryId_idx" ON public."Task"("categoryId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Task_categoryId_fkey') THEN
    ALTER TABLE public."Task" ADD CONSTRAINT "Task_categoryId_fkey"
      FOREIGN KEY ("categoryId") REFERENCES public."TaskCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Prisma never enables row-level security; without it the Supabase anon key
-- could read the table over REST (see prisma/rls/enable-rls-all.sql). The app
-- connects as the table owner, which bypasses RLS, so it is unaffected.
ALTER TABLE public."TaskCategory" ENABLE ROW LEVEL SECURITY;
