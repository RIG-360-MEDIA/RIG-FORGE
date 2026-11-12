-- Project payments (ADMIN and SUPER_ADMIN only): fee, fee changes, billing
-- phases, receipts, allocations and an audit log. Apply AFTER the task
-- category and template files and BEFORE deploying the code that needs it.
-- Additive only, safe to run twice.

CREATE TABLE IF NOT EXISTS public."PaymentPlan" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT 'rig360',
    "projectId" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "percentBp" INTEGER,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS public."PaymentFeeChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT 'rig360',
    "planId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountDelta" BIGINT NOT NULL,
    "estimatedCost" BIGINT,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentFeeChange_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS public."PaymentPhase" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT 'rig360',
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentPhase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS public."PaymentReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT 'rig360',
    "projectId" TEXT NOT NULL,
    "receivedOn" TIMESTAMP(3) NOT NULL,
    "amount" BIGINT NOT NULL,
    "mode" TEXT NOT NULL,
    "reference" TEXT,
    "payer" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,

    CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS public."PaymentAllocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT 'rig360',
    "receiptId" TEXT NOT NULL,
    "phaseId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS public."PaymentAuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT 'rig360',
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentPlan_projectId_key" ON public."PaymentPlan"("projectId");

CREATE INDEX IF NOT EXISTS "PaymentPlan_organizationId_idx" ON public."PaymentPlan"("organizationId");

CREATE INDEX IF NOT EXISTS "PaymentFeeChange_planId_idx" ON public."PaymentFeeChange"("planId");

CREATE INDEX IF NOT EXISTS "PaymentFeeChange_organizationId_idx" ON public."PaymentFeeChange"("organizationId");

CREATE INDEX IF NOT EXISTS "PaymentPhase_projectId_idx" ON public."PaymentPhase"("projectId");

CREATE INDEX IF NOT EXISTS "PaymentPhase_organizationId_idx" ON public."PaymentPhase"("organizationId");

CREATE INDEX IF NOT EXISTS "PaymentReceipt_projectId_idx" ON public."PaymentReceipt"("projectId");

CREATE INDEX IF NOT EXISTS "PaymentReceipt_organizationId_idx" ON public."PaymentReceipt"("organizationId");

CREATE INDEX IF NOT EXISTS "PaymentAllocation_receiptId_idx" ON public."PaymentAllocation"("receiptId");

CREATE INDEX IF NOT EXISTS "PaymentAllocation_phaseId_idx" ON public."PaymentAllocation"("phaseId");

CREATE INDEX IF NOT EXISTS "PaymentAllocation_organizationId_idx" ON public."PaymentAllocation"("organizationId");

CREATE INDEX IF NOT EXISTS "PaymentAuditLog_projectId_createdAt_idx" ON public."PaymentAuditLog"("projectId", "createdAt");

