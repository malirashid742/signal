const sharp = require("sharp");

// Renders a mock webpage screenshot (browser chrome + colored content blocks) for
// demo/seed data — visually plausible without needing a real page navigation.
// Real user checks still use screenshot.js (actual Playwright capture); this is
// only for populating the one-click demo dataset quickly and reliably.
async function renderMockPageScreenshot({ title, accentColor = "#2563EB", variant = "a" }) {
  const w = 1280, h = 800;
  const blocks = variant === "a"
    ? [
        { x: 60, y: 140, w: 500, h: 28 },
        { x: 60, y: 190, w: 700, h: 16 },
        { x: 60, y: 216, w: 650, h: 16 },
        { x: 60, y: 270, w: 220, h: 90, fill: accentColor },
        { x: 300, y: 270, w: 220, h: 90, fill: "#E5E7EB" },
        { x: 540, y: 270, w: 220, h: 90, fill: "#E5E7EB" },
      ]
    : [
        { x: 60, y: 140, w: 560, h: 28 },
        { x: 60, y: 190, w: 720, h: 16 },
        { x: 60, y: 216, w: 500, h: 16 },
        { x: 60, y: 250, w: 300, h: 16 },
        { x: 60, y: 300, w: 220, h: 90, fill: accentColor },
        { x: 300, y: 300, w: 220, h: 90, fill: "#E5E7EB" },
        { x: 540, y: 300, w: 220, h: 90, fill: "#E5E7EB" },
        { x: 780, y: 300, w: 220, h: 90, fill: "#E5E7EB" },
      ];

  const rects = blocks.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="4" fill="${b.fill || '#D1D5DB'}"/>`).join("");

  const svg = `
  <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#FFFFFF"/>
    <rect width="${w}" height="64" fill="#111827"/>
    <circle cx="30" cy="32" r="8" fill="#EF4444"/>
    <circle cx="55" cy="32" r="8" fill="#F59E0B"/>
    <circle cx="80" cy="32" r="8" fill="#10B981"/>
    <text x="120" y="40" font-family="Arial" font-size="16" fill="#F9FAFB">${escapeXml(title).slice(0, 60)}</text>
    ${rects}
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

function escapeXml(s) {
  return String(s || "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

module.exports = { renderMockPageScreenshot };
