const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const { v4: uuidv4 } = require("uuid");
const { fetchPage, fetchPageWithMeta, extractData, diffSnapshots, fetchSitemapUrls, diffSitemap, publishingVelocity, outreachOpportunities, checkLinksInPool, impactMeetsThreshold } = require("./engine");
const { generateShareCard } = require("./sharecard");
const { sendSlackAlert, sendDiscordAlert } = require("./alerts");
const { captureScreenshot, compareScreenshots } = require("./screenshot");
const { supabase, createUserClient } = require("./supabaseClient");

const app = express();

// Lemon Squeezy webhook — registered BEFORE express.json() because signature
// verification needs the exact raw request bytes; express.json() would parse
// and discard that raw form before this route ever saw it.
app.post("/api/webhooks/lemonsqueezy", express.raw({ type: "application/json" }), async (req, res) => {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) return res.status(500).send("Webhook not configured.");

  const signature = req.get("X-Signature") || "";
  const expected = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(401).send("Invalid signature.");
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch (e) {
    return res.status(400).send("Bad payload.");
  }

  try {
    const eventName = payload.meta?.event_name;
    const userId = payload.meta?.custom_data?.user_id;
    const attrs = payload.data?.attributes || {};
    if (!userId) {
      console.error("Lemon Squeezy webhook: no user_id in custom_data — was it passed at checkout?");
      return res.status(200).send("No user_id, ignored.");
    }

    const activeStates = ["active", "on_trial"];
    const plan = activeStates.includes(attrs.status) ? "Pro" : "Free";

    await supabase.rpc("webhook_apply_subscription", {
      p_user_id: userId,
      p_plan: plan,
      p_status: attrs.status || eventName || "unknown",
      p_external_customer_id: String(attrs.customer_id || ""),
      p_external_subscription_id: String(payload.data?.id || ""),
      p_current_period_end: attrs.renews_at || attrs.ends_at || null,
    });

    console.log(`Lemon Squeezy webhook: user ${userId} -> plan ${plan} (${eventName})`);
    res.status(200).send("OK");
  } catch (e) {
    console.error("Lemon Squeezy webhook error:", e.message);
    res.status(500).send("Webhook processing failed.");
  }
});

app.use(express.json());
const rateLimit = require("express-rate-limit");

// Public tools (free check, site-scan) get rate limited by IP — prevents one
// visitor from hammering the server or racking up unbounded screenshot/browser
// launches on the free hosting tier. Logged-in dashboard actions are not
// limited here since they're already capped by FREE_MONITOR_CAP.
const publicToolLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 checks per IP per 15 min — generous for real use, blocks scripted abuse
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many checks from this IP. Try again in a few minutes." },
});

// Auth endpoints get a tighter limit — this is the brute-force/credential-
// stuffing surface, not a usage-cap surface, so it's deliberately stricter and
// separate from publicToolLimiter.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 signup/login/reset attempts per IP per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in a few minutes." },
});
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const COOKIE_OPTS = { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" };

function setAuthCookies(res, session) {
  res.cookie("sb_access_token", session.access_token, { ...COOKIE_OPTS, maxAge: 1000 * 60 * 60 * 24 * 7 });
  res.cookie("sb_refresh_token", session.refresh_token, { ...COOKIE_OPTS, maxAge: 1000 * 60 * 60 * 24 * 30 });
}
function clearAuthCookies(res) {
  res.clearCookie("sb_access_token");
  res.clearCookie("sb_refresh_token");
  res.clearCookie("demo_mode");
}

// Real auth (Supabase) + demo-mode resolver. Demo mode (cookie demo_mode=1) is a
// completely separate path from real accounts — it never touches Supabase, always
// reads/writes the seeded local files under uid "demo-user". Real accounts always
// go through Supabase (Auth + Postgres), so data survives redeploys.
app.use(async (req, res, next) => {
  req.isDemo = false;
  req.userId = null;
  req.db = null;

  if (req.cookies.demo_mode === "1") {
    req.isDemo = true;
    req.userId = "demo-user";
    return next();
  }

  let token = req.cookies.sb_access_token;
  if (token) {
    try {
      let { data, error } = await supabase.auth.getUser(token);
      if (error) {
        // access token expired — try the refresh token before giving up
        const refreshToken = req.cookies.sb_refresh_token;
        if (refreshToken) {
          const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
          if (!refreshErr && refreshed.session) {
            setAuthCookies(res, refreshed.session);
            token = refreshed.session.access_token;
            data = { user: refreshed.user };
            error = null;
          }
        }
      }
      if (!error && data.user) {
        req.userId = data.user.id;
        req.userEmail = data.user.email;
        req.db = createUserClient(token);
      }
    } catch (e) {
      console.error("Auth check failed:", e.message);
    }
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: "Not signed in." });
  next();
}

// ---------- REAL AUTH (Supabase) ----------
// Signup ALWAYS captures name + email (business requirement: lets us export the
// profiles table later for email marketing, no code needed — just Supabase
// Table Editor -> profiles -> Export CSV). Name is passed as auth user_metadata so
// the on-signup DB trigger saves it even before email confirmation completes.
app.post("/api/auth/signup", authLimiter, async (req, res) => {
  const { email, password, firstName, lastName } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Provide a valid email address." });
  if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  if (!firstName || !firstName.trim()) return res.status(400).json({ error: "First name is required." });

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { first_name: firstName.trim(), last_name: (lastName || "").trim() } },
  });
  if (error) return res.status(400).json({ error: error.message });

  if (data.session) {
    setAuthCookies(res, data.session);
    return res.json({ ok: true, needsConfirmation: false });
  }
  // Email confirmation is required before a session is issued — name/email are
  // already saved via the trigger regardless.
  res.json({ ok: true, needsConfirmation: true, message: "Check your email to confirm your account, then log in." });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  setAuthCookies(res, data.session);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookies(res);
  res.json({ ok: true });
});

