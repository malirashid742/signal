const chromium = require("@sparticuz/chromium").default;
const { chromium: playwright } = require("playwright-core");
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch").default || require("pixelmatch");

const VIEWPORT = { width: 1280, height: 800 };

// Launches a fresh browser per capture and closes it after. @sparticuz/chromium's
// default args include --single-process, which makes a REUSED browser instance die
// as soon as its first page closes — confirmed during testing. Launching fresh each
// time costs ~1-2s extra but is reliable.
async function captureScreenshot(url, timeoutMs = 25000) {
  const execPath = await chromium.executablePath();
  const browser = await playwright.launch({ args: chromium.args, executablePath: execPath, headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForTimeout(1000); // brief settle time for late-rendering content
    const buffer = await page.screenshot({ type: "png" });
    return buffer;
  } finally {
    await browser.close();
  }
}

// Compares two PNG buffers of the same dimensions, returns a diff image (PNG buffer,
// changed regions highlighted in red) plus the percentage of pixels that changed.
function compareScreenshots(oldBuffer, newBuffer) {
  const oldPng = PNG.sync.read(oldBuffer);
  const newPng = PNG.sync.read(newBuffer);

  if (oldPng.width !== newPng.width || oldPng.height !== newPng.height) {
    // dimensions changed (shouldn't normally happen with a fixed viewport) — skip diffing
    return { diffPercent: null, diffBuffer: null, comparable: false };
  }

  const { width, height } = oldPng;
  const diffPng = new PNG({ width, height });
  const changedPixels = pixelmatch(oldPng.data, newPng.data, diffPng.data, width, height, { threshold: 0.15 });
  const totalPixels = width * height;
  const diffPercent = Math.round((changedPixels / totalPixels) * 10000) / 100; // 2 decimal places

  return { diffPercent, diffBuffer: PNG.sync.write(diffPng), comparable: true };
}

module.exports = { captureScreenshot, compareScreenshots, VIEWPORT };
