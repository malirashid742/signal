#!/usr/bin/env node
/**
 * Weekly email digest — one email per account summarizing all their monitors'
 * activity over the last 7 days (changes found, biggest impact, word-count
 * drift). Run on a schedule (GitHub Actions, weekly). No service_role key —
 * reads via the same narrow SECURITY DEFINER cron_* functions used by
 * check-and-alert.js, with the base (anon) Supabase client.
 *
 * Usage: node send-digest.js
 * Requires env vars: SUPABASE_URL, SUPABASE_ANON_KEY, GMAIL_USER, GMAIL_APP_PASSWORD
 */
const nodemailer = require("nodemailer");
const { diffSnapshots } = require("./engine");
const { supabase } = require("./supabaseClient");

const DAY = 86400000;
const WINDOW_DAYS = 7;

function mapSnap(row) {
  return {
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
  };
}

async function monitorWeekSummary(monitor) {
  const { data, error } = await supabase.rpc("cron_list_snapshots", { p_page_id: monitor.page_id });
  if (error || !data || data.length < 2) return null;
  const snaps = data.map(mapSnap);
  const now = Date.now();
  const cutoff = now - WINDOW_DAYS * DAY;

  let changeCount = 0;
  let topImpact = { level: "None", score: -1, reasons: [] };
  for (let i = 1; i < snaps.length; i++) {
    const checkedAt = new Date(snaps[i].fetchedAt).getTime();
    if (checkedAt < cutoff) continue;
    const diff = diffSnapshots(snaps[i - 1], snaps[i]);
    if (!diff.hasChanges) continue;
    changeCount++;
    if (diff.impact.score > topImpact.score) topImpact = diff.impact;
  }
  if (!changeCount) return null;
  return { url: monitor.url, changeCount, topImpact };
}

async function main() {
  const { data: monitors, error } = await supabase.rpc("cron_list_monitors_v4");
  if (error) {
    console.error(`Failed to list monitors: ${error.message}`);
    return;
  }
  if (!monitors || !monitors.length) return;

  const byUser = {};
  for (const m of monitors) {
    byUser[m.user_id] = byUser[m.user_id] || { email: m.email, items: [] };
    byUser[m.user_id].items.push(m);
  }

  const transport = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  for (const [userId, { email, items }] of Object.entries(byUser)) {
    if (!email) continue;
    const summaries = [];
    for (const monitor of items) {
      const s = await monitorWeekSummary(monitor);
      if (s) summaries.push(s);
    }
    if (!summaries.length) {
      console.log(`[digest] ${email}: no changes this week, skipping.`);
      continue;
    }
    const lines = [`Your weekly Signal digest — ${summaries.length} page(s) with changes in the last 7 days:`, ""];
    summaries
      .sort((a, b) => b.topImpact.score - a.topImpact.score)
      .forEach((s) => {
        lines.push(`${s.url}`);
        lines.push(`  ${s.changeCount} change(s) — top impact: ${s.topImpact.level} (${s.topImpact.score}/100)`);
        if (s.topImpact.reasons.length) lines.push(`  ${s.topImpact.reasons[0]}`);
        lines.push("");
      });
    lines.push("View full history: https://signal-4192.onrender.com/dashboard.html");

    try {
      await transport.sendMail({
        from: `"Signal Weekly Digest" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: `Signal: ${summaries.length} page(s) changed this week`,
        text: lines.join("\n"),
      });
      console.log(`[digest] Emailed ${email} (${summaries.length} pages).`);
    } catch (e) {
      console.error(`[digest] Failed to email ${email}: ${e.message}`);
    }
  }
}

main();
