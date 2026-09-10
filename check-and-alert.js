#!/usr/bin/env node
/**
 * Run this on a schedule (e.g. GitHub Actions cron) to process BOTH alert systems:
 * 1. Legacy email subscriptions (from the public /api/subscribe tool on the landing page)
 * 2. Dashboard monitors (from /api/monitors) — respects each monitor's condition
 *    (any_change / high_impact / new_pages / outreach) and sends to its configured
 *    channels (email always; Slack if a webhook URL was set).
 *
 * Usage: node check-and-alert.js
 * Requires env vars: GMAIL_USER, GMAIL_APP_PASSWORD (see alerts.js)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fetchPage, extractData, diffSnapshots, outreachOpportunities } = require("./engine");
const { sendChangeAlert, sendSlackAlert } = require("./alerts");

const DATA_DIR = path.join(__dirname, "data");
const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");
const MONITORS_DIR = path.join(DATA_DIR, "monitors");

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

// Decides whether a diff should trigger an alert for a given monitor's condition —
// same logic the dashboard implies when the user picks a condition in the UI.
function matchesCondition(diff, outreach, condition) {
  switch (condition) {
    case "high_impact":
      return diff.hasChanges && diff.impact.level === "High";
    case "outreach":
      return outreach.length > 0;
    case "new_pages":
      return false; // new-page detection runs via the separate site-scan feature, not per-page content checks
    case "any_change":
    default:
      return diff.hasChanges;
  }
}

async function processLegacySubscriptions() {
  if (!fs.existsSync(SUBS_FILE)) return;
  const subs = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
  if (!subs.length) return;

  const byUrl = {};
  subs.forEach((s) => {
    byUrl[s.url] = byUrl[s.url] || [];
    byUrl[s.url].push(s.email);
  });

  for (const [url, emails] of Object.entries(byUrl)) {
    console.log(`[subscriptions] Checking ${url} ...`);
    try {
      const html = await fetchPage(url);
      const snap = extractData(html, url);
      const history = loadHistory(url);
      const last = history[history.length - 1];
      history.push(snap);
      saveHistory(url, history);

      if (!last) {
        console.log(`  Baseline saved.`);
        continue;
      }
      const diff = diffSnapshots(last, snap);
      if (!diff.hasChanges) {
        console.log(`  No changes.`);
        continue;
      }
      console.log(`  Changes found. Notifying ${emails.length} subscriber(s)...`);
      for (const email of emails) {
        try {
          await sendChangeAlert({ to: email, url, diff });
          console.log(`    Emailed ${email}`);
        } catch (e) {
          console.error(`    Failed to email ${email}: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`  Error checking ${url}: ${e.message}`);
    }
  }
}

async function processDashboardMonitors() {
  if (!fs.existsSync(MONITORS_DIR)) return;
  const userFiles = fs.readdirSync(MONITORS_DIR).filter((f) => f.endsWith(".json"));

  for (const file of userFiles) {
    const uid = file.replace(".json", "");
    const monitorsPath = path.join(MONITORS_DIR, file);
    const monitors = JSON.parse(fs.readFileSync(monitorsPath, "utf8"));
    let changed = false;

    for (const monitor of monitors) {
      console.log(`[monitors:${uid}] Checking ${monitor.url} (condition: ${monitor.condition}) ...`);
      try {
        const html = await fetchPage(monitor.url);
        const snap = extractData(html, monitor.url);
        const history = loadHistory(monitor.url);
        const last = history[history.length - 1];
        history.push(snap);
        saveHistory(monitor.url, history);

        monitor.lastCheckedAt = snap.fetchedAt;
        monitor.status = "active";
        changed = true;

        if (!last) {
          console.log(`  Baseline saved.`);
          continue;
        }

        const diff = diffSnapshots(last, snap);
        const outreach = outreachOpportunities(diff);

        if (!matchesCondition(diff, outreach, monitor.condition)) {
          console.log(`  No alert-worthy change for this monitor's condition.`);
          continue;
        }

        console.log(`  Alert-worthy change found (${diff.impact.level} impact).`);

        // Email — resolve to the account's alert email if we have one; monitors
        // created via the dashboard don't collect an email today (uid-cookie based,
        // no signup yet), so this is a no-op until real accounts exist. Left in so
        // it activates automatically once account emails are added.
        if (monitor.channels && monitor.channels.includes("email") && monitor.alertEmail) {
          try {
            await sendChangeAlert({ to: monitor.alertEmail, url: monitor.url, diff });
            console.log(`    Emailed ${monitor.alertEmail}`);
          } catch (e) {
            console.error(`    Failed to email: ${e.message}`);
          }
        }

        if (monitor.slackWebhook) {
          try {
            await sendSlackAlert({ webhookUrl: monitor.slackWebhook, url: monitor.url, diff });
            console.log(`    Sent Slack alert`);
          } catch (e) {
            console.error(`    Slack alert failed: ${e.message}`);
          }
        }
      } catch (e) {
        console.error(`  Error checking ${monitor.url}: ${e.message}`);
      }
    }

    if (changed) {
      fs.writeFileSync(monitorsPath, JSON.stringify(monitors, null, 2));
    }
  }
}

async function main() {
  await processLegacySubscriptions();
  await processDashboardMonitors();
}

main();