CREATE INDEX IF NOT EXISTS "PaymentAuditLog_organizationId_idx" ON public."PaymentAuditLog"("organizationId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentPlan_projectId_fkey' AND conrelid = 'public."PaymentPlan"'::regclass) THEN
    ALTER TABLE public."PaymentPlan" ADD CONSTRAINT "PaymentPlan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentFeeChange_planId_fkey' AND conrelid = 'public."PaymentFeeChange"'::regclass) THEN
    ALTER TABLE public."PaymentFeeChange" ADD CONSTRAINT "PaymentFeeChange_planId_fkey" FOREIGN KEY ("planId") REFERENCES public."PaymentPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentPhase_projectId_fkey' AND conrelid = 'public."PaymentPhase"'::regclass) THEN
    ALTER TABLE public."PaymentPhase" ADD CONSTRAINT "PaymentPhase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentReceipt_projectId_fkey' AND conrelid = 'public."PaymentReceipt"'::regclass) THEN
    ALTER TABLE public."PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public."Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentAllocation_receiptId_fkey' AND conrelid = 'public."PaymentAllocation"'::regclass) THEN
    ALTER TABLE public."PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES public."PaymentReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentAllocation_phaseId_fkey' AND conrelid = 'public."PaymentAllocation"'::regclass) THEN
    ALTER TABLE public."PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES public."PaymentPhase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;


-- ── Guards in the database itself ─────────────────────────────────────────────
-- The app already enforces these; the database enforces them too, so no bug,
-- script or direct edit can rewrite payment history.

-- Amounts are always more than 0 (fee changes may be negative, so not those).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentReceipt_amount_positive' AND conrelid = 'public."PaymentReceipt"'::regclass) THEN
    ALTER TABLE public."PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_amount_positive" CHECK ("amount" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentAllocation_amount_positive' AND conrelid = 'public."PaymentAllocation"'::regclass) THEN
    ALTER TABLE public."PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_amount_positive" CHECK ("amount" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentPhase_amount_positive' AND conrelid = 'public."PaymentPhase"'::regclass) THEN
    ALTER TABLE public."PaymentPhase" ADD CONSTRAINT "PaymentPhase_amount_positive" CHECK ("amount" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentPlan_basis_valid' AND conrelid = 'public."PaymentPlan"'::regclass) THEN
    ALTER TABLE public."PaymentPlan" ADD CONSTRAINT "PaymentPlan_basis_valid" CHECK ("basis" IN ('FIXED', 'PERCENT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentReceipt_mode_valid' AND conrelid = 'public."PaymentReceipt"'::regclass) THEN
    ALTER TABLE public."PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_mode_valid" CHECK ("mode" IN ('BANK', 'UPI', 'CHEQUE', 'CASH', 'OTHER'));
  END IF;
END $$;

-- Append-only: fee changes, allocations and the audit log are never changed or deleted.
CREATE OR REPLACE FUNCTION public.payments_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only: they cannot be changed or deleted', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PaymentFeeChange_append_only" ON public."PaymentFeeChange";
CREATE TRIGGER "PaymentFeeChange_append_only" BEFORE UPDATE OR DELETE ON public."PaymentFeeChange"
  FOR EACH ROW EXECUTE FUNCTION public.payments_append_only();
DROP TRIGGER IF EXISTS "PaymentAllocation_append_only" ON public."PaymentAllocation";
CREATE TRIGGER "PaymentAllocation_append_only" BEFORE UPDATE OR DELETE ON public."PaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION public.payments_append_only();
DROP TRIGGER IF EXISTS "PaymentAuditLog_append_only" ON public."PaymentAuditLog";
CREATE TRIGGER "PaymentAuditLog_append_only" BEFORE UPDATE OR DELETE ON public."PaymentAuditLog"
  FOR EACH ROW EXECUTE FUNCTION public.payments_append_only();

-- Receipts: never deleted; the only change ever allowed is the one-time
-- reversal (reversedAt, reversedById, reversalReason set from empty).
CREATE OR REPLACE FUNCTION public.payment_receipt_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment receipts cannot be deleted; reverse them instead';
  END IF;
  IF OLD."reversedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'A reversed payment receipt cannot be changed';
  END IF;
  IF NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."receivedOn" IS DISTINCT FROM OLD."receivedOn"
     OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."payer" IS DISTINCT FROM OLD."payer"
     OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Payment receipts cannot be edited; reverse and record again';
  END IF;
  IF NEW."reversedAt" IS NULL OR NEW."reversedById" IS NULL OR NEW."reversalReason" IS NULL THEN
    RAISE EXCEPTION 'A reversal needs a time, a user and a reason';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PaymentReceipt_guard" ON public."PaymentReceipt";
CREATE TRIGGER "PaymentReceipt_guard" BEFORE UPDATE OR DELETE ON public."PaymentReceipt"
  FOR EACH ROW EXECUTE FUNCTION public.payment_receipt_guard();

-- TRUNCATE skips row triggers, so block it on the history tables too.
CREATE OR REPLACE FUNCTION public.payments_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% cannot be emptied: payment history is permanent', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PaymentReceipt_no_truncate" ON public."PaymentReceipt";
CREATE TRIGGER "PaymentReceipt_no_truncate" BEFORE TRUNCATE ON public."PaymentReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payments_no_truncate();
DROP TRIGGER IF EXISTS "PaymentFeeChange_no_truncate" ON public."PaymentFeeChange";
CREATE TRIGGER "PaymentFeeChange_no_truncate" BEFORE TRUNCATE ON public."PaymentFeeChange"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payments_no_truncate();
DROP TRIGGER IF EXISTS "PaymentAllocation_no_truncate" ON public."PaymentAllocation";
CREATE TRIGGER "PaymentAllocation_no_truncate" BEFORE TRUNCATE ON public."PaymentAllocation"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payments_no_truncate();
DROP TRIGGER IF EXISTS "PaymentAuditLog_no_truncate" ON public."PaymentAuditLog";
CREATE TRIGGER "PaymentAuditLog_no_truncate" BEFORE TRUNCATE ON public."PaymentAuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION public.payments_no_truncate();

-- Row-level security, as for every table (see prisma/rls/enable-rls-all.sql).
ALTER TABLE public."PaymentPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PaymentFeeChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PaymentPhase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PaymentReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PaymentAllocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PaymentAuditLog" ENABLE ROW LEVEL SECURITY;
