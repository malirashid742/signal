# Signal — Competitor Change Tracker (Complete MVP)

Tracks competitor content, links, images, screenshots, and uptime. Scores every
change for SEO impact. Free-stack, no paid infra required to run.

## Run it

```bash
npm install
node seed-demo.js      # optional: populate demo data
node server.js
```

- `/` — landing page + free single-check tool
- `/demo` — instantly populated dashboard (seeded realistic data)
- `/onboarding.html` — "Who will you be monitoring for?" step
- `/dashboard.html` — main app
- `/profile.html`, `/subscription.html`, `/billing.html` — account pages
- `/about.html`, `/contact.html`, `/privacy.html` — site pages

## What's built (all tested, not just written)

**Core tracking** — title/meta/H1/H2 diff, word-level content diff, internal +
external link diff, image diff, schema markup diff, SEO Impact Score (0-100).

**Unique features** — Publishing Velocity Score, Link-Loss Outreach Finder,
site-wide sitemap scan with false-positive-safe broken-link detection, public
shareable change-history pages with auto-generated social cards, publishing
leaderboard.

**Visual** — real headless-Chromium screenshots + pixel-diff (works free via
@sparticuz/chromium, no paid browser service).

**Uptime** — status/response-time per check, 7d/30d rollups, sparkline chart.

**Dashboard** — Overview (stat cards, changes-per-day chart, activity feed),
per-page timeline with screenshot thumbnails, workspace sidebar with user chip,
animations throughout.

**Account pages** — Profile (saves name/email/timezone/use-case, persists),
Subscription (4 tiers priced 60% below comparable Visualping plans, full
ChangeTower-style feature comparison table), Billing (plan info, real usage
count, billing email).

**Alerts** — Email (Gmail SMTP, tested), Slack (real webhook, tested against
Slack's live API), browser push notifications, daily cron respecting each
monitor's alert condition.

**Demo mode** — `node seed-demo.js` then `/demo` for instant populated dashboard.

## Pricing (built into /subscription.html)

| Plan | Price/mo | Pages | Frequency |
|---|---|---|---|
| Free | $0 | 3 | Daily |
| Starter | $4 | 10 | Daily |
| Growth | $10 | 25 | Every 12h |
| Business | $20 | 50 | Every 6h |

## Email alerts setup (free, Gmail)
1. Use/create a Gmail account, enable 2-Step Verification
2. Google Account → Security → App Passwords → generate one for "Mail"
3. Set env vars: `GMAIL_USER=you@gmail.com` `GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx`

## Deploy free (Render/Railway)
Push to GitHub → connect repo → Build: `npm install` → Start: `node server.js`
→ Free instance type → add the two Gmail env vars.

**GitHub upload note:** use "Add file → Upload files" and drag actual files —
copy-pasting file contents into GitHub's web editor can silently save an empty
file. Always verify file size/line count on GitHub after uploading.

## Known gaps (honest list)
- **Auth is a cookie, not real login.** No password, no Google OAuth. Needs
  real auth (Supabase Auth / Google OAuth) before charging money or supporting
  multi-device accounts.
- **No real billing.** Subscription page UI is complete; Stripe isn't wired —
  clicking "Upgrade" shows a placeholder alert.
- **Dashboard monitors have no email attached** (cookie-only auth) — cron's
  email alert for dashboard monitors is a no-op until real accounts exist.
  Slack works today regardless.
- **File-based storage.** Fine at small scale; move to Postgres/Supabase before
  real traffic.
- **No JS-rendering for content checks** (uses fetch, not a browser) —
  screenshots DO use a real browser; heavy SPA competitor sites may
  under-extract text/link content.
- **Site-wide scan and screenshots are resource-heavier** than a plain content
  check — fine on-demand, worth rate-limiting before scheduling across many
  pages on a free hosting tier.

## File map
```
engine.js                content/link/image extraction, diffing, SEO impact scoring,
                          sitemap crawling, outreach detection
screenshot.js             headless-browser screenshot capture + pixel diff
demo-placeholder.js        mock screenshot generator for seed data
sharecard.js               social share card (OG image) generator
alerts.js                  email + Slack sending
server.js                  Express app: all API routes, dashboard backend, public pages
check-and-alert.js         scheduled cron job (email subscriptions + dashboard monitors)
seed-demo.js               populates realistic demo data
public/index.html          landing page + free single-check tool
public/dashboard.html      main dashboard (cookie pseudo-auth)
public/onboarding.html     use-case picker
public/profile.html        account profile, saves real data
public/subscription.html   pricing + feature comparison table
public/billing.html        plan/usage/billing info
public/about.html          about page
public/contact.html        contact page
public/privacy.html        privacy policy page
```
