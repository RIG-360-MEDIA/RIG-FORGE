-- Task templates: ready-made task lists (e.g. "Architectural design", 41
-- items) copied into a project's Task List in one step.
-- Apply AFTER 2026-10-23-task-categories.sql (items reference TaskCategory)
-- and BEFORE deploying the code that needs it. Additive and idempotent.

CREATE TABLE IF NOT EXISTS public."TaskTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT 'rig360',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaskTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS public."TaskTemplateItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT 'rig360',
    "templateId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "categoryId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "TaskTemplateItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TaskTemplate_organizationId_idx" ON public."TaskTemplate"("organizationId");
CREATE INDEX IF NOT EXISTS "TaskTemplateItem_templateId_idx" ON public."TaskTemplateItem"("templateId");
CREATE INDEX IF NOT EXISTS "TaskTemplateItem_organizationId_idx" ON public."TaskTemplateItem"("organizationId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TaskTemplateItem_templateId_fkey') THEN
    ALTER TABLE public."TaskTemplateItem" ADD CONSTRAINT "TaskTemplateItem_templateId_fkey"
      FOREIGN KEY ("templateId") REFERENCES public."TaskTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TaskTemplateItem_categoryId_fkey') THEN
    ALTER TABLE public."TaskTemplateItem" ADD CONSTRAINT "TaskTemplateItem_categoryId_fkey"
      FOREIGN KEY ("categoryId") REFERENCES public."TaskCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Row-level security, as for every table (see prisma/rls/enable-rls-all.sql).
ALTER TABLE public."TaskTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."TaskTemplateItem" ENABLE ROW LEVEL SECURITY;
