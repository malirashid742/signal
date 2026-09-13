const nodemailer = require("nodemailer");

// Free Gmail SMTP. Setup:
// 1. Use a Gmail account (or create one for the tool, e.g. alerts@yourdomain via Gmail)
// 2. Enable 2FA on that Gmail account
// 3. Create an "App Password": Google Account -> Security -> App passwords
// 4. Set env vars: GMAIL_USER=you@gmail.com  GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
// Free tier limit: ~500 emails/day. Fine for MVP/early customers.

function getTransport() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

function diffToText(url, diff) {
  const lines = [`Changes detected on: ${url}`, `SEO Impact: ${diff.impact.level} (${diff.impact.score}/100)`, ""];
  if (diff.impact.reasons.length) {
    lines.push("Why this matters:");
    diff.impact.reasons.forEach((r) => lines.push(`  - ${r}`));
    lines.push("");
  }
  if (diff.titleChanged) lines.push(`Title:\n  - ${diff.titleChanged.from}\n  + ${diff.titleChanged.to}\n`);
  if (diff.metaDescChanged) lines.push(`Meta description:\n  - ${diff.metaDescChanged.from}\n  + ${diff.metaDescChanged.to}\n`);
  if (diff.contentDiff && diff.contentDiff.changed) {
    lines.push("Body content — exact changes:");
    diff.contentDiff.added.forEach((s) => lines.push(`  + ${s}`));
    diff.contentDiff.removed.forEach((s) => lines.push(`  - ${s}`));
    lines.push("");
  }
  const block = (label, obj) => {
    if (!obj.added.length && !obj.removed.length) return;
    lines.push(`${label}:`);
    obj.added.forEach((x) => lines.push(`  + ${x}`));
    obj.removed.forEach((x) => lines.push(`  - ${x}`));
    lines.push("");
  };
  block("H1 tags", diff.h1);
  block("H2 tags", diff.h2);
  block("Internal links", diff.internalLinks);
  block("External links", diff.externalLinks);
  block("Images", diff.images);
  return lines.join("\n");
}

async function sendChangeAlert({ to, url, diff }) {
  const transport = getTransport();
  await transport.sendMail({
    from: `"Signal Alerts" <${process.env.GMAIL_USER}>`,
    to,
    subject: `Change detected: ${new URL(url).hostname}`,
    text: diffToText(url, diff),
  });
}

// Real Slack incoming-webhook sender (not a placeholder) — paid-tier feature.
// User pastes their own Slack webhook URL (Slack app -> Incoming Webhooks); no
// Slack app approval needed on our end since this is a standard incoming webhook.
async function sendSlackAlert({ webhookUrl, url, diff }) {
  const impactEmoji = { High: "🔴", Medium: "🟠", Low: "🔵", None: "⚪" }[diff.impact.level] || "⚪";
  const lines = [
    `${impactEmoji} *${diff.impact.level} impact change* on <${url}|${new URL(url).hostname}> (${diff.impact.score}/100)`,
  ];
  if (diff.titleChanged) lines.push(`*Title:* ~${diff.titleChanged.from}~ → ${diff.titleChanged.to}`);
  if (diff.impact.reasons.length) lines.push(diff.impact.reasons.map((r) => `• ${r}`).join("\n"));

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: lines.join("\n\n") }),
  });
  if (!res.ok) throw new Error(`Slack webhook failed: ${res.status}`);
}

module.exports = { sendChangeAlert, sendSlackAlert };