// POST /api/auth/forgot-password — body: { email }. Always returns ok:true
// regardless of whether the email exists, so this can't be used to enumerate
// registered accounts.
app.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Provide a valid email address." });
  }
  try {
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${req.protocol}://${req.get("host")}/reset-password.html` });
  } catch (e) {
    console.error("Password reset request failed:", e.message);
  }
  res.json({ ok: true, message: "If that email has an account, a reset link is on its way." });
});

// POST /api/auth/reset-password — body: { accessToken, newPassword }. accessToken
// comes from the recovery link Supabase emails (reset-password.html reads it out
// of the URL fragment and posts it here, since that fragment never reaches the
// server on its own).
app.post("/api/auth/reset-password", authLimiter, async (req, res) => {
  const { accessToken, newPassword } = req.body;
  if (!accessToken || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "Provide the reset link's token and a password of at least 6 characters." });
  }
  try {
    const userDb = createUserClient(accessToken);
    const { error } = await userDb.auth.updateUser({ password: newPassword });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/auth/session", async (req, res) => {
  if (req.isDemo) return res.json({ authenticated: true, isDemo: true });
  if (!req.userId) return res.json({ authenticated: false });
  res.json({ authenticated: true, isDemo: false, userId: req.userId });
});

// GET /api/billing/checkout-url — builds a Lemon Squeezy hosted-checkout link
// for this signed-in user's upgrade, with user_id passed through as custom
// data so the webhook can tie the resulting subscription back to them.
app.get("/api/billing/checkout-url", requireAuth, async (req, res) => {
  if (req.isDemo) return res.status(400).json({ error: "Upgrade isn't available in demo mode — create a real account first." });
  const base = process.env.LEMONSQUEEZY_CHECKOUT_URL; // e.g. https://yourstore.lemonsqueezy.com/buy/VARIANT_ID
  if (!base) return res.status(500).json({ error: "Billing isn't configured yet." });
  try {
    const profile = await loadProfileAsync(req);
    const url = new URL(base);
    url.searchParams.set("checkout[email]", profile.email || "");
    url.searchParams.set("checkout[custom][user_id]", req.userId);
    res.json({ url: url.toString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /demo — switches this browser into demo mode (seeded, file-based sample
// data) so anyone can see a fully populated dashboard instantly, without signing
// up. Run `node seed-demo.js` once to generate the demo data.
app.get("/demo", (req, res) => {
  clearAuthCookies(res);
  res.cookie("demo_mode", "1", { maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: true });
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

// Pure calculation — takes an already-loaded pings array, storage-agnostic.
function calcUptimeStats(pings) {
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

function computeUptimeStats(pageId) {
  return calcUptimeStats(loadUptimePings(pageId));
}

function mapUptimeRow(row) {
  return { at: row.checked_at, status: row.status, up: row.up, responseTimeMs: row.response_time_ms };
}

// Dual-mode uptime pings — demo: local file; real account: Supabase `uptime_pings`
// (RLS-scoped to the caller's own monitors via req.db).
async function loadMonitorUptimePingsAsync(req, pageId) {
  if (req.isDemo) return loadUptimePings(pageId);
  const { data, error } = await req.db.from("uptime_pings").select("*").eq("page_id", pageId).order("checked_at", { ascending: true }).limit(500);
  if (error) throw error;
  return data.map(mapUptimeRow);
}
async function insertMonitorUptimePingAsync(req, pageId, ping) {
  if (req.isDemo) {
    const pings = loadUptimePings(pageId);
    pings.push(ping);
    saveUptimePings(pageId, pings);
    return;
  }
  const { error } = await req.db.from("uptime_pings").insert({ page_id: pageId, status: ping.status, up: ping.up, response_time_ms: ping.responseTimeMs });
  if (error) throw error;
}
async function computeUptimeStatsAsync(req, pageId) {
  return calcUptimeStats(await loadMonitorUptimePingsAsync(req, pageId));
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

function mapMonitorRow(row) {
  return {
    id: row.id,
    url: row.url,
    ownerId: row.user_id || null,
    pageId: row.page_id,
    condition: row.condition,
    frequency: row.frequency || "daily",
    channels: row.channels || ["email"],
    slackWebhook: row.slack_webhook,
    discordWebhook: row.discord_webhook,
    selector: row.selector || null,
    minImpact: row.min_impact || "Low",
    autoPause: !!row.auto_pause,
    status: row.status,
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
  };
}

// Dual-mode monitors — demo: local file (uid "demo-user"); real account: Supabase
// `monitors` table, RLS-scoped via req.db so a user can only ever see/change their own.
async function loadMonitorsAsync(req) {
  if (req.isDemo) return loadMonitors(req.userId);
  const { data, error } = await req.db.from("monitors").select("*").order("created_at", { ascending: true });
  if (error) throw error;
  return data.map(mapMonitorRow);
}
async function insertMonitorAsync(req, monitor) {
  if (req.isDemo) {
    const monitors = loadMonitors(req.userId);
    monitors.push(monitor);
    saveMonitors(req.userId, monitors);
    return monitor;
  }
  const { data, error } = await req.db.from("monitors").insert({
    user_id: req.userId,
    url: monitor.url,
    page_id: monitor.pageId,
    condition: monitor.condition,
    frequency: monitor.frequency,
    channels: monitor.channels,
    slack_webhook: monitor.slackWebhook,
    discord_webhook: monitor.discordWebhook,
    selector: monitor.selector,
    min_impact: monitor.minImpact || "Low",
    auto_pause: !!monitor.autoPause,
    status: monitor.status,
  }).select().single();
  if (error) throw error;
  return mapMonitorRow(data);
}
async function deleteMonitorAsync(req, id) {
  if (req.isDemo) {
    const monitors = loadMonitors(req.userId).filter((m) => m.id !== id);
    saveMonitors(req.userId, monitors);
    return;
  }
  const { error } = await req.db.from("monitors").delete().eq("id", id);
  if (error) throw error;
}
async function updateMonitorAsync(req, id, fields) {
  if (req.isDemo) {
    const monitors = loadMonitors(req.userId);
    const m = monitors.find((x) => x.id === id);
    if (m) Object.assign(m, fields);
    saveMonitors(req.userId, monitors);
    return;
  }
  const dbFields = {};
  if (fields.status !== undefined) dbFields.status = fields.status;
  if (fields.lastCheckedAt !== undefined) dbFields.last_checked_at = fields.lastCheckedAt;
  if (fields.minImpact !== undefined) dbFields.min_impact = fields.minImpact;
  if (fields.autoPause !== undefined) dbFields.auto_pause = fields.autoPause;
  if (fields.frequency !== undefined) dbFields.frequency = fields.frequency;
  const { error } = await req.db.from("monitors").update(dbFields).eq("id", id);
  if (error) throw error;
}

function mapSnapshotRow(row) {
  return {
    dbId: row.id,
    fetchedAt: row.fetched_at,
    title: row.title,
    metaDesc: row.meta_desc,
    h1: row.h1 || [],
    h2: row.h2 || [],
    wordCount: row.word_count,
    bodyTextHash: row.body_text_hash,
    internalLinks: row.internal_links || [],
    externalLinks: row.external_links || [],
    images: row.images || [],
    schemaTypes: row.schema_types || [],
    screenshotFile: row.screenshot_file,
    screenshotDiffFile: row.screenshot_diff_file,
    screenshotDiffPercent: row.screenshot_diff_percent,
  };
}

// Dual-mode monitor content history — demo: local file (keyed by url, same as the
// legacy public /api/check tool); real account: Supabase `snapshots` table,
// RLS-scoped via req.db to snapshots whose page_id belongs to one of the caller's
// own monitors.
async function loadMonitorHistoryAsync(req, monitor) {
  if (req.isDemo) return loadHistory(monitor.url);
  const { data, error } = await req.db.from("snapshots").select("*").eq("page_id", monitor.pageId).order("fetched_at", { ascending: true });
  if (error) throw error;
  return data.map(mapSnapshotRow);
}
async function insertMonitorSnapshotAsync(req, monitor, snap) {
  if (req.isDemo) {
    const history = loadHistory(monitor.url);
    history.push(snap);
    saveHistory(monitor.url, history);
    return snap;
  }
  const { data, error } = await req.db.from("snapshots").insert({
    page_id: monitor.pageId,
    title: snap.title,
    meta_desc: snap.metaDesc,
    h1: snap.h1,
    h2: snap.h2,
    word_count: snap.wordCount,
    body_text_hash: snap.bodyTextHash,
    internal_links: snap.internalLinks,
    external_links: snap.externalLinks,
    images: snap.images,
    schema_types: snap.schemaTypes,
  }).select().single();
  if (error) throw error;
  return mapSnapshotRow(data);
}
async function updateSnapshotScreenshotAsync(req, monitor, dbSnap, screenshotFile, screenshotDiffFile, screenshotDiffPercent) {
  if (req.isDemo) return; // demo history is already written whole in insertMonitorSnapshotAsync
  const { error } = await req.db.from("snapshots").update({
    screenshot_file: screenshotFile,
    screenshot_diff_file: screenshotDiffFile,
    screenshot_diff_percent: screenshotDiffPercent,
  }).eq("id", dbSnap.dbId);
  if (error) throw error;
}
async function computeMonitorStatsAsync(req, monitor) {
  return calcMonitorStats(await loadMonitorHistoryAsync(req, monitor));
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

function mapProfileRow(row) {
  return {
    firstName: row.first_name || "",
    lastName: row.last_name || "",
    email: row.email || "",
    timezone: row.timezone || "UTC",
    useCase: row.use_case || null,
    plan: row.plan || "Free",
  };
}

// Dual-mode: demo -> local file; real account -> Supabase `profiles` row
// (RLS-scoped via req.db, so this can only ever read/write the caller's own row).
async function loadProfileAsync(req) {
  if (req.isDemo) return loadProfile(req.userId);
  const { data, error } = await req.db.from("profiles").select("*").eq("id", req.userId).single();
  if (error) throw error;
  return mapProfileRow(data);
}
async function saveProfileAsync(req, fields) {
  if (req.isDemo) {
    const existing = loadProfile(req.userId);
    const profile = { ...existing, ...fields };
    saveProfile(req.userId, profile);
    return profile;
  }
  const dbFields = {};
  if (fields.firstName !== undefined) dbFields.first_name = fields.firstName;
  if (fields.lastName !== undefined) dbFields.last_name = fields.lastName;
  if (fields.timezone !== undefined) dbFields.timezone = fields.timezone;
  if (fields.useCase !== undefined) dbFields.use_case = fields.useCase;
  const { data, error } = await req.db.from("profiles").update(dbFields).eq("id", req.userId).select().single();
  if (error) throw error;
  return mapProfileRow(data);
}

// GET /api/profile
app.get("/api/profile", requireAuth, async (req, res) => {
  try {
    res.json(await loadProfileAsync(req));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/profile — body: { firstName, lastName, timezone, useCase }
// Email is NOT editable here — it's fixed at signup (real accounts) and is the
// field the email-marketing export relies on.
// useCase: "myself" | "clients" | "company" — set once during onboarding
app.post("/api/profile", requireAuth, async (req, res) => {
  const { firstName, lastName, timezone, useCase } = req.body;
  try {
    const profile = await saveProfileAsync(req, { firstName, lastName, timezone, useCase });
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const TEAM_SEAT_CAP = 3; // Pro plan — teammates sharing one workspace

// GET /api/team — my invited teammates + any teams I belong to as a member
app.get("/api/team", requireAuth, async (req, res) => {
  if (req.isDemo) return res.json({ members: [], memberOf: [] });
  try {
    const { data: members, error: e1 } = await req.db
      .from("team_members").select("*").eq("owner_id", req.userId).order("invited_at", { ascending: true });
    if (e1) throw e1;
    const { data: memberOf, error: e2 } = await req.db
      .from("team_members").select("*").eq("member_id", req.userId).eq("status", "active");
    if (e2) throw e2;
    res.json({
      members: members.map((m) => ({ id: m.id, email: m.member_email, status: m.status, invitedAt: m.invited_at })),
      memberOf: memberOf.map((m) => ({ ownerId: m.owner_id })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/team/invite — body: { email }. Pro plan only, capped seats.
app.post("/api/team/invite", requireAuth, async (req, res) => {
  if (req.isDemo) return res.status(400).json({ error: "Sign up for a real account to use team seats." });
  const email = (req.body.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Provide a valid email." });
  }
  try {
    const profile = await loadProfileAsync(req);
    if (profile.plan !== "Pro") {
      return res.status(402).json({ error: "Team seats are a Pro feature. Upgrade to invite teammates.", capReached: true });
    }
    if (email === (profile.email || "").toLowerCase() || email === (req.userEmail || "").toLowerCase()) {
      return res.status(400).json({ error: "That's your own email." });
    }
    const { data: existing, error: e1 } = await req.db.from("team_members").select("id").eq("owner_id", req.userId);
    if (e1) throw e1;
    if (existing.length >= TEAM_SEAT_CAP) {
      return res.status(402).json({ error: `Pro plan allows ${TEAM_SEAT_CAP} team seats.`, capReached: true });
    }
    const { data, error } = await req.db.from("team_members").insert({
      owner_id: req.userId, member_email: email, status: "pending",
    }).select().single();
    if (error) {
      if (error.code === "23505") return res.status(400).json({ error: "Already invited." });
      throw error;
    }
    res.json({ ok: true, member: { id: data.id, email: data.member_email, status: data.status, invitedAt: data.invited_at } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/team/:id — remove a teammate (owner only, enforced by RLS)
app.delete("/api/team/:id", requireAuth, async (req, res) => {
  if (req.isDemo) return res.status(400).json({ error: "Not available in demo mode." });
  try {
    const { error } = await req.db.from("team_members").delete().eq("id", req.params.id).eq("owner_id", req.userId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const FREE_MONITOR_CAP = 3;
const PRO_MONITOR_CAP = 50; // Pro plan — paid via Lemon Squeezy

function capFor(plan) {
  return plan === "Pro" ? PRO_MONITOR_CAP : FREE_MONITOR_CAP;
}

// Manual "check now" rate limiting — without this, a Free user could hammer the
// button to bypass the daily/hourly frequency tiers entirely. Counted per
// account, reset at UTC midnight (profiles.manual_checks_reset_at).
const FREE_MANUAL_CHECK_CAP = 20;
const PRO_MANUAL_CHECK_CAP = 200;
async function checkAndIncrementManualCheckQuota(req, plan) {
  if (req.isDemo) return { ok: true }; // demo mode isn't real network traffic
  const cap = plan === "Pro" ? PRO_MANUAL_CHECK_CAP : FREE_MANUAL_CHECK_CAP;
  const today = new Date().toISOString().slice(0, 10);
  const { data: row, error: e1 } = await req.db.from("profiles").select("manual_checks_today, manual_checks_reset_at").eq("id", req.userId).single();
  if (e1) throw e1;
  const isNewDay = row.manual_checks_reset_at !== today;
  const current = isNewDay ? 0 : row.manual_checks_today;
  if (current >= cap) {
    return { ok: false, cap };
  }
  const { error: e2 } = await req.db.from("profiles").update({
    manual_checks_today: current + 1,
    manual_checks_reset_at: today,
  }).eq("id", req.userId);
  if (e2) throw e2;
  return { ok: true };
}

// Computes "how many changes in the last N days" for a monitor, plus total checks —
// this is what makes the dashboard feel mature instead of just a raw event list.
// Pure calculation — takes an already-loaded history array, storage-agnostic.
function calcMonitorStats(history) {
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

function computeMonitorStats(url) {
  return calcMonitorStats(loadHistory(url));
}

// GET /screenshots/:pageId/:filename — serve a stored screenshot or diff image
app.get("/screenshots/:pageId/:filename", (req, res) => {
  const filePath = path.join(SCREENSHOTS_DIR, req.params.pageId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.set("Content-Type", "image/png");
  res.sendFile(filePath);
});

// GET /api/monitors — list this account's monitored pages
app.get("/api/monitors", requireAuth, async (req, res) => {
  try {
    const monitors = await loadMonitorsAsync(req);
    const withStats = await Promise.all(monitors.map(async (m) => ({
      ...m,
      isShared: !!(m.ownerId && m.ownerId !== req.userId),
      stats: await computeMonitorStatsAsync(req, m),
    })));
    const profile = await loadProfileAsync(req);
    res.json({ monitors: withStats, cap: capFor(profile.plan) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/monitors — add a new monitored page
// body: { url, condition, frequency, channels, slackWebhook, discordWebhook, selector, minImpact, autoPause }
// selector (optional): a CSS selector to track just one element (price, stock
// status, a specific section) instead of the whole page.
// minImpact (optional, default "Low"): noise filter — only alert when a change's
// SEO Impact Score is at least this level (Low/Medium/High). Closes the #1 G2
// complaint against Visualping (alert fatigue from cookie banners/ads/trivial edits).
// autoPause (optional, default false): pause the monitor automatically the first
// time it fires an alert — for one-shot "tell me once, then stop" tracking
// (price drop hit, item back in stock) so credits/checks aren't wasted after.
app.post("/api/monitors", requireAuth, async (req, res) => {
  const { url, condition, frequency, channels, slackWebhook, discordWebhook, selector, minImpact, autoPause } = req.body;
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: "Provide a valid URL." });
  }
  try {
    const existing = await loadMonitorsAsync(req);
    const ownMonitorCount = existing.filter((m) => !m.ownerId || m.ownerId === req.userId).length;
    const profile = await loadProfileAsync(req);
    const cap = capFor(profile.plan);
    if (ownMonitorCount >= cap) {
      return res.status(402).json({ error: `${profile.plan} plan allows ${cap} monitored pages. Upgrade to add more.`, capReached: true });
    }
    // Frequency tiers: Free is daily-only. Enforced here too (not just the
    // disabled UI option) since the API is callable directly.
    const requestedFrequency = frequency || "daily";
    if (requestedFrequency !== "daily" && profile.plan !== "Pro") {
      return res.status(402).json({ error: "Hourly/12h checks are a Pro feature. Upgrade to unlock.", capReached: true });
    }
    const monitor = {
      id: uuidv4(),
      url,
      pageId: keyFor(url),
      condition: condition || "any_change", // any_change | high_impact | new_pages | outreach
      frequency: ["hourly", "12h", "daily"].includes(requestedFrequency) ? requestedFrequency : "daily",
      channels: channels || ["email"],
      slackWebhook: slackWebhook || null,
      discordWebhook: discordWebhook || null,
      selector: selector ? selector.trim() : null,
      minImpact: ["Low", "Medium", "High"].includes(minImpact) ? minImpact : "Low",
      autoPause: !!autoPause,
      status: "checking",
      createdAt: new Date().toISOString(),
    };
    const saved = await insertMonitorAsync(req, monitor);
    res.json({ ok: true, monitor: saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/monitors/:id — edit settings on an existing monitor (noise filter,
// auto-pause, channels) without recreating it.
app.patch("/api/monitors/:id", requireAuth, async (req, res) => {
  try {
    const { minImpact, autoPause, status, slackWebhook, discordWebhook, selector, condition, frequency } = req.body;
    const fields = {};
    if (minImpact !== undefined) fields.minImpact = minImpact;
    if (autoPause !== undefined) fields.autoPause = autoPause;
    if (status !== undefined) fields.status = status;
    if (frequency !== undefined) {
      if (frequency !== "daily") {
        const profile = await loadProfileAsync(req);
        if (profile.plan !== "Pro") return res.status(402).json({ error: "Hourly/12h checks are a Pro feature. Upgrade to unlock.", capReached: true });
      }
      fields.frequency = ["hourly", "12h", "daily"].includes(frequency) ? frequency : "daily";
    }
    await updateMonitorAsync(req, req.params.id, fields);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/monitors/bulk — pause/resume/delete several monitors in one call.
// body: { ids: [...], action: "pause" | "resume" | "delete" }
// Closes a ChangeTower G2 complaint: no bulk-edit capability for multiple monitors.
app.post("/api/monitors/bulk", requireAuth, async (req, res) => {
  const { ids, action } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "Provide monitor ids." });
  if (!["pause", "resume", "delete"].includes(action)) return res.status(400).json({ error: "Invalid action." });
  try {
    for (const id of ids) {
      if (action === "delete") await deleteMonitorAsync(req, id);
      else await updateMonitorAsync(req, id, { status: action === "pause" ? "paused" : "active" });
    }
    res.json({ ok: true, count: ids.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/monitors/:id
app.delete("/api/monitors/:id", requireAuth, async (req, res) => {
  try {
    await deleteMonitorAsync(req, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/monitors/:id/check — run a check now for this monitor (used for the
// "Check in progress..." live state and to populate its history panel)
app.post("/api/monitors/:id/check", requireAuth, async (req, res) => {
  try {
    const monitors = await loadMonitorsAsync(req);
    const monitor = monitors.find((m) => m.id === req.params.id);
    if (!monitor) return res.status(404).json({ error: "Monitor not found." });

    const profile = await loadProfileAsync(req);
    const quota = await checkAndIncrementManualCheckQuota(req, profile.plan);
    if (!quota.ok) {
      return res.status(429).json({ error: `Daily manual check limit reached (${quota.cap}/day on ${profile.plan} plan). Try again tomorrow${profile.plan !== "Pro" ? ", or upgrade to Pro for 200/day." : "."}`, rateLimited: true });
    }

    // Uptime ping is recorded regardless of outcome — a 404/500/timeout IS the data
    // point for uptime tracking, unlike content checks where it's an error to throw.
    const pageResult = await fetchPageWithMeta(monitor.url);
    await insertMonitorUptimePingAsync(req, monitor.pageId, { at: new Date().toISOString(), status: pageResult.status, up: pageResult.up, responseTimeMs: pageResult.responseTimeMs });

    if (!pageResult.up) {
      // Page is down — record the outage, skip content/screenshot diffing (nothing
      // meaningful to diff), but don't treat this as a server error.
      await updateMonitorAsync(req, monitor.id, { status: "active", lastCheckedAt: new Date().toISOString() });
      return res.json({ mode: "down", status: pageResult.status, error: pageResult.error, uptime: await computeUptimeStatsAsync(req, monitor.pageId) });
    }

    const snap = extractData(pageResult.html, monitor.url, monitor.selector);
    const history = await loadMonitorHistoryAsync(req, monitor);
    const last = history[history.length - 1];

    // Screenshot capture happens before saving history so the filename can be
    // attached directly to this snapshot — ties each timeline entry to its own
    // before/after/diff images instead of matching by nearest timestamp later.
    const screenshot = await captureAndDiffScreenshot(monitor.url, monitor.pageId);
    snap.screenshotFile = screenshot.newScreenshot || null;
    snap.screenshotDiffFile = screenshot.diffScreenshot || null;
    snap.screenshotDiffPercent = screenshot.diffPercent ?? null;

    const savedSnap = await insertMonitorSnapshotAsync(req, monitor, snap);
    await updateSnapshotScreenshotAsync(req, monitor, savedSnap, snap.screenshotFile, snap.screenshotDiffFile, snap.screenshotDiffPercent);

    await updateMonitorAsync(req, monitor.id, { status: "active", lastCheckedAt: snap.fetchedAt });

    const uptime = await computeUptimeStatsAsync(req, monitor.pageId);

    if (!last) {
      return res.json({ mode: "baseline", snapshot: summarize(snap), screenshot, uptime });
    }
    const diff = diffSnapshots(last, snap);
    const outreach = outreachOpportunities(diff);

    // Noise filter — only treat this as alert-worthy if it clears the monitor's
    // min-impact floor. Fixes Visualping's #1 G2 complaint (alert fatigue from
    // cookie banners/ads/trivial layout tweaks).
    const alertWorthy = diff.hasChanges && impactMeetsThreshold(diff.impact.level, monitor.minImpact || "Low");

    // Fire Slack/Discord alerts immediately if this monitor has webhooks configured
    // and the change cleared the noise filter — best-effort, never blocks the response.
    let slackSent = false;
    let discordSent = false;
    if (alertWorthy && monitor.slackWebhook) {
      try {
        await sendSlackAlert({ webhookUrl: monitor.slackWebhook, url: monitor.url, diff });
        slackSent = true;
      } catch (e) {
        console.error("Slack alert failed:", e.message);
      }
    }
    if (alertWorthy && monitor.discordWebhook) {
      try {
        await sendDiscordAlert({ webhookUrl: monitor.discordWebhook, url: monitor.url, diff });
        discordSent = true;
      } catch (e) {
        console.error("Discord alert failed:", e.message);
      }
    }

    // Auto-pause: one-shot monitors stop checking themselves once they've fired —
    // saves checks/credits instead of alerting forever after the target state hit
    // (price drop, back in stock). Fixes a Visualping G2 complaint.
    if (alertWorthy && monitor.autoPause) {
      await updateMonitorAsync(req, monitor.id, { status: "paused" });
    }

    return res.json({ mode: "diff", hasChanges: diff.hasChanges, alertWorthy, diff, outreach, screenshot, uptime, slackSent, discordSent, autoPaused: alertWorthy && monitor.autoPause, lastCheckedAt: last.fetchedAt, currentCheckedAt: snap.fetchedAt });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/monitors/:id/history — full diff timeline for one monitor (right panel)
app.get("/api/monitors/:id/history", requireAuth, async (req, res) => {
  try {
    const monitors = await loadMonitorsAsync(req);
    const monitor = monitors.find((m) => m.id === req.params.id);
    if (!monitor) return res.status(404).json({ error: "Monitor not found." });

    const history = await loadMonitorHistoryAsync(req, monitor);
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
    // Trend data — word count + impact score per check, oldest first, for the
    // dashboard's historical trend sparkline (closes a Wachete G2 gap: no
    // historical analytics at all).
    const trend = history.map((h, i) => ({
      at: h.fetchedAt,
      wordCount: h.wordCount,
      impactScore: i === 0 ? 0 : diffSnapshots(history[i - 1], h).impact.score,
    }));
    res.json({ monitor, diffs, trend, checksRecorded: history.length, stats: calcMonitorStats(history), uptime: await computeUptimeStatsAsync(req, monitor.pageId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/monitors/:id/export.csv — download this monitor's full change history
// as CSV. Closes a ChangeTower G2 complaint (reporting locked to in-app views
// with limited export options) and a Visualping one (agencies need client reports).
app.get("/api/monitors/:id/export.csv", requireAuth, async (req, res) => {
  try {
    const monitors = await loadMonitorsAsync(req);
    const monitor = monitors.find((m) => m.id === req.params.id);
    if (!monitor) return res.status(404).json({ error: "Monitor not found." });

    const history = await loadMonitorHistoryAsync(req, monitor);
    const rows = [["Checked At", "Title", "Word Count", "Impact Score", "Impact Level", "Title Changed", "Content Changed"]];
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      const diff = i === 0 ? null : diffSnapshots(history[i - 1], h);
      rows.push([
        h.fetchedAt,
        (h.title || "").replace(/"/g, '""'),
        h.wordCount,
        diff ? diff.impact.score : "",
        diff ? diff.impact.level : "Baseline",
        diff ? !!diff.titleChanged : "",
        diff ? diff.contentChanged : "",
      ]);
    }
    const csv = rows.map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
    const safeName = monitor.url.replace(/[^a-z0-9]/gi, "-").slice(0, 60);
    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", `attachment; filename="signal-${safeName}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboard-summary — aggregate stats across all of this user's monitors,
// for the top-of-dashboard header ("X changes across all pages this week" etc.)
app.get("/api/dashboard-summary", requireAuth, async (req, res) => {
  try {
    const monitors = await loadMonitorsAsync(req);
    let changesLast7Days = 0;
    let changesLast30Days = 0;
    let uptimeSum = 0;
    let uptimeCount = 0;
    let downCount = 0;
    for (const m of monitors) {
      const stats = await computeMonitorStatsAsync(req, m);
      changesLast7Days += stats.changesLast7Days;
      changesLast30Days += stats.changesLast30Days;
      const uptime = await computeUptimeStatsAsync(req, m.pageId);
      if (uptime) {
        if (uptime.currentStatus === "down") downCount++;
        if (uptime.last7Days) { uptimeSum += uptime.last7Days.uptimePercent; uptimeCount++; }
      }
    }
    const profile = await loadProfileAsync(req);
    res.json({
      totalMonitors: monitors.length,
      cap: capFor(profile.plan),
      changesLast7Days,
      changesLast30Days,
      avgUptimeLast7Days: uptimeCount ? Math.round((uptimeSum / uptimeCount) * 100) / 100 : null,
      pagesDown: downCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/activity-feed — recent change events across ALL of this user's monitors,
// most recent first. Powers the dashboard Overview panel's activity list.
app.get("/api/activity-feed", requireAuth, async (req, res) => {
  try {
    const monitors = await loadMonitorsAsync(req);
    const events = [];
    for (const m of monitors) {
      const history = await loadMonitorHistoryAsync(req, m);
      for (let i = 1; i < history.length; i++) {
        const diff = diffSnapshots(history[i - 1], history[i]);
        if (diff.hasChanges) {
          events.push({ url: m.url, at: history[i].fetchedAt, impact: diff.impact.level, score: diff.impact.score, summary: diff.impact.reasons[0] || "Content updated" });
        }
      }
    }
    events.sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json({ events: events.slice(0, 20) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/changes-per-day — daily change counts across all monitors for the last
// 14 days, for the Overview bar chart.
app.get("/api/changes-per-day", requireAuth, async (req, res) => {
  try {
    const monitors = await loadMonitorsAsync(req);
    const days = 14;
    const counts = {};
    for (let d = days - 1; d >= 0; d--) {
      const key = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
      counts[key] = 0;
    }
    for (const m of monitors) {
      const history = await loadMonitorHistoryAsync(req, m);
      for (let i = 1; i < history.length; i++) {
        const diff = diffSnapshots(history[i - 1], history[i]);
        if (!diff.hasChanges) continue;
        const key = history[i].fetchedAt.slice(0, 10);
        if (key in counts) counts[key]++;
      }
    }
    res.json({ labels: Object.keys(counts), values: Object.values(counts) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ---------- SITE-WIDE SCAN (new pages + site-wide outreach opportunities) ----------
// Different from a single-page monitor: given a domain, this crawls multiple pages
// from its sitemap, flags newly published pages, and checks every outbound link
// found across those pages for broken/dead targets — real backlink opportunities,
// found immediately (not only after a link gets removed between two checks).
const MAX_PAGES_PER_SCAN = 12;   // cap to keep free-tier runtime/cost sane
const MAX_LINKS_TO_CHECK = 40;   // cap outbound link checks per scan

app.post("/api/site-scan", publicToolLimiter, async (req, res) => {
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


app.post("/api/check", publicToolLimiter, async (req, res) => {
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

// ---------- SITE CONTENT (admin CMS) ----------
// Lets the homepage's copy (hero headline, feature cards, etc.) be edited
// from /admin.html without a code deploy. Backed by one jsonb row per
// section in Supabase; public reads go through get_site_content() (no auth
// needed — the homepage itself is anonymous), writes go through
// admin_set_site_content() which checks the caller's email in Postgres
// (defense in depth) on top of the isAdmin check here.
const ADMIN_EMAIL = "malirashid742@gmail.com";

const DEFAULT_HOMEPAGE_CONTENT = {
  heroHeadline: "Know the moment a competitor changes anything.",
  heroBody: "Content, links, images — plus an SEO Impact Score on every change, exact sentence-level diffs, new-page detection, and a shareable history link. Nobody else does all four.",
  heroCta: "Check a page free →",
  heroNote: "No signup for your first check. No card required.",
  features: [
    { tag: "Impact score", title: "Not every change matters", body: "Every diff gets a 0-100 SEO Impact Score, so you know which changes to act on and which to ignore." },
    { tag: "Exact wording", title: "Real sentence-level diffs", body: "See the exact sentences added or removed — not just \"content changed.\" Word-level, like a code diff." },
    { tag: "New pages", title: "Sitemap monitoring", body: "Catch new pages a competitor publishes anywhere on their site — not just the ones you're already tracking." },
    { tag: "Shareable", title: "Public change history", body: "Every tracked page gets a shareable timeline link — send it to a client or teammate in one click." },
  ],
};

function isAdminReq(req) {
  return !req.isDemo && req.userEmail === ADMIN_EMAIL;
}

// GET /api/content/:key — public, no auth. Homepage/dashboard fetch this to
// render dynamic copy. Falls back to defaults if nothing saved yet.
app.get("/api/content/:key", async (req, res) => {
  try {
    const { data, error } = await supabase.rpc("get_site_content", { p_key: req.params.key });
    if (error) throw error;
    if (data) return res.json({ key: req.params.key, value: data });
    if (req.params.key === "homepage") return res.json({ key: "homepage", value: DEFAULT_HOMEPAGE_CONTENT });
    res.json({ key: req.params.key, value: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/content/:key — admin-only. Saves the JSON blob the admin
// panel sent, verbatim.
app.put("/api/admin/content/:key", requireAuth, async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: "Admin only." });
  try {
    const { error } = await req.db.rpc("admin_set_site_content", { p_key: req.params.key, p_value: req.body.value });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/check — lets the admin panel confirm access before showing
// the edit form (vs. a logged-in-but-not-admin user just seeing a 403 wall).
app.get("/api/admin/check", requireAuth, (req, res) => {
  res.json({ isAdmin: isAdminReq(req) });
});

// Cheap, dependency-free health check for the host's port scan / health probe.
// Must not touch disk or the browser so it always answers fast.
app.get("/healthz", (req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));

// Catch-all 404s — must be registered after every real route. JSON for API
// calls, a small branded page for everything else (someone following a dead
// link, mistyped URL, etc).
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found." });
  res.status(404).send(renderShell("Page not found", `
    <h1>404 — Page not found</h1>
    <p>That page doesn't exist. <a href="/">Back to Signal</a></p>
  `));
});

// Last-resort error handler — anything that throws synchronously or calls
// next(err) lands here instead of taking the whole process down.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (req.path.startsWith("/api/")) return res.status(500).json({ error: "Something went wrong." });
  res.status(500).send(renderShell("Error", `<h1>Something went wrong</h1><p><a href="/">Back to Signal</a></p>`));
});

const PORT = process.env.PORT || 3000;
// Bind 0.0.0.0 explicitly — hosts route external traffic to the container's
// public interface, and binding only to localhost makes the port scan fail.
const server = app.listen(PORT, "0.0.0.0", () => console.log(`Running on port ${PORT}`));

// Without these the process can be SIGKILLed mid-deploy and the platform reports
// a failed deploy rather than a clean restart.
function shutdown(signal) {
  console.log(`${signal} received — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Log instead of dying silently — an unhandled rejection in Node 22 terminates the
// process by default, which on a host looks like an unexplained failed deploy.
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
