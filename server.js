const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const { v4: uuidv4 } = require("uuid");
const { fetchPage, fetchPageWithMeta, extractData, diffSnapshots, fetchSitemapUrls, diffSitemap, publishingVelocity, outreachOpportunities, checkLinksInPool } = require("./engine");
const { generateShareCard } = require("./sharecard");
const { sendSlackAlert } = require("./alerts");
const { captureScreenshot, compareScreenshots } = require("./screenshot");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// Lightweight pseudo-account: a uid cookie identifies "this browser" as a user.
// NOT real auth (no password, no real Google OAuth) — good enough for a free MVP
// dashboard demo. Swap for real auth (Supabase Auth / Google OAuth) before charging
// money or storing anything sensitive.
app.use((req, res, next) => {
  let uid = req.cookies.uid;
  if (!uid) {
    uid = uuidv4();
    res.cookie("uid", uid, { maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: true });
  }
  req.uid = uid;
  next();
});

// GET /demo — switches this browser to the seeded demo account (uid "demo-user")
// so anyone can see a fully populated dashboard instantly, without waiting on real
// checks. Run `node seed-demo.js` once to generate the demo data.
app.get("/demo", (req, res) => {
  res.cookie("uid", "demo-user", { maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: true });
  res.redirect("/dashboard.html");
});

const DATA_DIR = path.join(__dirname, "data");
const SITEMAP_DIR = path.join(DATA_DIR, "sitemaps");
const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SITEMAP_DIR)) fs.mkdirSync(SITEMAP_DIR, { recursive: true });
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// Screenshots are stored as files (not JSON) — keep only the last N per page to
// control disk usage, since PNGs are much bigger than our JSON snapshots.
const MAX_SCREENSHOTS_PER_PAGE = 5;

function screenshotDir(pageId) {
  const dir = path.join(SCREENSHOTS_DIR, pageId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveScreenshot(pageId, buffer, label) {
  const dir = screenshotDir(pageId);
  const filename = `${Date.now()}-${label}.png`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  // prune old screenshots beyond the cap
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png") && !f.includes("-diff")).sort();
  while (files.length > MAX_SCREENSHOTS_PER_PAGE) {
    fs.unlinkSync(path.join(dir, files.shift()));
  }
  return filename;
}

function latestScreenshotFile(pageId) {
  const dir = screenshotDir(pageId);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png") && !f.includes("-diff")).sort();
  return files.length ? files[files.length - 1] : null;
}

// Best-effort screenshot capture + visual diff — never blocks or fails the main
// content check if the headless browser has an issue (slow site, timeout, etc).
async function captureAndDiffScreenshot(pageUrl, pageId) {
  try {
    const prevFile = latestScreenshotFile(pageId);
    const newBuffer = await captureScreenshot(pageUrl);
    const newFilename = saveScreenshot(pageId, newBuffer, "shot");

    if (!prevFile) {
      return { hasPrevious: false, newScreenshot: newFilename };
    }

    const prevBuffer = fs.readFileSync(path.join(screenshotDir(pageId), prevFile));
    const result = compareScreenshots(prevBuffer, newBuffer);
    let diffFilename = null;
    if (result.diffBuffer) {
      diffFilename = `${Date.now()}-diff.png`;
      fs.writeFileSync(path.join(screenshotDir(pageId), diffFilename), result.diffBuffer);
    }
    return { hasPrevious: true, previousScreenshot: prevFile, newScreenshot: newFilename, diffScreenshot: diffFilename, diffPercent: result.diffPercent, comparable: result.comparable };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------- UPTIME / RESPONSE-TIME TRACKING ----------
const UPTIME_DIR = path.join(DATA_DIR, "uptime");
if (!fs.existsSync(UPTIME_DIR)) fs.mkdirSync(UPTIME_DIR, { recursive: true });

function uptimeFile(pageId) {
  return path.join(UPTIME_DIR, `${pageId}.json`);
}
function loadUptimePings(pageId) {
  const f = uptimeFile(pageId);
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, "utf8"));
}
function saveUptimePings(pageId, pings) {
  // keep last 500 pings — enough for 7/30-day stats even at frequent check intervals
  fs.writeFileSync(uptimeFile(pageId), JSON.stringify(pings.slice(-500), null, 2));
}

function computeUptimeStats(pageId) {
  const pings = loadUptimePings(pageId);
  if (!pings.length) return null;

  const now = Date.now();
  const DAY = 86400000;
  const inWindow = (p, days) => (now - new Date(p.at).getTime()) / DAY <= days;

  function statsFor(days) {
    const windowPings = pings.filter((p) => inWindow(p, days));
    if (!windowPings.length) return null;
    const upCount = windowPings.filter((p) => p.up).length;
    const uptimePercent = Math.round((upCount / windowPings.length) * 10000) / 100;
    const times = windowPings.filter((p) => p.up && p.responseTimeMs != null).map((p) => p.responseTimeMs);
    return {
      uptimePercent,
      checksInWindow: windowPings.length,
      incidents: windowPings.filter((p) => !p.up).length,
      avgResponseMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      minResponseMs: times.length ? Math.min(...times) : null,
      maxResponseMs: times.length ? Math.max(...times) : null,
    };
  }

  const latest = pings[pings.length - 1];
  return {
    currentStatus: latest.up ? "up" : "down",
    lastCheckedAt: latest.at,
    last7Days: statsFor(7),
    last30Days: statsFor(30),
    responseTimeSeries: pings.slice(-50).map((p) => ({ at: p.at, responseTimeMs: p.up ? p.responseTimeMs : null, up: p.up })),
  };
}

function keyFor(url) {
  return crypto.createHash("md5").update(url).digest("hex");
}
function snapFile(url) {
  return path.join(DATA_DIR, `${keyFor(url)}.json`);
}
function loadHistory(url) {
  const f = snapFile(url);
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, "utf8"));
}
function saveHistory(url, history) {
  fs.writeFileSync(snapFile(url), JSON.stringify(history.slice(-20), null, 2));
}

