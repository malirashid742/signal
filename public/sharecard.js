const sharp = require("sharp");

// Generates a shareable social card (PNG) for a tracked page's change history.
// This is what shows up when someone shares a /page/:id link on Twitter/LinkedIn —
// makes the tool look like a real product when shared, driving free backlinks/traffic.
async function generateShareCard({ hostname, impactLevel, impactScore, changesSummary }) {
  const impactColor = { High: "#B23A34", Medium: "#E8A33D", Low: "#294B8C", None: "#6B7280" }[impactLevel] || "#6B7280";

  const svg = `
  <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="630" fill="#0F172A"/>
    <rect x="0" y="0" width="1200" height="8" fill="${impactColor}"/>

    <text x="80" y="120" font-family="Arial, sans-serif" font-size="28" fill="#7C8496">Signal — Change Tracker</text>

    <text x="80" y="230" font-family="Arial, sans-serif" font-size="52" font-weight="bold" fill="#FFFFFF">${escapeXml(hostname)}</text>

    <rect x="80" y="270" width="280" height="56" rx="28" fill="${impactColor}22"/>
    <text x="105" y="307" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="${impactColor}">${impactLevel} Impact — ${impactScore}/100</text>

    <text x="80" y="400" font-family="Arial, sans-serif" font-size="26" fill="#B6BDCB">${escapeXml(changesSummary).slice(0, 70)}</text>

    <text x="80" y="560" font-family="Arial, sans-serif" font-size="22" fill="#7C8496">Track competitor changes free — signal.dev</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

function escapeXml(s) {
  return String(s || "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

module.exports = { generateShareCard };
