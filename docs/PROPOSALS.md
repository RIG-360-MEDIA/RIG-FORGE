# Fee proposals

Branch `feature/payments`. Built for Trijya: write a client fee proposal in their letterhead in a couple of minutes, and turn the accepted one into the project's payment schedule. Modelled on their 2026 proposal "80 - Mr K C Singhal - Resort Proposal" and the older offers on the NAS.

## What it does

| Where | What |
|---|---|
| Project → **Proposals** tab | The project's proposals with their reference number and status (Draft, Sent, Accepted, Declined). |
| **Firm details** (once per company) | Letterhead (name, services line, address, email, logo), signatory, reference numbering (prefix and next number, e.g. `TDS/Offer/DD/Arch` and 81), cheque payee, bank details, PAN, GSTIN, and the standard terms (client's responsibilities, reimbursables, no-deductions, force majeure, indemnity, copyright, interpretation and arbitration under the Council of Architecture). |
| **New proposal** | Client, kind of project, site, disciplines (Architecture, Structural, MEP and fire safety, Interior), notes for the AI, and the fee table (Trijya's standard Rs 100/sq ft schedule by discipline, editable), GST, landscape per acre, site visits, out-of-state visit rate. |
| **AI** | Writes only the wording: subject, cover letter, project brief, scope of work per discipline (starting from Trijya's standard deliverables, adapted to the project) and exclusions the notes ask for. Fees, numbers and legal terms never come from the AI. If no AI provider answers, the standard text is used and the editor says so. |
| **Editor** | Every part can be edited before sending; "Rewrite wording with AI" keeps the fees as edited. |
| **Preview and download PDF** | An A4 document in the letterhead style (cover letter page with logo, running header and footer with page numbers, lettered sections, the fee table by discipline, bank details). The browser's "Save as PDF" names the file like theirs: `82 - Mr. K C Singhal - Resort Proposal`. |
| **Mark as sent** | The letterhead and terms are frozen into the proposal, so later changes to Firm details do not alter what the client received. Sent proposals cannot be edited; "Reopen as draft" to revise. |
| **Client accepted** | Asks for the built-up area (and landscape acres) and sets up the project's Payments from the fee table: each stage at its rate x area, landscape as a fixed stage, GST as quoted. |

**Who can see it**: ADMIN and SUPER_ADMIN only (proposals carry bank details), checked on every request. Employees and project leads get no tab and a 403.

**Safety rails**: reference numbers are given one at a time per company and never reused (a deleted draft's number is skipped); no proposal can contain "speed money" or similar wording (an old 2023 offer did); only drafts can be edited or deleted.

## Go-live

1. Apply, in order, before deploying: the task list SQL files, `prisma/manual/2026-11-12-project-payments.sql`, then `prisma/manual/2026-11-14-proposals.sql`.
2. Merge and deploy.
3. As a Trijya admin, open any project → Proposals → Firm details: enter the letterhead, logo, bank details, and set the next number to follow their last offer (81 after "80 - Mr K C Singhal").
4. The AI uses the same providers as Forgie (OpenAI on Render, then Groq/Gemini).

## Tested (sandbox `dev_perm`)

- 26 API checks: access for every role, bad input, "speed money" blocked, edits, sending freezes the letterhead, accepted proposal creates the right payment schedule (Rs 82.50/sq ft x 4,000 sq ft + 0.5 acre landscape = Rs 4,80,000, GST 18%), numbers unique under 3 simultaneous creates and never reused.
- The PDF rendered by Edge (the same engine as Chrome's "Save as PDF") and checked page by page against the original.