function sitemapFile(origin) {
  return path.join(SITEMAP_DIR, `${keyFor(origin)}.json`);
}
function loadSitemapHistory(origin) {
  const f = sitemapFile(origin);
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, "utf8"));
}
function saveSitemapHistory(origin, history) {
  fs.writeFileSync(sitemapFile(origin), JSON.stringify(history.slice(-10), null, 2));
}

// Best-effort sitemap check — never blocks or fails the main page check.
async function checkSitemap(baseUrl) {
  try {
    const origin = new URL(baseUrl).origin;
    const result = await fetchSitemapUrls(origin);
    if (!result) return null;

    const history = loadSitemapHistory(origin);
    const last = history[history.length - 1];
    history.push({ fetchedAt: new Date().toISOString(), urls: result.urls });
    saveSitemapHistory(origin, history);

    if (!last) return { mode: "baseline", totalPages: result.urls.length };

    const diff = diffSitemap(last.urls, result.urls);
    return { mode: "diff", newPages: diff.added, removedPages: diff.removed, totalPages: result.urls.length };
  } catch (e) {
    return null; // sitemap check is a bonus feature — silent fail is fine
  }
}

// ---------- MONITORS (dashboard — replaces the old single-check flow for logged-in users) ----------
const MONITORS_DIR = path.join(DATA_DIR, "monitors");
if (!fs.existsSync(MONITORS_DIR)) fs.mkdirSync(MONITORS_DIR, { recursive: true });

function monitorsFile(uid) {
  return path.join(MONITORS_DIR, `${uid}.json`);
}
function loadMonitors(uid) {
  const f = monitorsFile(uid);
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, "utf8"));
}
function saveMonitors(uid, monitors) {
  fs.writeFileSync(monitorsFile(uid), JSON.stringify(monitors, null, 2));
}

// ---------- PROFILE (name, email, timezone — saved per uid) ----------
const PROFILES_DIR = path.join(DATA_DIR, "profiles");
if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });

function profileFile(uid) {
  return path.join(PROFILES_DIR, `${uid}.json`);
}
function loadProfile(uid) {
  const f = profileFile(uid);
  if (!fs.existsSync(f)) return { firstName: "", lastName: "", email: "", timezone: "UTC", plan: "Free", useCase: null };
  return JSON.parse(fs.readFileSync(f, "utf8"));
}
function saveProfile(uid, profile) {
  fs.writeFileSync(profileFile(uid), JSON.stringify(profile, null, 2));
}

// GET /api/profile
app.get("/api/profile", (req, res) => {
  res.json(loadProfile(req.uid));
});

