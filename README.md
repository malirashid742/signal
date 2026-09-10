# Signal — Competitor Change Tracker (MVP)

Tracks competitor content, links, images, screenshots, and uptime. Scores every
change for SEO impact. Free-stack, no paid infra required to run.

## What's built (all tested, not just written)

**Core tracking**
- Content diff: title, meta, H1/H2, word-level body text changes
- Internal + external link diff (added/removed, anchor text)
- Image diff (src + alt text)
- Schema markup (JSON-LD) diff
- SEO Impact Score (0-100) with plain-English reasons per change

**Unique features (no competitor tool combines these)**
- Publishing Velocity Score — pages/week a domain is shipping
- Link-Loss Outreach Finder — flags removed outbound links as backlink opportunities
- Site-wide scan — crawls a domain's sitemap, finds new pages, checks all outbound
  links for confirmed-broken targets (not just bot-blocked false positives)
- Public shareable change-history pages (`/page/:id`) with auto-generated social
  share cards
- Screenshots + real pixel-diff (headless Chromium via @sparticuz/chromium,
  works on free hosting — no paid browser service)
- Uptime + response-time monitoring per page (UptimeRobot-style stat cards)

**Dashboard** (`/dashboard.html`)
- Overview panel: stat cards, changes-per-day chart, cross-monitor activity feed
- Per-page timeline: relative time, impact badges, screenshot thumbnails,
  "Run check now"
- Add-page flow: URL → alert condition → frequency → channels
- Free tier cap: 3 monitored pages

**Alerts**
- Email (Gmail SMTP, real — tested)
- Slack (real incoming webhook — tested against Slack's live API)
- Browser push notifications (tab must be open)
- Daily cron (`check-and-alert.js`, GitHub Actions) — respects each monitor's
  alert condition (any change / high-impact only / outreach only)

**Demo mode**
- `node seed-demo.js` then visit `/demo` — instantly populated dashboard with
  realistic fake data (no waiting on live checks)

## Setup

```bash
npm install
node seed-demo.js      # optional: populate demo data
node server.js
```

Visit `http://localhost:3000` (landing page) or `http://localhost:3000/demo`
(populated dashboard).

## Email alerts setup (free, Gmail)
1. Use/create a Gmail account
2. Enable 2-Step Verification
3. Google Account → Security → App Passwords → generate one for "Mail"
4. Set env vars: `GMAIL_USER=you@gmail.com` `GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx`

## Deploy free
- Render.com or Railway free tier — push this repo, set the env vars above
- GitHub Actions (`.github/workflows/daily-check.yml`) runs the cron daily —
  add `GMAIL_USER`/`GMAIL_APP_PASSWORD` as repo secrets

## Known gaps (honest list)
- **Auth is a cookie, not real login.** No password, no Google OAuth. Fine for a
  single-browser demo; needs real auth (Supabase Auth / Google OAuth) before
  charging money or supporting multi-device accounts.
- **No billing.** Pricing tiers are designed (see product doc) but Stripe isn't
  wired yet.
- **Dashboard monitors have no email attached** (cookie-only auth) — so the cron's
  email alert for dashboard monitors is a no-op until real accounts exist. Slack
  works today; email works today for the old landing-page "Notify me" flow, not
  yet for dashboard-created monitors.
- **File-based storage.** Works fine at small scale; move to Postgres/Supabase
  before real traffic — GitHub Actions committing screenshots back to a repo will
  not scale.
- **No JS-rendering for plain content checks** (uses fetch, not a browser) —
  screenshots DO use a real browser, but the text/link/image diff engine reads
  raw HTML, so heavy SPA competitor sites may under-extract content.
- **Site-wide scan and screenshot capture are resource-heavier** than a plain
  content check — fine for on-demand dashboard use, worth rate-limiting before
  running on a schedule across many pages on a free hosting tier.

## File map
```
engine.js              content/link/image extraction, diffing, SEO impact scoring,
                        sitemap crawling, outreach detection
screenshot.js           headless-browser screenshot capture + pixel diff
demo-placeholder.js      mock screenshot generator for seed data
sharecard.js             social share card (OG image) generator
alerts.js                email + Slack sending
server.js                Express app: all API routes, dashboard backend, public pages
check-and-alert.js       scheduled cron job (email subscriptions + dashboard monitors)
seed-demo.js             populates realistic demo data
public/index.html        landing page + free single-check tool
public/dashboard.html    logged-in-style dashboard (cookie pseudo-auth)
```
