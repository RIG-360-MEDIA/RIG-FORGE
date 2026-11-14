-- Fee proposals (ADMIN and SUPER_ADMIN only): the firm's letterhead and
-- standard terms, and the proposals sent to clients. Apply AFTER
-- 2026-11-12-project-payments.sql and BEFORE deploying the code that needs it.
-- Additive only, safe to run twice.

CREATE TABLE IF NOT EXISTS public."ProposalSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT 'rig360',
    "data" JSONB NOT NULL,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProposalSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS public."Proposal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT 'rig360',
    "projectId" TEXT NOT NULL,
    "serial" INTEGER NOT NULL,
    "refNo" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProposalSettings_organizationId_key" ON public."ProposalSettings"("organizationId");
CREATE INDEX IF NOT EXISTS "ProposalSettings_organizationId_idx" ON public."ProposalSettings"("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "Proposal_organizationId_serial_key" ON public."Proposal"("organizationId", "serial");
CREATE INDEX IF NOT EXISTS "Proposal_projectId_idx" ON public."Proposal"("projectId");
CREATE INDEX IF NOT EXISTS "Proposal_organizationId_idx" ON public."Proposal"("organizationId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Proposal_projectId_fkey' AND conrelid = 'public."Proposal"'::regclass) THEN
    ALTER TABLE public."Proposal" ADD CONSTRAINT "Proposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Proposal_status_valid' AND conrelid = 'public."Proposal"'::regclass) THEN
    ALTER TABLE public."Proposal" ADD CONSTRAINT "Proposal_status_valid" CHECK ("status" IN ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED'));
  END IF;
END $$;

-- Row-level security, as for every table (see prisma/rls/enable-rls-all.sql).
ALTER TABLE public."ProposalSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Proposal" ENABLE ROW LEVEL SECURITY;
