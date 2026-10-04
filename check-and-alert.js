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
const { fetchPage, extractData, diffSnapshots, outreachOpportunities, impactMeetsThreshold } = require("./engine");
const { sendChangeAlert, sendSlackAlert, sendDiscordAlert } = require("./alerts");
const { supabase } = require("./supabaseClient");

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

// Real-account monitors now live in Supabase, not local files. The cron has no
// user session (just the anon key), so it reads/writes through narrow
// SECURITY DEFINER Postgres functions (cron_*) instead of the service_role key —
// each does exactly one job and was tested under `set local role anon` before
// being wired in here. This covers every account's monitors in one pass.
async function processDashboardMonitors() {
  const { data: monitors, error } = await supabase.rpc("cron_list_monitors_v3");
  if (error) {
    console.error(`[monitors] Failed to list monitors: ${error.message}`);
    return;
  }
  if (!monitors || !monitors.length) return;

  for (const monitor of monitors) {
    console.log(`[monitors:${monitor.user_id}] Checking ${monitor.url} (condition: ${monitor.condition}) ...`);
    try {
      const html = await fetchPage(monitor.url);
      const snap = extractData(html, monitor.url, monitor.selector);

      const { data: lastRow } = await supabase.rpc("cron_get_last_snapshot", { p_page_id: monitor.page_id });
      const last = lastRow
        ? { title: lastRow.title, metaDesc: lastRow.meta_desc, h1: lastRow.h1 || [], h2: lastRow.h2 || [], wordCount: lastRow.word_count, bodyTextHash: lastRow.body_text_hash, internalLinks: lastRow.internal_links || [], externalLinks: lastRow.external_links || [], images: lastRow.images || [], schemaTypes: lastRow.schema_types || [] }
        : null;

      await supabase.rpc("cron_insert_snapshot", {
        p_page_id: monitor.page_id,
        p_title: snap.title,
        p_meta_desc: snap.metaDesc,
        p_h1: snap.h1,
        p_h2: snap.h2,
        p_word_count: snap.wordCount,
        p_body_text_hash: snap.bodyTextHash,
        p_internal_links: snap.internalLinks,
        p_external_links: snap.externalLinks,
        p_images: snap.images,
        p_schema_types: snap.schemaTypes,
      });

      await supabase.rpc("cron_update_monitor_status", { p_monitor_id: monitor.id, p_status: "active", p_checked_at: snap.fetchedAt });

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
      if (!impactMeetsThreshold(diff.impact.level, monitor.min_impact || "Low")) {
        console.log(`  Change found but below this monitor's noise filter (${diff.impact.level} < ${monitor.min_impact}).`);
        continue;
      }

      console.log(`  Alert-worthy change found (${diff.impact.level} impact).`);

      if (monitor.channels && monitor.channels.includes("email") && monitor.email) {
        try {
          await sendChangeAlert({ to: monitor.email, url: monitor.url, diff });
          console.log(`    Emailed ${monitor.email}`);
        } catch (e) {
          console.error(`    Failed to email: ${e.message}`);
        }
      }
      if (monitor.slack_webhook) {
        try {
          await sendSlackAlert({ webhookUrl: monitor.slack_webhook, url: monitor.url, diff });
          console.log(`    Sent Slack alert`);
        } catch (e) {
          console.error(`    Slack alert failed: ${e.message}`);
        }
      }
      if (monitor.discord_webhook) {
        try {
          await sendDiscordAlert({ webhookUrl: monitor.discord_webhook, url: monitor.url, diff });
          console.log(`    Sent Discord alert`);
        } catch (e) {
          console.error(`    Discord alert failed: ${e.message}`);
        }
      }

      if (monitor.auto_pause) {
        await supabase.rpc("cron_pause_monitor", { p_monitor_id: monitor.id });
        console.log(`  Auto-paused after firing (one-shot monitor).`);
      }
    } catch (e) {
      console.error(`  Error checking ${monitor.url}: ${e.message}`);
    }
  }
}

async function main() {
  await processLegacySubscriptions();
  await processDashboardMonitors();
}

main();
