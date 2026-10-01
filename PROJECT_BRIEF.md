# Signal — Project Brief (for dev handoff)

## What it is
Website change-monitoring SaaS. Competitor to Visualping. Tracks pages for
content/SEO changes, screenshots, uptime, sitemap/new-page detection, broken
outbound-link outreach finder, public shareable change-history pages.

## Live
- App: https://signal-4192.onrender.com (Render, free tier)
- Code: https://github.com/malirashid742/signal
- DB/Auth: Supabase project "Signal MVP" (ref: pqecmdfkcqxqfeihcuun)

## Stack
- Node.js + Express, vanilla HTML/CSS/JS (no frontend framework)
- Supabase: Postgres + Auth (email/password) + Storage
- Render: hosting (free tier, 512MB RAM — screenshots disabled by default,
  see DISABLE_SCREENSHOTS env var)
- GitHub: source + (intended) daily cron via Actions

## Architecture — dual-mode data layer
Two completely separate data paths, chosen per-request via cookie:
1. **Demo mode** (`demo_mode=1` cookie, set by `/demo` route): reads/writes
   local JSON files under `data/`. Seeded once via `node seed-demo.js`. For
   anyone trying the product without signing up. NOT persisted on Render
   redeploy (ephemeral disk) — that's fine, it's just a sample.
2. **Real accounts** (`sb_access_token` / `sb_refresh_token` cookies, Supabase
   session): every read/write goes through Postgres via a per-request
   Supabase client carrying that user's JWT (`req.db`), so Row Level Security
   enforces "a user only ever sees their own rows." Survives redeploys.

Public, no-login tools (`/api/check`, `/api/site-scan`, `/page/:id`,
`/leaderboard`, `/api/subscribe`, `/api/contact`) are untouched by this and
stay file-based — they're not tied to an account.

## Data model (Supabase, all RLS-enabled)
- `profiles` (id, first_name, last_name, email, timezone, use_case, plan,
  created_at) — auto-created by DB trigger `handle_new_user` on signup, which
  reads `first_name`/`last_name` out of the signup's `user_metadata`. **Name +
  email are always captured at signup** — business requirement, enables
  email marketing exports later via Supabase Table Editor → profiles →
  Export CSV. No code needed for that export.
- `monitors` (id, user_id, url, page_id, condition, frequency, channels,
  slack_webhook, discord_webhook, status, created_at, last_checked_at)
- `snapshots` (id, page_id, fetched_at, title, meta_desc, h1, h2, word_count,
  body_text_hash, internal_links, external_links, images, schema_types,
  screenshot_file, screenshot_diff_file, screenshot_diff_percent)
- `uptime_pings` (id, page_id, checked_at, status, up, response_time_ms)
- `sitemap_snapshots` (id, origin, fetched_at, urls) — open to any
  authenticated user; domain-level, not sensitive
- `subscriptions` (id, user_id, plan, stripe_customer_id,
  stripe_subscription_id, status, current_period_end, created_at) — billing,
  not yet wired to a real payment processor

## Why SECURITY DEFINER functions instead of the service_role key
The daily cron job (checks every user's monitors) runs with no user session —
just the anon key. RLS would return zero rows cross-user. Rather than use the
powerful `service_role` key (bypasses ALL security), we added narrow Postgres
functions (`cron_list_monitors`, `cron_insert_snapshot`,
`cron_insert_uptime_ping`, `cron_update_monitor_status`,
`cron_get_last_snapshot`, `cron_list_snapshots`, `cron_list_uptime_pings`,
`cron_update_snapshot_screenshot`) marked `SECURITY DEFINER`, granted to
`anon`. Each does exactly one job. Verified by testing with
`set local role anon;` before calling them.

## Key files
- `server.js` — main app. Auth middleware (lines near top), auth endpoints
  (`/api/auth/signup|login|logout|session`), dual-mode profile/monitor/
  history/uptime functions + their API endpoints, public tools, share cards,
  leaderboard.
- `supabaseClient.js` — exports `supabase` (base client, auth ops only) and
  `createUserClient(accessToken)` (per-request RLS-scoped client — **never**
  share one client across users/requests, `auth.uid()` in RLS depends on it).
- `alerts.js` — email (Gmail SMTP), Slack webhook, Discord webhook senders.
- `check-and-alert.js` — cron script (needs update to read monitors via
  Supabase cron_* RPCs instead of local files — IN PROGRESS, see below).
- `engine.js` — fetch/diff/sitemap/outreach logic (stable, not part of this
  migration).
- `screenshot.js` — headless Chromium capture + pixelmatch diff.
- `public/*.html` — dashboard, profile, subscription, billing, signup, login,
  onboarding, about, contact, privacy, landing.

## Env vars needed (set in Render dashboard, not in render.yaml)
- `SUPABASE_URL` = https://pqecmdfkcqxqfeihcuun.supabase.co
- `SUPABASE_ANON_KEY` = (anon/publishable key from Supabase dashboard →
  Settings → API)
- `GMAIL_USER`, `GMAIL_APP_PASSWORD` (email alerts)
- `DISABLE_SCREENSHOTS=1` (already set — free tier RAM limit)

## Status as of this handoff
**Done:**
- Supabase schema, RLS policies, cron RPC functions — all live and tested
- Real signup/login/logout/session endpoints in server.js
- Dual-mode profile, monitors, snapshot history, uptime pings — all rewritten
  async, tested via `node --check`
- Discord webhook alert sender added (alerts.js) + wired into the live check
  endpoint (server.js)
- `@supabase/supabase-js` added to package.json

**NOT done yet (pending):**
- `check-and-alert.js` (the cron script) still reads/writes local JSON files
  — needs rewrite to use the `cron_*` Supabase RPCs, same pattern as
  server.js, so scheduled checks work for real accounts
- `.github/workflows/daily-check.yml` — needs to be created and confirmed
  actually scheduled on GitHub (this is also the fix for Supabase's 7-day
  free-tier auto-pause — nothing currently pings the DB on a schedule)
- `public/login.html` / `public/signup.html` — need the Visualping-style
  split-panel redesign (dark left panel: logo/tagline/feature checklist,
  white right panel: form), wired to the new `/api/auth/*` endpoints
  (current signup.html only does the old `/api/profile` call, no password
  field — will break once this ships)
- Profile/subscription/billing/integrations pages — need review against the
  new real-auth model (several still assume the old cookie-uid pattern)
- GitHub repo is not connected to this Claude session (no push access) — all
  delivery has been manual file upload via GitHub's web "Upload files"
  button. **Recommend connecting GitHub via claude.ai Settings → Connectors**
  so changes can be pushed directly instead of round-tripped as zips.

## Known gotchas for whoever picks this up
- Render free tier disk is ephemeral — anything that MUST survive a redeploy
  has to be in Supabase, not local files. Demo mode and the public anonymous
  tools (`/api/check` etc.) are intentionally file-based and fine to lose.
- Access tokens expire (~1hr); middleware auto-refreshes via the refresh
  token cookie — don't remove that fallback.
- Don't use the Supabase `service_role` key anywhere in this app. The
  SECURITY DEFINER function pattern above is the deliberate, safer
  alternative for the one place (cron) that needs cross-user access.
