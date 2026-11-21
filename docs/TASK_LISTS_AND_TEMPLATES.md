# Task lists, categories and templates

Branch `feature/task-categories`. Built for Trijya (Vinay): plan a project's work by category, fill it from ready-made templates, and hand it out in a few clicks.

## What it does

| Where | What |
|---|---|
| Project → **Task List** tab | The plan of work, grouped by category (Electrical, Plumbing, Drawings...). Numbered in template order. **+ Assign** on each item (person, deadline, priority, one Save). Tick items or a whole category, then set person / deadline / priority / category and **Apply** once. Quick add (type, Enter) and paste a list (one item per line). Filters with counts; search. |
| Project → **Tasks** tab | Only work that has been given to someone, by status, with its category. Shows how many plan items are still unassigned. |
| Projects → **Task templates** | Company-wide ready-made lists. **Import from Excel** (one template per sheet, one category per section; Zoho exports work), editor, archive. |
| **New project** | Tick one or more task list templates; their items fill the Task List. |
| Notifications | People are told (in app and by phone push) when they are given tasks; one message per person per project. |

**Who can do what**: admins with task permissions, and the project's lead, build the list, assign and apply templates. Only admins manage templates and rename or archive categories. Employees see the Task List read-only and change the status of their own tasks. External (client) users never manage anything.

## Go-live checklist

1. Apply to the **production** database, in this order, before deploying. Both files only add tables and columns, are safe to run twice, and switch on row-level security for the new tables:
   - `prisma/manual/2026-10-23-task-categories.sql`
   - `prisma/manual/2026-10-24-task-templates.sql`
2. Merge `feature/task-categories` into `main` (Render deploys it).
3. Import Trijya's `Project Task Template.xlsx` from Projects → Task templates → Import from Excel, as a Trijya admin. Fix the section typos in the preview (CIVL WORKS, FALSE CEILNG, MISCELLENEOUS).
4. Check on production (cannot be checked locally):
   - Log in as a Trijya user and as a RIG 360 user: each sees only its own categories and templates.
   - Assign a task to someone with phone notifications on: the push arrives.

To undo: revert the merge on `main`. The new tables stay unused; no existing data is changed by this feature.

## Tested (sandbox `dev_perm`)

- API pressure test, 132 cases: permissions for every role, bad input, limits (200-line paste, 500-item templates, 506-task projects), duplicates, and simultaneous requests (bursts of 20 to 25).
- Excel import, 21 edge cases: empty, huge, CSV, formulas, dates, Zoho exports, non-workbook files.
- Production build, the 218 existing tests, and the screens as admin and employee, desktop and phone.

## Known limits

- The database pool has 5 connections. Under a burst of simultaneous saves on the same tasks, some get "Busy, nothing was changed, try again" (503), never a partial save.
- Not built yet: dates in templates ("day 10 from start"), a default person per category, a "My tasks" page across projects, categories from Forgie.
