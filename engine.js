const cheerio = require("cheerio");
const crypto = require("crypto");
const { diffWords } = require("diff");

function hash(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SignalBot/1.0)" },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return await res.text();
}

// Like fetchPage, but doesn't throw on non-2xx and records status + response time —
// used for uptime tracking, where a 404/500/timeout IS the data point, not an error.
async function fetchPageWithMeta(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SignalBot/1.0)" },
      signal: controller.signal,
    });
    const responseTimeMs = Date.now() - startedAt;
    clearTimeout(timer);
    const html = res.ok ? await res.text() : "";
    return { html, status: res.status, up: res.status < 400, responseTimeMs, error: null };
  } catch (e) {
    clearTimeout(timer);
    return { html: "", status: null, up: false, responseTimeMs: Date.now() - startedAt, error: e.message };
  }
}

// ---------- PAGE EXTRACTION ----------
function extractData(html, baseUrl) {
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;

  const title = $("title").first().text().trim();
  const metaDesc = $('meta[name="description"]').attr("content") || "";
  const h1 = $("h1").map((_, el) => $(el).text().trim()).get();
  const h2 = $("h2").map((_, el) => $(el).text().trim()).get();
  const bodyClone = $("body").clone();
  bodyClone.find("script,style,noscript").remove();
  // insert a space after every element so adjacent tags (e.g. <h1><h2>) don't
  // have their text concatenated with no boundary — keeps word-diff snippets clean
  bodyClone.find("*").each((_, el) => $(el).after(" "));
  const bodyText = bodyClone.text().replace(/\s+/g, " ").trim();

  // schema.org structured data (JSON-LD) — used for schema-change detection
  const schemaTypes = new Set();
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).contents().text());
      const items = Array.isArray(json) ? json : [json];
      items.forEach((item) => {
        if (item && item["@type"]) {
          const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
          types.forEach((t) => schemaTypes.add(t));
        }
      });
    } catch (e) {}
  });

  const internalLinks = new Set();
  const externalLinks = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    try {
      const abs = new URL(href, baseUrl).href;
      const anchor = $(el).text().trim().slice(0, 80);
      const entry = `${abs} | anchor: "${anchor}"`;
      if (abs.startsWith(origin)) internalLinks.add(entry);
      else externalLinks.add(entry);
    } catch (e) {}
  });

  const images = new Set();
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src");
    const alt = $(el).attr("alt") || "";
    if (!src) return;
    try {
      const abs = new URL(src, baseUrl).href;
      images.add(`${abs} | alt: "${alt}"`);
    } catch (e) {}
  });

  return {
    fetchedAt: new Date().toISOString(),
    title,
    metaDesc,
    h1,
    h2,
    wordCount: bodyText.split(" ").filter(Boolean).length,
    bodyTextHash: hash(bodyText),
    bodyText, // kept for word-level diff
    schemaTypes: [...schemaTypes].sort(),
    internalLinks: [...internalLinks].sort(),
    externalLinks: [...externalLinks].sort(),
    images: [...images].sort(),
  };
}

function diffSets(oldArr = [], newArr = []) {
  const oldSet = new Set(oldArr);
  const newSet = new Set(newArr);
  return {
    added: newArr.filter((x) => !oldSet.has(x)),
    removed: oldArr.filter((x) => !newSet.has(x)),
  };
}

// ---------- WORD-LEVEL CONTENT DIFF (unique #1) ----------
// Returns actual added/removed sentences, not just "content changed: yes/no".
// Caps output so huge pages don't produce unusable walls of text.
function wordLevelContentDiff(oldText, newText, maxSnippets = 6) {
  if (oldText === newText) return { changed: false, added: [], removed: [] };

  const parts = diffWords(oldText, newText);
  const added = [];
  const removed = [];

  parts.forEach((part) => {
    const trimmed = part.value.trim();
    if (!trimmed || trimmed.length < 8) return; // skip tiny/noise diffs (whitespace, single words)
    if (part.added) added.push(trimmed.slice(0, 240));
    else if (part.removed) removed.push(trimmed.slice(0, 240));
  });

  return {
    changed: true,
    added: added.slice(0, maxSnippets),
    removed: removed.slice(0, maxSnippets),
    addedCount: added.length,
    removedCount: removed.length,
  };
}