// POST /api/profile — body: { firstName, lastName, email, timezone, useCase }
// useCase: "myself" | "clients" | "company" — set once during onboarding
app.post("/api/profile", (req, res) => {
  const { firstName, lastName, email, timezone, useCase } = req.body;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email address." });
  }
  const existing = loadProfile(req.uid);
  const profile = {
    ...existing,
    firstName: firstName ?? existing.firstName,
    lastName: lastName ?? existing.lastName,
    email: email ?? existing.email,
    timezone: timezone ?? existing.timezone,
    useCase: useCase ?? existing.useCase,
  };
  saveProfile(req.uid, profile);
  res.json({ ok: true, profile });
});

const FREE_MONITOR_CAP = 3;

// Computes "how many changes in the last N days" for a monitor, plus total checks —
// this is what makes the dashboard feel mature instead of just a raw event list.
function computeMonitorStats(url) {
  const history = loadHistory(url);
  if (history.length < 2) {
    return { totalChecks: history.length, changesLast7Days: 0, changesLast30Days: 0, lastChangeAt: null, addedAt: history[0]?.fetchedAt || null };
  }
  const now = Date.now();
  const DAY = 86400000;
  let changesLast7Days = 0;
  let changesLast30Days = 0;
  let lastChangeAt = null;

  for (let i = 1; i < history.length; i++) {
    const diff = diffSnapshots(history[i - 1], history[i]);
    if (!diff.hasChanges) continue;
    const checkedAt = new Date(history[i].fetchedAt).getTime();
    const ageDays = (now - checkedAt) / DAY;
    if (ageDays <= 7) changesLast7Days++;
    if (ageDays <= 30) changesLast30Days++;
    lastChangeAt = history[i].fetchedAt; // last one found wins (history is chronological)
  }

  return {
    totalChecks: history.length,
    changesLast7Days,
    changesLast30Days,
    lastChangeAt,
    addedAt: history[0].fetchedAt,
  };
}

// GET /screenshots/:pageId/:filename — serve a stored screenshot or diff image
app.get("/screenshots/:pageId/:filename", (req, res) => {
  const filePath = path.join(SCREENSHOTS_DIR, req.params.pageId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.set("Content-Type", "image/png");
  res.sendFile(filePath);
});

// GET /api/monitors — list this browser's monitored pages
app.get("/api/monitors", (req, res) => {
  const monitors = loadMonitors(req.uid).map((m) => ({ ...m, stats: computeMonitorStats(m.url) }));
  res.json({ monitors, cap: FREE_MONITOR_CAP });
});

// POST /api/monitors — add a new monitored page
// body: { url, condition, frequency, channels, slackWebhook }
app.post("/api/monitors", (req, res) => {
  const { url, condition, frequency, channels, slackWebhook } = req.body;
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: "Provide a valid URL." });
  }
  const monitors = loadMonitors(req.uid);
  if (monitors.length >= FREE_MONITOR_CAP) {
    return res.status(402).json({ error: `Free plan allows ${FREE_MONITOR_CAP} monitored pages. Upgrade to add more.`, capReached: true });
  }
  const monitor = {
    id: uuidv4(),
    url,
    pageId: keyFor(url),
    condition: condition || "any_change", // any_change | high_impact | new_pages | outreach
    frequency: frequency || "daily",       // free tier only supports daily
    channels: channels || ["email"],
    slackWebhook: slackWebhook || null,
    status: "checking",
    createdAt: new Date().toISOString(),
  };
  monitors.push(monitor);
  saveMonitors(req.uid, monitors);
  res.json({ ok: true, monitor });
});

// DELETE /api/monitors/:id
app.delete("/api/monitors/:id", (req, res) => {
  const monitors = loadMonitors(req.uid);
  const filtered = monitors.filter((m) => m.id !== req.params.id);
  saveMonitors(req.uid, filtered);
  res.json({ ok: true });
});

