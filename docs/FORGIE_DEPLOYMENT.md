# Forgie — Deployment Guide

This document covers what's needed to take Forgie from `feature/chatbot-v0`
to live on production. Follow in order.

---

## 1. Prerequisites

- Branch `feature/chatbot-v0` merged or rebased into `main`.
- Supabase database accessible (the new tables — `AssistantConversation`,
  `AssistantMessage`, `AssistantUsage`, `AssistantResponseCache`,
  `AssistantAuditLog`, `DailyLogDraft`, `StandupDigest` — were already
  pushed during dev via `pnpm db:push`).
- Three LLM provider accounts with at least one API key each:
  - **Groq** — https://console.groq.com (key starts with `gsk_`)
  - **Google Gemini** — https://aistudio.google.com/app/apikey
  - **Cerebras** — https://cloud.cerebras.ai

---

## 2. Render environment variables

Open Render → your `rig-forge` service → **Environment** → add these
keys (no spaces around `=`):

```
ASSISTANT_ENABLED=true

# Comma-separated lists — add more keys later by appending
OPENAI_API_KEYS=sk-xxxx
GROQ_API_KEYS=gsk_xxxx,gsk_yyyy
GEMINI_API_KEYS=AIzaXxxx,AIzaYyyy
CEREBRAS_API_KEYS=csk-xxxx,csk-yyyy

# Provider preference, comma-separated. OpenAI first; the rest are fallbacks.
ASSISTANT_PROVIDER_ORDER=openai,groq,gemini,cerebras

# Models per provider
OPENAI_MODEL=gpt-4.1-mini
GROQ_MODEL=llama-3.3-70b-versatile
GEMINI_MODEL=gemini-flash-latest
CEREBRAS_MODEL=gpt-oss-120b

# Soft rate-limit per user (messages per hour)
ASSISTANT_USER_MSG_PER_HOUR=30

# Cron secret — use a long random string. Required for the
# auto-drafted daily logs, standup digest, and project health
# watchdog to be callable from an external scheduler.
CRON_SECRET=<generate-a-long-random-string>

# GitHub integration — optional. Skip these to disable Forgie's
# GitHub tools (recommended only if your team uses GitHub).
GITHUB_TOKEN=github_pat_xxxx
GITHUB_ORG=RIG-360-MEDIA

# Google Calendar + Meet — optional. When set, each user can connect
# their personal Google account from Profile → Connect Google.
# Production redirect URI must match what's in Google Cloud Console.
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx
GOOGLE_REDIRECT_URI=https://rig-forge.onrender.com/api/auth/google/callback
```

Save → Render auto-redeploys (~2 minutes).

---

## 3. Verify the basics

After redeploy completes:

1. Open `https://rig-forge.onrender.com/api/health` — should return
   `{"ok":true,"db":"up"}`.
2. Open the site, log in as any user.
3. Look for the **Forgie** pill button in the topbar (sparkle icon,
   left of the notification bell).
4. Click it → side panel slides in from the right.
5. Type "What's on my plate this week?" → you should see tokens
   streaming in within ~1 second.
6. Try a refusal: "What's Pranav's salary?" — should get a witty
   redirect, varied across attempts.
7. Try a write: "Create a task for me — review OSINT scanner, due
   Friday" — confirmation card should appear with Confirm/Cancel.

If any of these fails, check `Render → Logs` for stack traces.

---

## 4. Wire the cron jobs

Render free tier doesn't support cron natively. Three options, in
order of recommendation:

### Option A: cron-job.org (free, simplest)

Visit https://cron-job.org → Sign up → "Create cronjob" for each:

| Title | URL | Schedule (UTC) | Method | Header |
|---|---|---|---|---|
| Daily log drafts | `https://rig-forge.onrender.com/api/cron/daily-log-drafts` | `30 12 * * *` (= 6:00pm IST) | POST | `x-cron-secret: <CRON_SECRET>` |
| Standup digest | `https://rig-forge.onrender.com/api/cron/standup-digest` | `30 3 * * *` (= 9:00am IST) | POST | `x-cron-secret: <CRON_SECRET>` |
| Project health watchdog | `https://rig-forge.onrender.com/api/cron/project-health` | `0 4 * * *` (= 9:30am IST) | POST | `x-cron-secret: <CRON_SECRET>` |

Test each cron immediately by clicking "Execute now" — verify the
response is `200 OK` and the response body shows the expected counters.

### Option B: GitHub Actions

Add `.github/workflows/forgie-crons.yml`:

```yaml
name: Forgie crons
on:
  schedule:
    - cron: '30 12 * * *'   # daily-log-drafts (6pm IST)
    - cron: '30 3 * * *'    # standup-digest (9am IST)
    - cron: '0 4 * * *'     # project-health (9:30am IST)
jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - name: Pick endpoint based on schedule
        id: pick
        run: |
          case "${{ github.event.schedule }}" in
            '30 12 * * *') echo "url=https://rig-forge.onrender.com/api/cron/daily-log-drafts" >> $GITHUB_OUTPUT ;;
            '30 3 * * *') echo "url=https://rig-forge.onrender.com/api/cron/standup-digest" >> $GITHUB_OUTPUT ;;
            '0 4 * * *') echo "url=https://rig-forge.onrender.com/api/cron/project-health" >> $GITHUB_OUTPUT ;;
          esac
      - name: POST to endpoint
        run: |
          curl -sf -X POST \
            -H "x-cron-secret: ${{ secrets.CRON_SECRET }}" \
            "${{ steps.pick.outputs.url }}"
```

