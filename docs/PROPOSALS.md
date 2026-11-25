# Fee proposals

Built for Trijya: write a client fee proposal in their letterhead in a couple of minutes, download it as a PDF, and turn the accepted one into a project with its payment schedule. Modelled on their 2026 proposal "80 - Mr K C Singhal - Resort Proposal" and the older offers on the NAS.

A proposal goes to a client before there is a project, so proposals live in **Workspace**, not inside a project. The project is created (or an existing one picked) when the client accepts.

## What it does

| Where | What |
|---|---|
| Workspace → **Proposals** tab | Every proposal, with its reference number and status (Draft, Sent, Accepted, Declined), filters and search, the project it became, and a Download PDF link. |
| **Firm details** (once per company) | The firm name is fixed: **Trijya Design Studio** (`FIRM_NAME`); it cannot be changed. Editable: services line, address, email, logo, signatory, reference numbering (prefix and the next number for this financial year), cheque payee, bank details, PAN, GSTIN, and the standard terms (client's responsibilities, reimbursables, no-deductions, force majeure, indemnity, copyright, interpretation and arbitration under the Council of Architecture). |
| **New proposal** | Client, kind of project, site, disciplines (Architecture, Structural, MEP and fire safety, Interior), notes for the AI, and the fee table (Trijya's standard Rs 100/sq ft schedule by discipline, editable), GST, landscape per acre, site visits, out-of-state visit rate. No project needed. |
| **AI** | Writes only the wording: subject, cover letter, project brief, scope of work per discipline (starting from Trijya's standard deliverables, adapted to the project) and exclusions the notes ask for. Fees, numbers and legal terms never come from the AI. If no AI provider answers, the standard text is used and the editor says so. |
| **Editor** | Every part can be edited before sending; "Rewrite wording with AI" keeps the fees as edited. |
| **Download PDF** | A real PDF file made on the server (`GET /api/proposals/[id]/pdf`, `lib/proposal-pdf.tsx`, @react-pdf/renderer with the Poppins fonts in `lib/fonts/poppins`), so it saves on any computer or phone without a print dialog. Named like Trijya's files: `82 - Mr. K C Singhal - Resort Proposal.pdf`. |
| **Preview** | The same document on screen (`/print/proposals/[id]`), fitted to a phone's width, with Download PDF and Print buttons. |
| **Mark as sent** | The letterhead and terms are frozen into the proposal, so later changes to Firm details do not alter what the client received. Sent proposals cannot be edited; "Reopen as draft" to revise. |
| **Client accepted** | Create a new project (name suggested from the client and site; the admin accepting becomes its lead) or pick an existing one; enter the built-up area (and landscape acres). The project's Payments are set up from the fee table: each stage at its rate x area, landscape as a fixed stage, GST as quoted. |

**Who can see it**: ADMIN and SUPER_ADMIN only (proposals carry bank details), checked on every request; the Workspace tab shows only for Trijya (the company with the NAS). Employees, project leads and outside accounts get no tab and a 403.

**Reference numbers**: `TDS/Offer/DD/Arch/81/2026-27`. Numbers run per Indian financial year: the first proposal dated on or after 1 April starts again at 1 (`.../1/2027-28`). They are given one at a time per company and never reused (a deleted draft's number is skipped). The proposal's date decides its year.

**Safety rails**: no proposal can contain "speed money" or similar wording (an old 2023 offer did); only drafts can be edited or deleted.

## API

- `GET, POST /api/proposals`: list, create a draft.
- `GET, PATCH, DELETE /api/proposals/[id]`: read (with the letterhead to print with), edit / rewrite / mark sent, reopen or declined, delete a draft.
- `POST /api/proposals/[id]/accept`: `{ area, landscapeAcres?, projectId? | projectName? }`.
- `GET /api/proposals/[id]/pdf`: the PDF (`?inline=1` to open instead of download).
- `GET, PUT /api/proposal-settings`: Firm details.

## Go-live

1. Apply `prisma/manual/2026-11-14-proposals.sql` (first release) and `prisma/manual/2026-11-25-proposals-workspace.sql` (proposals without a project, numbering per financial year) before deploying. Both are safe to run on the live database before the deploy and safe to run twice.
2. Deploy.
3. As a Trijya admin: Workspace → Proposals → Firm details: check the letterhead, logo and bank details, and set the next number (81 after "80 - Mr K C Singhal").
4. The AI uses the same providers as Forgie (OpenAI on Render, then Groq/Gemini).

## Tested (sandbox `dev_perm`)

- 27 API checks: access for every role, the old project route gone, firm name fixed, proposals without a project, PDF download (type, file name, employee refused), numbering across 31 March / 1 April 2027 and under 3 simultaneous creates, sending freezes the letterhead, accepting into a new project and into an existing one with the right payment schedule.
- In a browser (Edge), desktop and phone: the Workspace tab, Firm details, New proposal, Download PDF from the list, the editor and the preview (each saves a real PDF file), the accept form, and no tab for employees.
