# Project payments

Branch `feature/payments` (built on `feature/task-categories`). A record, per project, of the agreed fee, what the client is billed in each phase, what they have paid, and what is left. Admins only.

## What it does

| Where | What |
|---|---|
| Project → **Payments** tab | Fee, received, outstanding and "on account" at a glance, with a progress bar and warnings (phases do not add up to the fee, more received than the fee, money not yet counted against a phase). |
| **Set up the fee** | Either a **fixed fee**, or a **% of the construction cost** (estimated cost × percent). Set once; after that it only changes through fee changes. |
| **Change fee** | A **variation** (extra or less work) or a **correction**, plus or minus, with a reason. On a % fee, a **cost revision** enters the new estimated cost and the fee moves by the percent of the difference. Every change is kept and listed; the current fee is always the total. |
| **Billing phases** | Concept, Drawings, Site... each with an amount (in rupees, or a % of the fee), a due date and a note. Paid / part paid / unpaid / overdue. Reorder, edit, archive (only if nothing was received against it). |
| **Record payment** | Amount, date, mode (bank, UPI, cheque, cash, other), reference (UTR / cheque no.), payer, note, and how much counts against each phase ("Fill in phase order" splits it automatically). Anything not counted against a phase stays **on account** and can be counted later. |
| **Reverse** | A payment entered by mistake, or a bounced cheque, is reversed with a reason. It stays in the list, struck through, and drops out of every total. |
| **History** | Every action, by whom and when, in plain words. |

**Who can see it**: only ADMIN and SUPER_ADMIN (their base role), checked on the server for every request. Project leads, employees and external (client) users get no tab and a 403 from the API, even on projects they lead.

## How it stays honest

- Money is stored as whole paise (BigInt), never floating point. "3,33,333.33" three times plus 0.01 is exactly ₹10,00,000.
- Nothing is edited or deleted: fee changes, payments counted against phases and the history are append-only, and a payment can only be reversed (once, with a reason). The database itself enforces this with triggers, so a script, a bug or a direct SQL edit cannot rewrite history either; even emptying a table (TRUNCATE) is refused. Amounts must be more than 0 and modes must be known values, also in the database.
- Totals are always calculated from the entries, never stored, so they cannot drift.
- A phase can never be paid more than its amount; a phase amount can never go below what was already received against it.
- Possible duplicates (same amount on the same day, or same amount and reference) are stopped with a warning; the admin must confirm they are separate payments.
- Every change to a project's payments is done one at a time (a database lock per project), so two people recording at the same moment cannot over-pay a phase.
- Projects are only archived in Forge, never deleted, and the database refuses to delete a project that has payment records.

## Go-live checklist

1. Apply the task list SQL first (see `docs/TASK_LISTS_AND_TEMPLATES.md`), then, before deploying, apply to the **production** database:
   - `prisma/manual/2026-11-12-project-payments.sql`

   It only adds tables, is safe to run twice, and switches on row-level security for the new tables.
2. Merge into `main` (Render deploys it).
3. Check on production (cannot be checked locally): log in as a Trijya admin and a RIG 360 admin; each sees only its own company's payments.

To undo: revert the merge. The tables stay, unused; no existing data is changed by this feature.

## Tested (sandbox `dev_perm`)

- API pressure test, 74 cases: every role, bad amounts and dates, over-payment, payments counted against another project's phase, duplicates, reversal, on-account, fee changes on both kinds of fee, exact paise arithmetic, and simultaneous requests (10 payments into a phase with room for 3: exactly 3 counted; 3 simultaneous setups and reversals: exactly one each).
- Direct database tampering, 18 cases: editing, deleting or emptying payment history is refused; the one allowed change (a full reversal) still works.
- The screen as admin and as an employee who leads the project.

## Not built yet

- Invoices (asked for later).
- GST and TDS (not needed for now).
- Linking phases to tasks ("ready to bill" when the work is done), payment schedule templates, an all-projects payments overview, Excel export.