Add `CRON_SECRET` as a repository secret (Settings → Secrets and
variables → Actions).

### Option C: Upgrade Render to Starter ($7/mo)

Render Starter supports native cron jobs in `render.yaml`. See
https://render.com/docs/cronjobs.

---

## 4b. Keep the WhatsApp bridge alive (REQUIRED on free tier)

⚠️ This is separate from the LLM crons above and is the #1 cause of
"WhatsApp stopped working" complaints.

The bridge (`forgie-whatsapp-bridge`) is a Render **free** web service.
Free services spin down after ~15 min with no inbound HTTP. Incoming
WhatsApp messages do **not** count as traffic to the bridge, so nothing
keeps it awake on its own. Once it spins down the Baileys socket dies,
messages stop forwarding, and a long-enough outage makes WhatsApp drop
the device link — forcing a QR re-scan at `/qr`.

To keep it warm, ping its public `/health` every ~10 minutes. Two ways:

**Built-in (committed):** `.github/workflows/keepalive.yml` runs every
10 min and pings both the bridge and the main app. Confirm it's enabled
under the repo's **Actions** tab (GitHub disables scheduled workflows
after 60 days of repo inactivity — push any commit to re-enable).

**More reliable, also free:** add a cron-job.org monitor:

| Title | URL | Schedule | Method |
|---|---|---|---|
| Bridge keep-alive | `https://forgie-whatsapp-bridge.onrender.com/health` | every 10 min | GET |
| App keep-alive | `https://rig-forge.onrender.com/api/health` | every 10 min | GET |

Both `/health` endpoints are public (no secret) and return `200` —
nothing sensitive is exposed.

> ❗ Keep-alive only fixes idle spin-down. Render free tier also caps
> total instance-hours (~750/month, shared across the account). Two
> services running 24/7 exceed that, so they will still be suspended
> mid-month. For a bridge that **never** stops, upgrade it to Starter
> ($7/mo) — set `plan: starter` in `whatsapp-bridge/render.yaml`.

---

## 5. Smoke checklist (after cron wiring)

- [ ] Manually trigger daily-log-drafts via cron service "Execute now"
      → response shows `drafted: N`.
- [ ] Open `/dashboard` as a user who had activity today → see
      "Daily log drafted by Forgie" card with their summary.
- [ ] Tap "Looks good — submit" → see green "Done" tick. Reload page,
      verify a real DailyLog row was created for that user/date.
- [ ] Manually trigger standup-digest → response shows `digestId`.
- [ ] Reload `/dashboard` → see "Team standup · Today" card with the
      narrative.
- [ ] Manually trigger project-health → response shows counters.
      Check `/dashboard` notifications for any health-alert pings.
- [ ] Visit `/dashboard/assistant` as an admin → KPI cards populated,
      tables show real provider + user data.

---

## 6. Rolling back

If anything goes wrong:

- Quick disable: set `ASSISTANT_ENABLED=false` in Render env → Forgie
  silently disabled, rest of site keeps working.
- Branch rollback: `git reset --hard v1.0-pre-whatsapp && git push --force origin main`
  on the local machine → Render auto-redeploys to pre-Forgie state.
- Database additions are non-breaking (only new tables + columns).
  Safe to leave them in place even after a rollback.

---

## 7. Monitoring

After ~1 week of usage, check `/dashboard/assistant` (admin) to see:

- Total messages / conversations / actions executed
- Provider distribution — confirm fallback is working (you'll see
  traffic on Groq + Cerebras; Gemini if quotas allow)
- Top users — who's actually using Forgie
- Recent action feed — every write Forgie performed

Free-tier quota tips:

- Groq: 100k tokens/day per key. With ~30 users averaging 5 queries/
  day, two keys is plenty.
- Gemini: 60 requests/day on the free model. Use as 2nd-tier
  fallback only.
- Cerebras: high limits on free tier, good as primary or 2nd-tier.

If you hit limits regularly, add more API keys to the existing
`*_API_KEYS` env vars — Forgie rotates through them automatically.

---

## 8. Where to tune

| What | File |
|---|---|
| Bot personality / tone / refusal rules | `lib/assistant/prompts.ts` |
| Rate limit | `ASSISTANT_USER_MSG_PER_HOUR` env var |
| Tool definitions (LLM capabilities) | `lib/assistant/ai-sdk-tools.ts` |
| Daily-log draft prompt | `lib/assistant/daily-log-draft.ts` |
| Standup digest prompt | `lib/assistant/standup-digest.ts` |
| Project-health threshold | `HEALTH_THRESHOLD` const in `app/api/cron/project-health/route.ts` |
| Cache TTL | `TTL_MS` const in `lib/assistant/cache.ts` |
| LLM fallback chain | `ASSISTANT_PROVIDER_ORDER` env var |