// ---------- SEO IMPACT SCORE (unique #2) ----------
// Rule-based score, 0-100, flags which changes are likely to actually matter for rankings,
// instead of dumping every diff as equally important.
function seoImpactScore(diff) {
  let score = 0;
  const reasons = [];

  if (diff.titleChanged) { score += 25; reasons.push("Title tag changed — directly affects rankings and CTR"); }
  if (diff.metaDescChanged) { score += 12; reasons.push("Meta description changed — affects click-through rate"); }
  if (diff.h1.added.length || diff.h1.removed.length) { score += 15; reasons.push("H1 changed — signals a shift in page topic/focus"); }
  if (diff.h2.added.length || diff.h2.removed.length) { score += Math.min(10, (diff.h2.added.length + diff.h2.removed.length) * 3); reasons.push("Section headings (H2) restructured"); }

  if (diff.contentDiff && diff.contentDiff.changed) {
    const volume = diff.contentDiff.addedCount + diff.contentDiff.removedCount;
    const contentScore = Math.min(20, volume * 2);
    score += contentScore;
    if (contentScore > 0) reasons.push("Body content rewritten — may target new keywords or intent");
  }

  if (diff.internalLinks.removed.length) { score += Math.min(15, diff.internalLinks.removed.length * 4); reasons.push("Internal links removed — can affect link equity flow"); }
  if (diff.internalLinks.added.length) { score += Math.min(6, diff.internalLinks.added.length * 2); reasons.push("New internal links added"); }
  if (diff.externalLinks.added.length || diff.externalLinks.removed.length) { score += Math.min(8, (diff.externalLinks.added.length + diff.externalLinks.removed.length) * 2); reasons.push("Outbound link profile changed"); }
  if (diff.images.added.length || diff.images.removed.length) { score += Math.min(5, (diff.images.added.length + diff.images.removed.length)); reasons.push("Visual assets changed"); }
  if (diff.schemaChanged) { score += 12; reasons.push("Structured data (schema) changed — affects rich snippet eligibility"); }

  score = Math.min(100, score);
  const level = score >= 50 ? "High" : score >= 20 ? "Medium" : score > 0 ? "Low" : "None";
  return { score, level, reasons };
}

function diffSnapshots(oldSnap, newSnap) {
  const diff = {
    titleChanged: oldSnap.title !== newSnap.title ? { from: oldSnap.title, to: newSnap.title } : null,
    metaDescChanged: oldSnap.metaDesc !== newSnap.metaDesc ? { from: oldSnap.metaDesc, to: newSnap.metaDesc } : null,
    h1: diffSets(oldSnap.h1, newSnap.h1),
    h2: diffSets(oldSnap.h2, newSnap.h2),
    contentChanged: oldSnap.bodyTextHash !== newSnap.bodyTextHash,
    contentDiff: oldSnap.bodyTextHash !== newSnap.bodyTextHash
      ? wordLevelContentDiff(oldSnap.bodyText || "", newSnap.bodyText || "")
      : { changed: false, added: [], removed: [] },
    wordCountDelta: newSnap.wordCount - oldSnap.wordCount,
    internalLinks: diffSets(oldSnap.internalLinks, newSnap.internalLinks),
    externalLinks: diffSets(oldSnap.externalLinks, newSnap.externalLinks),
    images: diffSets(oldSnap.images, newSnap.images),
    schemaChanged: JSON.stringify(oldSnap.schemaTypes || []) !== JSON.stringify(newSnap.schemaTypes || []),
    schema: diffSets(oldSnap.schemaTypes || [], newSnap.schemaTypes || []),
  };
  diff.hasChanges =
    !!diff.titleChanged ||
    !!diff.metaDescChanged ||
    diff.h1.added.length || diff.h1.removed.length ||
    diff.h2.added.length || diff.h2.removed.length ||
    diff.contentChanged ||
    diff.internalLinks.added.length || diff.internalLinks.removed.length ||
    diff.externalLinks.added.length || diff.externalLinks.removed.length ||
    diff.images.added.length || diff.images.removed.length ||
    diff.schemaChanged;

  diff.impact = seoImpactScore(diff);
  return diff;
}

