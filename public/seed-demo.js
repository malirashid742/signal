#!/usr/bin/env node
/**
 * Seeds realistic demo data for a fixed demo user (uid "demo-user"), so anyone can
 * see the dashboard fully populated without waiting on real network checks.
 * Run: node seed-demo.js
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { diffSnapshots, hash } = require("./engine");
const { compareScreenshots } = require("./screenshot");
const { renderMockPageScreenshot } = require("./demo-placeholder");

const DATA_DIR = path.join(__dirname, "data");
const MONITORS_DIR = path.join(DATA_DIR, "monitors");
const SITEMAP_DIR = path.join(DATA_DIR, "sitemaps");
const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");
const UPTIME_DIR = path.join(DATA_DIR, "uptime");
const DEMO_UID = "demo-user";

[DATA_DIR, MONITORS_DIR, SITEMAP_DIR, SCREENSHOTS_DIR, UPTIME_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

function keyFor(url) {
  return crypto.createHash("md5").update(url).digest("hex");
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

function snap({ daysBack, title, metaDesc, h1, h2, bodyText, internalLinks, externalLinks, images, schemaTypes }) {
  return {
    fetchedAt: daysAgo(daysBack),
    title,
    metaDesc,
    h1,
    h2,
    wordCount: bodyText.split(" ").filter(Boolean).length,
    bodyTextHash: hash(bodyText),
    bodyText,
    schemaTypes: schemaTypes || [],
    internalLinks,
    externalLinks,
    images,
  };
}

async function attachScreenshots(history, pageId, accentColor) {
  let prevBuffer = null;
  for (let i = 0; i < history.length; i++) {
    const s = history[i];
    const buffer = await renderMockPageScreenshot({ title: s.title, accentColor, variant: i % 2 === 0 ? "a" : "b" });
    const dir = path.join(SCREENSHOTS_DIR, pageId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = `${Date.parse(s.fetchedAt)}-shot.png`;
    fs.writeFileSync(path.join(dir, filename), buffer);
    s.screenshotFile = filename;

    if (prevBuffer) {
      const result = compareScreenshots(prevBuffer, buffer);
      if (result.diffBuffer) {
        const diffFilename = `${Date.parse(s.fetchedAt)}-diff.png`;
        fs.writeFileSync(path.join(dir, diffFilename), result.diffBuffer);
        s.screenshotDiffFile = diffFilename;
        s.screenshotDiffPercent = result.diffPercent;
      }
    } else {
      s.screenshotDiffFile = null;
      s.screenshotDiffPercent = null;
    }
    prevBuffer = buffer;
  }
}

function seedUptime(pageId, daysBack, incidentDayIndexes = []) {
  const pings = [];
  for (let d = daysBack; d >= 0; d--) {
    const isDown = incidentDayIndexes.includes(d);
    pings.push({
      at: daysAgo(d),
      status: isDown ? 500 : 200,
      up: !isDown,
      responseTimeMs: isDown ? null : 150 + Math.round(Math.random() * 250),
    });
  }
  fs.writeFileSync(path.join(UPTIME_DIR, `${pageId}.json`), JSON.stringify(pings, null, 2));
}

async function main() {
  const monitors = [];

  // ---------- Monitor 1: SaaS competitor pricing page — title/content/link changes ----------
  const url1 = "https://competitor-saas.com/pricing";
  const pageId1 = keyFor(url1);
  const history1 = [
    snap({
      daysBack: 12, title: "CompetitorSaaS — Simple, Transparent Pricing",
      metaDesc: "Plans starting at $29/mo. No hidden fees.",
      h1: ["Simple, Transparent Pricing"], h2: ["Starter", "Pro", "Enterprise"],
      bodyText: "Choose the plan that fits your team. Starter plan includes core features for small teams. Pro plan adds advanced analytics and priority support. Enterprise includes custom SLAs and dedicated onboarding.",
      internalLinks: ["https://competitor-saas.com/features | anchor: \"Features\"", "https://competitor-saas.com/about | anchor: \"About\""],
      externalLinks: ["https://twitter.com/competitorsaas | anchor: \"Twitter\""],
      images: ["https://competitor-saas.com/img/pricing-hero.jpg | alt: \"Pricing hero\""],
    }),
    snap({
      daysBack: 6, title: "CompetitorSaaS — Simple, Transparent Pricing",
      metaDesc: "Plans starting at $29/mo. No hidden fees.",
      h1: ["Simple, Transparent Pricing"], h2: ["Starter", "Pro", "Enterprise"],
      bodyText: "Choose the plan that fits your team. Starter plan includes core features for small teams. Pro plan adds advanced analytics and priority support. Enterprise includes custom SLAs and dedicated onboarding.",
      internalLinks: ["https://competitor-saas.com/features | anchor: \"Features\"", "https://competitor-saas.com/about | anchor: \"About\""],
      externalLinks: ["https://twitter.com/competitorsaas | anchor: \"Twitter\""],
      images: ["https://competitor-saas.com/img/pricing-hero.jpg | alt: \"Pricing hero\""],
    }),
    snap({
      daysBack: 2, title: "CompetitorSaaS — Pricing for Teams of Every Size",
      metaDesc: "Plans starting at $39/mo. Annual discounts available.",
      h1: ["Pricing for Teams of Every Size"], h2: ["Starter", "Pro", "Enterprise", "Case Studies"],
      bodyText: "Choose the plan that fits your team. Starter plan includes core features for small teams. Pro plan adds advanced analytics, priority support, and custom integrations. Enterprise includes custom SLAs, dedicated onboarding, and a named account manager. Book a call with our sales team today.",
      internalLinks: ["https://competitor-saas.com/features | anchor: \"Features\"", "https://competitor-saas.com/case-studies | anchor: \"Case Studies\""],
      externalLinks: ["https://linkedin.com/company/competitorsaas | anchor: \"LinkedIn\""],
      images: ["https://competitor-saas.com/img/pricing-hero-v2.jpg | alt: \"Updated pricing hero\""],
    }),
  ];
  await attachScreenshots(history1, pageId1, "#2563EB");
  fs.writeFileSync(path.join(DATA_DIR, `${pageId1}.json`), JSON.stringify(history1, null, 2));
  seedUptime(pageId1, 12, [8]); // one incident 8 days ago
  monitors.push({ id: uuidv4(), url: url1, pageId: pageId1, condition: "high_impact", frequency: "daily", channels: ["email"], status: "active", createdAt: daysAgo(12), lastCheckedAt: daysAgo(2) });

  // ---------- Monitor 2: Agency competitor services page — content + internal link restructure ----------
  const url2 = "https://competitor-agency.io/services";
  const pageId2 = keyFor(url2);
  const history2 = [
    snap({
      daysBack: 20, title: "CompetitorAgency — Digital Marketing Services",
      metaDesc: "Full-service digital marketing for growing brands.",
      h1: ["Digital Marketing Services"], h2: ["SEO", "PPC", "Content"],
      bodyText: "We help brands grow with SEO, PPC, and content marketing. Our team has 10 years of experience across e-commerce and SaaS clients.",
      internalLinks: ["https://competitor-agency.io/seo | anchor: \"SEO Services\"", "https://competitor-agency.io/ppc | anchor: \"PPC Services\""],
      externalLinks: ["https://clutch.co/profile/competitor-agency | anchor: \"Clutch reviews\""],
      images: ["https://competitor-agency.io/img/team.jpg | alt: \"Our team\""],
    }),
    snap({
      daysBack: 4, title: "CompetitorAgency — Full-Service Digital Marketing",
      metaDesc: "Full-service digital marketing and AI-powered content for growing brands.",
      h1: ["Full-Service Digital Marketing"], h2: ["SEO", "PPC", "Content", "AI Content Ops"],
      bodyText: "We help brands grow with SEO, PPC, content marketing, and AI-powered content operations. Our team has 10 years of experience across e-commerce, SaaS, and healthcare clients. New: AI content audits included in every engagement.",
      internalLinks: ["https://competitor-agency.io/seo | anchor: \"SEO Services\"", "https://competitor-agency.io/ai-content | anchor: \"AI Content Ops\""],
      externalLinks: ["https://clutch.co/profile/competitor-agency | anchor: \"Clutch reviews\"", "https://g2.com/products/competitor-agency | anchor: \"G2 reviews\""],
      images: ["https://competitor-agency.io/img/team-2026.jpg | alt: \"Our team 2026\""],
    }),
  ];
  await attachScreenshots(history2, pageId2, "#7C3AED");
  fs.writeFileSync(path.join(DATA_DIR, `${pageId2}.json`), JSON.stringify(history2, null, 2));
  seedUptime(pageId2, 20, []); // no incidents — 100% uptime
  monitors.push({ id: uuidv4(), url: url2, pageId: pageId2, condition: "any_change", frequency: "daily", channels: ["email"], status: "active", createdAt: daysAgo(20), lastCheckedAt: daysAgo(4) });

  // ---------- Monitor 3: Blog — currently down, to show the "down" state in uptime UI ----------
  const url3 = "https://competitor-blog.net/";
  const pageId3 = keyFor(url3);
  const history3 = [
    snap({
      daysBack: 9, title: "CompetitorBlog — Marketing Insights",
      metaDesc: "Weekly marketing insights and industry news.",
      h1: ["Marketing Insights"], h2: ["Latest Posts"],
      bodyText: "Weekly marketing insights, SEO tips, and industry news for growth teams.",
      internalLinks: ["https://competitor-blog.net/archive | anchor: \"Archive\""],
      externalLinks: [],
      images: ["https://competitor-blog.net/img/hero.jpg | alt: \"Blog hero\""],
    }),
  ];
  await attachScreenshots(history3, pageId3, "#DC2626");
  fs.writeFileSync(path.join(DATA_DIR, `${pageId3}.json`), JSON.stringify(history3, null, 2));
  seedUptime(pageId3, 9, [0, 1]); // down for the last 2 days — active incident
  monitors.push({ id: uuidv4(), url: url3, pageId: pageId3, condition: "any_change", frequency: "daily", channels: ["email"], status: "active", createdAt: daysAgo(9), lastCheckedAt: daysAgo(0) });

  // ---------- Sitemap history for monitor 1's domain — populates "new pages found" ----------
  const origin1 = "https://competitor-saas.com";
  const sitemapHistory = [
    { fetchedAt: daysAgo(12), urls: [`${origin1}/`, `${origin1}/pricing`, `${origin1}/features`, `${origin1}/about`] },
    { fetchedAt: daysAgo(2), urls: [`${origin1}/`, `${origin1}/pricing`, `${origin1}/features`, `${origin1}/about`, `${origin1}/case-studies`, `${origin1}/blog/ai-seo-trends-2026`] },
  ];
  fs.writeFileSync(path.join(SITEMAP_DIR, `${keyFor(origin1)}.json`), JSON.stringify(sitemapHistory, null, 2));

  // ---------- Save monitors + subscriptions for demo user ----------
  fs.writeFileSync(path.join(MONITORS_DIR, `${DEMO_UID}.json`), JSON.stringify(monitors, null, 2));

  console.log("Demo data seeded for uid:", DEMO_UID);
  console.log("Monitors:", monitors.map((m) => m.url));
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
