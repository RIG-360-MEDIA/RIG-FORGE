-- Proposals move to Workspace: a proposal no longer needs a project (the
-- project is created, or picked, when the client accepts), and reference
-- numbers restart at 1 every financial year (1 April).
--
-- Apply BEFORE deploying the code that needs it. The code running now keeps
-- working after this: it never leaves projectId empty, and the trigger fills
-- "fy" from the reference number for rows it inserts.
-- Safe to run twice.

ALTER TABLE public."Proposal" ALTER COLUMN "projectId" DROP NOT NULL;
ALTER TABLE public."Proposal" ADD COLUMN IF NOT EXISTS "fy" TEXT;

-- Fill "fy" when an insert leaves it empty: the reference number ends with the
-- financial year ("TDS/Offer/DD/Arch/81/2026-27").
CREATE OR REPLACE FUNCTION public.proposal_fill_fy() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW."fy" IS NULL THEN
    NEW."fy" := substring(NEW."refNo" from '(\d{4}-\d{2})$');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS proposal_fill_fy ON public."Proposal";
CREATE TRIGGER proposal_fill_fy BEFORE INSERT ON public."Proposal"
  FOR EACH ROW EXECUTE FUNCTION public.proposal_fill_fy();

-- Existing proposals: from the reference number, else from the proposal date.
UPDATE public."Proposal" SET "fy" = substring("refNo" from '(\d{4}-\d{2})$') WHERE "fy" IS NULL;
UPDATE public."Proposal"
   SET "fy" = CASE WHEN extract(month FROM ("content"->>'date')::date) >= 4
                   THEN extract(year FROM ("content"->>'date')::date)::int
                   ELSE extract(year FROM ("content"->>'date')::date)::int - 1 END
              || '-' || lpad((((CASE WHEN extract(month FROM ("content"->>'date')::date) >= 4
                   THEN extract(year FROM ("content"->>'date')::date)::int
                   ELSE extract(year FROM ("content"->>'date')::date)::int - 1 END) + 1) % 100)::text, 2, '0')
 WHERE "fy" IS NULL;

ALTER TABLE public."Proposal" ALTER COLUMN "fy" SET NOT NULL;

-- The "next number" saved in Firm details so far was for this financial year.
UPDATE public."ProposalSettings"
   SET "data" = jsonb_set("data", '{firm,nextSerialFy}', '"2026-27"')
 WHERE "data" ? 'firm' AND NOT ("data"->'firm' ? 'nextSerialFy');

-- One number per company per financial year (was: per company, ever).
CREATE UNIQUE INDEX IF NOT EXISTS "Proposal_organizationId_fy_serial_key" ON public."Proposal"("organizationId", "fy", "serial");
DROP INDEX IF EXISTS public."Proposal_organizationId_serial_key";