// ---------- SITEMAP NEW-PAGE DETECTION (unique #3) ----------
async function fetchSitemapUrls(origin, _depth = 0) {
  const candidates = _depth === 0 ? [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`] : [origin];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; SignalBot/1.0)" } });
      if (!res.ok) continue;
      const xml = await res.text();
      const $ = cheerio.load(xml, { xmlMode: true });
      const locs = $("loc").map((_, el) => $(el).text().trim()).get();
      if (!locs.length) continue;

      // A sitemap INDEX lists other sitemap.xml files, not page URLs — recurse into
      // a capped number of them and merge the real page URLs together.
      const looksLikeIndex = locs.every((l) => /sitemap.*\.xml(\.gz)?$/i.test(l));
      if (looksLikeIndex && _depth < 2) {
        const subSitemaps = locs.slice(0, 10); // cap sub-sitemaps to avoid huge crawls
        const merged = new Set();
        for (const sub of subSitemaps) {
          const subResult = await fetchSitemapUrls(sub, _depth + 1);
          if (subResult) subResult.urls.forEach((u) => merged.add(u));
        }
        if (merged.size) return { sitemapUrl: url, urls: [...merged].sort() };
        continue;
      }

      return { sitemapUrl: url, urls: [...new Set(locs)].sort() };
    } catch (e) {
      /* try next candidate */
    }
  }
  return null; // no sitemap found
}

function diffSitemap(oldUrls = [], newUrls = []) {
  return diffSets(oldUrls, newUrls);
}

// ---------- PUBLISHING VELOCITY SCORE (growth feature #1) ----------
// Uses sitemap history (list of {fetchedAt, urls}) to compute how fast a domain
// is publishing new pages. Unique data point — no competitor tool surfaces this.
function publishingVelocity(sitemapHistory = []) {
  if (sitemapHistory.length < 2) return null;

  const first = sitemapHistory[0];
  const last = sitemapHistory[sitemapHistory.length - 1];
  const daysElapsed = (new Date(last.fetchedAt) - new Date(first.fetchedAt)) / 86400000;
  if (daysElapsed < 0.5) return null; // not enough time between checks yet

  let totalNewPages = 0;
  for (let i = 1; i < sitemapHistory.length; i++) {
    const diff = diffSets(sitemapHistory[i - 1].urls, sitemapHistory[i].urls);
    totalNewPages += diff.added.length;
  }

  const pagesPerWeek = (totalNewPages / daysElapsed) * 7;
  return {
    totalNewPages,
    daysTracked: Math.round(daysElapsed * 10) / 10,
    pagesPerWeek: Math.round(pagesPerWeek * 10) / 10,
    currentTotalPages: last.urls.length,
  };
}

// ---------- LINK-LOSS OUTREACH FINDER (growth feature #2) ----------
// When a competitor removes an outbound link, that's a real link-building signal:
// the site they used to cite/link to may now want a new source — an outreach opportunity.
function outreachOpportunities(diff) {
  if (!diff.externalLinks || !diff.externalLinks.removed.length) return [];
  return diff.externalLinks.removed.map((entry) => {
    const [url, anchorPart] = entry.split(" | anchor: ");
    return {
      removedLink: url,
      anchorText: (anchorPart || "").replace(/"/g, ""),
      suggestion: `This site used to link to ${new URL(url).hostname} — consider reaching out to them as a potential backlink opportunity for your own content.`,
    };
  });
}

// ---------- SITE-WIDE OUTREACH SCAN ----------
// Checks whether an outbound link is now dead (404/timeout) — a real backlink
// opportunity regardless of history, unlike the diff-based outreach finder which
// only fires when a link is removed between two checks of the SAME page.
async function checkLinkStatus(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; SignalBot/1.0)" } });
    if (res.status === 405 || res.status === 403) {
      // some servers reject HEAD (or block bots) — retry with GET before concluding it's broken
      res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; SignalBot/1.0)" } });
    }
    clearTimeout(timer);
    // Only 4xx/5xx count as "broken" for outreach purposes — 403 after retry is
    // ambiguous (could be real, could be bot-blocking) so we flag it separately
    // rather than claiming it's dead.
    const broken = res.status >= 400 && res.status !== 403;
    const ambiguous = res.status === 403;
    return { url, ok: res.status < 400, broken, ambiguous, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    // Network/timeout/DNS errors are NOT reliable evidence of a broken link —
    // could be our own network restrictions, a firewall, or a transient blip.
    // Never report these as confirmed outreach opportunities.
    return { url, ok: null, broken: false, ambiguous: true, status: null, error: e.message };
  }
}

// Runs a small pool of concurrent checks instead of one-at-a-time (faster) or
// all-at-once (would hammer target servers / hit rate limits).
async function checkLinksInPool(urls, concurrency = 5) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      results[idx] = await checkLinkStatus(urls[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}

module.exports = {
  fetchPage,
  fetchPageWithMeta,
  extractData,
  diffSnapshots,
  hash,
  fetchSitemapUrls,
  diffSitemap,
  wordLevelContentDiff,
  seoImpactScore,
  publishingVelocity,
  outreachOpportunities,
  checkLinkStatus,
  checkLinksInPool,
};