// POST /api/monitors/:id/check — run a check now for this monitor (used for the
// "Check in progress..." live state and to populate its history panel)
app.post("/api/monitors/:id/check", async (req, res) => {
  const monitors = loadMonitors(req.uid);
  const monitor = monitors.find((m) => m.id === req.params.id);
  if (!monitor) return res.status(404).json({ error: "Monitor not found." });

  try {
    // Uptime ping is recorded regardless of outcome — a 404/500/timeout IS the data
    // point for uptime tracking, unlike content checks where it's an error to throw.
    const pageResult = await fetchPageWithMeta(monitor.url);
    const uptimePings = loadUptimePings(monitor.pageId);
    uptimePings.push({ at: new Date().toISOString(), status: pageResult.status, up: pageResult.up, responseTimeMs: pageResult.responseTimeMs });
    saveUptimePings(monitor.pageId, uptimePings);

    if (!pageResult.up) {
      // Page is down — record the outage, skip content/screenshot diffing (nothing
      // meaningful to diff), but don't treat this as a server error.
      monitor.status = "active";
      monitor.lastCheckedAt = new Date().toISOString();
      saveMonitors(req.uid, monitors);
      return res.json({ mode: "down", status: pageResult.status, error: pageResult.error, uptime: computeUptimeStats(monitor.pageId) });
    }

    const snap = extractData(pageResult.html, monitor.url);
    const history = loadHistory(monitor.url);
    const last = history[history.length - 1];

    // Screenshot capture happens before saving history so the filename can be
    // attached directly to this snapshot — ties each timeline entry to its own
    // before/after/diff images instead of matching by nearest timestamp later.
    const screenshot = await captureAndDiffScreenshot(monitor.url, monitor.pageId);
    snap.screenshotFile = screenshot.newScreenshot || null;
    snap.screenshotDiffFile = screenshot.diffScreenshot || null;
    snap.screenshotDiffPercent = screenshot.diffPercent ?? null;

    history.push(snap);
    saveHistory(monitor.url, history);

    monitor.status = "active";
    monitor.lastCheckedAt = snap.fetchedAt;
    saveMonitors(req.uid, monitors);

    const uptime = computeUptimeStats(monitor.pageId);

    if (!last) {
      return res.json({ mode: "baseline", snapshot: summarize(snap), screenshot, uptime });
    }
    const diff = diffSnapshots(last, snap);
    const outreach = outreachOpportunities(diff);

    // Fire Slack alert immediately if this monitor has a webhook configured and
    // changes were found — best-effort, never blocks or fails the check response.
    let slackSent = false;
    if (diff.hasChanges && monitor.slackWebhook) {
      try {
        await sendSlackAlert({ webhookUrl: monitor.slackWebhook, url: monitor.url, diff });
        slackSent = true;
      } catch (e) {
        console.error("Slack alert failed:", e.message);
      }
    }

    return res.json({ mode: "diff", hasChanges: diff.hasChanges, diff, outreach, screenshot, uptime, slackSent, lastCheckedAt: last.fetchedAt, currentCheckedAt: snap.fetchedAt });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/monitors/:id/history — full diff timeline for one monitor (right panel)
app.get("/api/monitors/:id/history", (req, res) => {
  const monitors = loadMonitors(req.uid);
  const monitor = monitors.find((m) => m.id === req.params.id);
  if (!monitor) return res.status(404).json({ error: "Monitor not found." });

  const history = loadHistory(monitor.url);
  const diffs = [];
  for (let i = 1; i < history.length; i++) {
    diffs.push({
      at: history[i].fetchedAt,
      diff: diffSnapshots(history[i - 1], history[i]),
      screenshotFile: history[i].screenshotFile || null,
      screenshotDiffFile: history[i].screenshotDiffFile || null,
      screenshotDiffPercent: history[i].screenshotDiffPercent ?? null,
      previousScreenshotFile: history[i - 1].screenshotFile || null,
    });
  }
  diffs.reverse();
  res.json({ monitor, diffs, checksRecorded: history.length, stats: computeMonitorStats(monitor.url), uptime: computeUptimeStats(monitor.pageId) });
});

// GET /api/dashboard-summary — aggregate stats across all of this user's monitors,
// for the top-of-dashboard header ("X changes across all pages this week" etc.)
app.get("/api/dashboard-summary", (req, res) => {
  const monitors = loadMonitors(req.uid);
  let changesLast7Days = 0;
  let changesLast30Days = 0;
  let uptimeSum = 0;
  let uptimeCount = 0;
  let downCount = 0;
  monitors.forEach((m) => {
    const stats = computeMonitorStats(m.url);
    changesLast7Days += stats.changesLast7Days;
    changesLast30Days += stats.changesLast30Days;
    const uptime = computeUptimeStats(m.pageId);
    if (uptime) {
      if (uptime.currentStatus === "down") downCount++;
      if (uptime.last7Days) { uptimeSum += uptime.last7Days.uptimePercent; uptimeCount++; }
    }
  });
  res.json({
    totalMonitors: monitors.length,
    cap: FREE_MONITOR_CAP,
    changesLast7Days,
    changesLast30Days,
    avgUptimeLast7Days: uptimeCount ? Math.round((uptimeSum / uptimeCount) * 100) / 100 : null,
    pagesDown: downCount,
  });
});

// GET /api/activity-feed — recent change events across ALL of this user's monitors,
// most recent first. Powers the dashboard Overview panel's activity list.
app.get("/api/activity-feed", (req, res) => {
  const monitors = loadMonitors(req.uid);
  const events = [];
  monitors.forEach((m) => {
    const history = loadHistory(m.url);
    for (let i = 1; i < history.length; i++) {
      const diff = diffSnapshots(history[i - 1], history[i]);
      if (diff.hasChanges) {
        events.push({ url: m.url, at: history[i].fetchedAt, impact: diff.impact.level, score: diff.impact.score, summary: diff.impact.reasons[0] || "Content updated" });
      }
    }
  });
  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({ events: events.slice(0, 20) });
});

// GET /api/changes-per-day — daily change counts across all monitors for the last
// 14 days, for the Overview bar chart.
app.get("/api/changes-per-day", (req, res) => {
  const monitors = loadMonitors(req.uid);
  const days = 14;
  const counts = {};
  for (let d = days - 1; d >= 0; d--) {
    const key = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    counts[key] = 0;
  }
  monitors.forEach((m) => {
    const history = loadHistory(m.url);
    for (let i = 1; i < history.length; i++) {
      const diff = diffSnapshots(history[i - 1], history[i]);
      if (!diff.hasChanges) continue;
      const key = history[i].fetchedAt.slice(0, 10);
      if (key in counts) counts[key]++;
    }
  });
  res.json({ labels: Object.keys(counts), values: Object.values(counts) });
});


// ---------- SITE-WIDE SCAN (new pages + site-wide outreach opportunities) ----------
// Different from a single-page monitor: given a domain, this crawls multiple pages
// from its sitemap, flags newly published pages, and checks every outbound link
// found across those pages for broken/dead targets — real backlink opportunities,
// found immediately (not only after a link gets removed between two checks).
const MAX_PAGES_PER_SCAN = 12;   // cap to keep free-tier runtime/cost sane
const MAX_LINKS_TO_CHECK = 40;   // cap outbound link checks per scan

app.post("/api/site-scan", async (req, res) => {
  const { url } = req.body;
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: "Provide a valid URL (any page on the site — we'll find its sitemap)." });
  }

  try {
    const origin = new URL(url).origin;
    const sitemapResult = await fetchSitemapUrls(origin);
    if (!sitemapResult) {
      return res.status(404).json({ error: `No sitemap.xml found at ${origin}. Site-wide scan needs a sitemap to discover pages.` });
    }

    // 1. New-page detection (reuses the same sitemap history as single-page monitoring)
    const sitemapHistory = loadSitemapHistory(origin);
    const lastSitemap = sitemapHistory[sitemapHistory.length - 1];
    sitemapHistory.push({ fetchedAt: new Date().toISOString(), urls: sitemapResult.urls });
    saveSitemapHistory(origin, sitemapHistory);
    const newPages = lastSitemap ? diffSitemap(lastSitemap.urls, sitemapResult.urls).added : [];

    // 2. Crawl a capped sample of pages (prioritize newly published pages first —
    // that's usually what people want checked for outreach opportunities)
    const toScan = [...newPages, ...sitemapResult.urls.filter((u) => !newPages.includes(u))].slice(0, MAX_PAGES_PER_SCAN);

    const pageResults = [];
    const allExternalLinks = new Map(); // linkUrl -> { anchor, foundOnPages: [] }

    for (const pageUrl of toScan) {
      try {
        const html = await fetchPage(pageUrl);
        const snap = extractData(html, pageUrl);
        pageResults.push({ url: pageUrl, title: snap.title, externalLinkCount: snap.externalLinks.length });

        snap.externalLinks.forEach((entry) => {
          const [linkUrl, anchorPart] = entry.split(" | anchor: ");
          if (!allExternalLinks.has(linkUrl)) {
            allExternalLinks.set(linkUrl, { anchor: (anchorPart || "").replace(/"/g, ""), foundOnPages: [] });
          }
          allExternalLinks.get(linkUrl).foundOnPages.push(pageUrl);
        });
      } catch (e) {
        pageResults.push({ url: pageUrl, error: e.message });
      }
    }

    // 3. Check a capped number of unique outbound links for broken/dead targets
    const linkUrls = [...allExternalLinks.keys()].slice(0, MAX_LINKS_TO_CHECK);
    const linkStatuses = await checkLinksInPool(linkUrls);

    const outreachOpportunitiesFound = linkStatuses
      .filter((r) => r.broken)
      .map((r) => ({
        brokenLink: r.url,
        status: r.status,
        anchorText: allExternalLinks.get(r.url).anchor,
        foundOnPages: allExternalLinks.get(r.url).foundOnPages,
        suggestion: `This link is broken (${r.status}). Pages linking to it are candidates for outreach — suggest your content as a replacement.`,
      }));

    const ambiguousLinks = linkStatuses
      .filter((r) => r.ambiguous)
      .map((r) => ({ url: r.url, status: r.status, reason: r.status === 403 ? "Blocked HEAD/bot request — may not actually be broken" : "Could not verify (network/timeout) — not counted as broken" }));

    res.json({
      origin,
      totalPagesInSitemap: sitemapResult.urls.length,
      newPagesFound: newPages,
      pagesScanned: pageResults,
      uniqueExternalLinksFound: allExternalLinks.size,
      linksChecked: linkUrls.length,
      outreachOpportunities: outreachOpportunitiesFound,
      ambiguousLinks,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post("/api/check", async (req, res) => {
  const { url } = req.body;
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: "Provide a valid URL starting with http:// or https://" });
  }

  try {
    const html = await fetchPage(url);
    const snap = extractData(html, url);
    const history = loadHistory(url);
    const last = history[history.length - 1];

    history.push(snap);
    saveHistory(url, history);

    const sitemap = await checkSitemap(url);

    if (!last) {
      return res.json({
        mode: "baseline",
        message: "First check — baseline saved. Check again later to see changes.",
        snapshot: summarize(snap),
        sitemap,
        pageId: keyFor(url),
      });
    }

    const diff = diffSnapshots(last, snap);
    const outreach = outreachOpportunities(diff);
    const sitemapHistory = loadSitemapHistory(new URL(url).origin);
    const velocity = publishingVelocity(sitemapHistory);

    return res.json({
      mode: "diff",
      hasChanges: diff.hasChanges,
      diff,
      outreach,
      velocity,
      sitemap,
      lastCheckedAt: last.fetchedAt,
      currentCheckedAt: snap.fetchedAt,
      pageId: keyFor(url),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------- PUBLIC SHAREABLE CHANGE-HISTORY PAGE (unique #4) ----------
// Indexable, no-login page showing the change timeline for a tracked URL.
// Good for: customers sharing findings, and for our own organic search footprint.
app.get("/page/:id", (req, res) => {
  const id = req.params.id;
  const files = fs.readdirSync(DATA_DIR).filter((f) => f === `${id}.json`);
  if (!files.length) return res.status(404).send(renderShell("Not found", "<p>No history found for this page yet.</p>"));

  const history = JSON.parse(fs.readFileSync(path.join(DATA_DIR, files[0]), "utf8"));
  if (!history.length) return res.status(404).send(renderShell("Not found", "<p>No history yet.</p>"));

  const diffs = [];
  for (let i = 1; i < history.length; i++) {
    diffs.push({ from: history[i - 1], to: history[i], diff: diffSnapshots(history[i - 1], history[i]) });
  }
  diffs.reverse(); // most recent first

  const latestTitle = history[history.length - 1].title;
  const latestSnap = history[history.length - 1];
  const hostname = (() => { try { return new URL(latestSnap.title ? "https://x.com" : "https://x.com").hostname; } catch (e) { return ""; } })();
  const mostRecentDiff = diffs[0] ? diffs[0].diff : null;
  const changesSummary = mostRecentDiff && mostRecentDiff.hasChanges
    ? summarizeDiffForCard(mostRecentDiff)
    : "No changes detected yet";

  const body = `
    <h1>${escapeHtml(latestTitle || "Tracked page")}</h1>
    <p class="meta">${history.length} check${history.length === 1 ? "" : "s"} recorded</p>
    ${diffs.length === 0 ? "<p>Only one check so far — no changes to show yet.</p>" : diffs.map(renderDiffEntry).join("")}
  `;
  const ogTags = `
    <meta property="og:title" content="${escapeHtml(latestTitle || 'Change history')} — Signal">
    <meta property="og:description" content="${escapeHtml(changesSummary)}">
    <meta property="og:image" content="/page/${id}/card.png">
    <meta name="twitter:card" content="summary_large_image">
  `;
  res.send(renderShell(latestTitle || "Change history", body, ogTags));
});

function summarizeDiffForCard(diff) {
  const parts = [];
  if (diff.titleChanged) parts.push("Title changed");
  if (diff.internalLinks.added.length || diff.internalLinks.removed.length) parts.push(`${diff.internalLinks.added.length + diff.internalLinks.removed.length} internal link changes`);
  if (diff.externalLinks.added.length || diff.externalLinks.removed.length) parts.push(`${diff.externalLinks.added.length + diff.externalLinks.removed.length} external link changes`);
  if (diff.images.added.length || diff.images.removed.length) parts.push(`${diff.images.added.length + diff.images.removed.length} image changes`);
  return parts.join(", ") || "Content updated";
}

// GET /page/:id/card.png — dynamic social share card for this page's latest change
app.get("/page/:id/card.png", async (req, res) => {
  try {
    const id = req.params.id;
    const f = path.join(DATA_DIR, `${id}.json`);
    if (!fs.existsSync(f)) return res.status(404).end();
    const history = JSON.parse(fs.readFileSync(f, "utf8"));
    if (history.length < 1) return res.status(404).end();

    const latest = history[history.length - 1];
    const prev = history[history.length - 2];
    const diff = prev ? diffSnapshots(prev, latest) : null;
    const impactLevel = diff ? diff.impact.level : "None";
    const impactScore = diff ? diff.impact.score : 0;
    const summary = diff && diff.hasChanges ? summarizeDiffForCard(diff) : "Tracking this page for changes";

    // hostname isn't stored on snapshot directly — derive from title fallback
    const hostname = latest.title ? latest.title.split(/[|·\-–]/)[0].trim() : "Tracked page";

    const png = await generateShareCard({ hostname, impactLevel, impactScore, changesSummary: summary });
    res.set("Content-Type", "image/png");
    res.send(png);
  } catch (e) {
    res.status(500).end();
  }
});

// ---------- PUBLIC LEADERBOARD (growth feature) ----------
// Aggregates publishing velocity across all tracked domains into one indexable,
// link-worthy page — classic "state of X" content that drives organic backlinks.
app.get("/leaderboard", (req, res) => {
  const rows = [];
  if (fs.existsSync(SITEMAP_DIR)) {
    const files = fs.readdirSync(SITEMAP_DIR);
    files.forEach((f) => {
      try {
        const history = JSON.parse(fs.readFileSync(path.join(SITEMAP_DIR, f), "utf8"));
        const velocity = publishingVelocity(history);
        if (velocity && velocity.pagesPerWeek > 0) {
          rows.push({ velocity });
        }
      } catch (e) {}
    });
  }
  rows.sort((a, b) => b.velocity.pagesPerWeek - a.velocity.pagesPerWeek);

  const body = `
    <h1>Publishing Velocity Leaderboard</h1>
    <p class="meta">Ranked by new pages published per week, across all publicly tracked domains.</p>
    ${rows.length === 0 ? "<p>No data yet — check back once more domains have been tracked over time.</p>" : `
      <div class="entry">
        ${rows.map((r, i) => `<div class="row"><strong>#${i + 1}</strong> — ${r.velocity.pagesPerWeek} pages/week (${r.velocity.currentTotalPages} total pages, tracked ${r.velocity.daysTracked} days)</div>`).join("")}
      </div>
    `}
  `;
  res.send(renderShell("Publishing Velocity Leaderboard", body));
});

function renderDiffEntry({ to, diff }) {
  const impactColor = { High: "#B23A34", Medium: "#7A5300", Low: "#294B8C", None: "#6B7280" }[diff.impact.level];
  let html = `<div class="entry">
    <div class="entry-head">
      <span class="impact" style="background:${impactColor}22;color:${impactColor}">${diff.impact.level} impact — ${diff.impact.score}/100</span>
      <span class="date">${to.fetchedAt}</span>
    </div>`;
  if (!diff.hasChanges) {
    html += `<p class="nochange">No changes detected at this check.</p>`;
  } else {
    if (diff.titleChanged) html += `<div class="row"><strong>Title:</strong> <span class="rm">${escapeHtml(diff.titleChanged.from)}</span> → <span class="add">${escapeHtml(diff.titleChanged.to)}</span></div>`;
    if (diff.contentDiff && diff.contentDiff.changed) {
      diff.contentDiff.added.forEach((s) => (html += `<div class="row add">+ ${escapeHtml(s)}</div>`));
      diff.contentDiff.removed.forEach((s) => (html += `<div class="row rm">− ${escapeHtml(s)}</div>`));
    }
    if (diff.internalLinks.added.length || diff.internalLinks.removed.length) {
      html += `<div class="row"><strong>Internal links:</strong> +${diff.internalLinks.added.length} / −${diff.internalLinks.removed.length}</div>`;
    }
    if (diff.externalLinks.added.length || diff.externalLinks.removed.length) {
      html += `<div class="row"><strong>External links:</strong> +${diff.externalLinks.added.length} / −${diff.externalLinks.removed.length}</div>`;
    }
    if (diff.images.added.length || diff.images.removed.length) {
      html += `<div class="row"><strong>Images:</strong> +${diff.images.added.length} / −${diff.images.removed.length}</div>`;
    }
    const outreach = require("./engine").outreachOpportunities(diff);
    if (outreach.length) {
      html += `<div class="row" style="margin-top:10px;padding:10px;background:#FCEACB33;border-radius:6px;"><strong>🔗 Outreach opportunity:</strong> ${outreach.length} outbound link${outreach.length === 1 ? "" : "s"} removed — potential backlink target${outreach.length === 1 ? "" : "s"} for you.</div>`;
    }
  }
  html += `</div>`;
  return html;
}

function renderShell(title, body, extraHead = "") {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} — Signal</title>
  ${extraHead}
  <style>
    body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1A1D23;background:#F7F7F5}
    h1{font-size:24px}
    .meta{color:#6B7280;font-size:13px;margin-bottom:24px}
    .entry{background:#fff;border:1px solid #E4E2DC;border-radius:10px;padding:16px 20px;margin-bottom:12px}
    .entry-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
    .impact{font-size:12px;font-weight:600;padding:3px 10px;border-radius:20px}
    .date{font-size:12px;color:#6B7280}
    .row{font-size:13px;margin-bottom:6px}
    .add{color:#1F7A4D}
    .rm{color:#B23A34}
    .nochange{color:#6B7280;font-size:13px}
  </style></head><body>${body}</body></html>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- SUBSCRIPTIONS (email alerts) ----------
const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");
if (!fs.existsSync(SUBS_FILE)) fs.writeFileSync(SUBS_FILE, "[]");

function loadSubs() {
  return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
}
function saveSubs(subs) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

app.post("/api/subscribe", (req, res) => {
  const { email, url } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Provide a valid email address." });
  }
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: "Provide a valid URL." });
  }
  const subs = loadSubs();
  const exists = subs.some((s) => s.email === email && s.url === url);
  if (!exists) {
    subs.push({ email, url, createdAt: new Date().toISOString() });
    saveSubs(subs);
  }
  res.json({ ok: true, message: "You'll get an email when this page changes." });
});

// POST /api/contact — stores contact form submissions to a file (simple, free).
// Upgrade path: send yourself an email per submission via the same Gmail SMTP
// setup used for alerts, once GMAIL_USER/GMAIL_APP_PASSWORD are configured.
const CONTACT_FILE = path.join(DATA_DIR, "contact-messages.json");
app.post("/api/contact", (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required." });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Provide a valid email address." });
  if (!message || !message.trim()) return res.status(400).json({ error: "Message is required." });

  let messages = [];
  if (fs.existsSync(CONTACT_FILE)) {
    try { messages = JSON.parse(fs.readFileSync(CONTACT_FILE, "utf8")); } catch (e) { messages = []; }
  }
  messages.push({ name: name.trim(), email: email.trim(), message: message.trim(), receivedAt: new Date().toISOString() });
  fs.writeFileSync(CONTACT_FILE, JSON.stringify(messages, null, 2));

  res.json({ ok: true });
});

function summarize(snap) {
  return {
    title: snap.title,
    metaDesc: snap.metaDesc,
    wordCount: snap.wordCount,
    internalLinks: snap.internalLinks.length,
    externalLinks: snap.externalLinks.length,
    images: snap.images.length,
    fetchedAt: snap.fetchedAt,
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
