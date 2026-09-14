// Visual screenshot capture + pixel diffing.
//
// IMPORTANT (deploy safety): nothing heavy is required at module load time.
// Previously this file did `require("@sparticuz/chromium")` and
// `require("playwright-core")` at the top, and server.js requires this file on
// line 10 — so if either native/optional package failed to load on the host
// (wrong Node version, missing binary, install skipped, OOM), the ENTIRE server
// crashed on boot and the deploy was marked failed. Now the browser packages are
// resolved lazily inside captureScreenshot(), so a browser problem degrades the
// screenshot feature instead of taking the whole app down.

const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch").default || require("pixelmatch");

const VIEWPORT = { width: 1280, height: 800 };

// Escape hatch: set DISABLE_SCREENSHOTS=1 on hosts too small to run Chromium.
// A headless Chromium needs roughly 350-450MB of RAM; on a 512MB instance that
// will OOM-kill the whole service, so it is better to turn it off explicitly.
const SCREENSHOTS_DISABLED = process.env.DISABLE_SCREENSHOTS === "1";

let browserRuntime; // cached resolution result: { launch, args, executablePath } | { error }

// Resolves a usable Chromium once and caches the outcome (success or failure).
function resolveBrowserRuntime() {
  if (browserRuntime) return browserRuntime;

  if (SCREENSHOTS_DISABLED) {
    browserRuntime = { error: "Screenshots are disabled on this deployment (DISABLE_SCREENSHOTS=1)." };
    return browserRuntime;
  }

  let playwright;
  try {
    playwright = require("playwright-core").chromium;
  } catch (e) {
    browserRuntime = { error: `playwright-core is not installed on this host: ${e.message}` };
    return browserRuntime;
  }

  // 1) An explicit system Chromium wins — this is how you run screenshots on a
  //    normal Linux host or a Docker image that already ships a browser.
  if (process.env.CHROME_PATH) {
    browserRuntime = { launch: playwright, args: [], executablePath: process.env.CHROME_PATH };
    return browserRuntime;
  }

  // 2) Otherwise fall back to the bundled @sparticuz/chromium build, which is an
  //    optionalDependency — it may legitimately be absent.
  try {
    const chromium = require("@sparticuz/chromium").default || require("@sparticuz/chromium");
    browserRuntime = { launch: playwright, args: chromium.args, chromium };
    return browserRuntime;
  } catch (e) {
    browserRuntime = {
      error:
        "No Chromium available for screenshots. Set CHROME_PATH to a Chromium binary, " +
        `or install @sparticuz/chromium. (${e.message})`,
    };
    return browserRuntime;
  }
}

// True when a screenshot attempt has a chance of succeeding. Callers can use this
// to hide or grey out visual-diff UI rather than firing a request that will fail.
function isScreenshotAvailable() {
  return !resolveBrowserRuntime().error;
}

// Launches a fresh browser per capture and closes it after. @sparticuz/chromium's
// default args include --single-process, which makes a REUSED browser instance die
// as soon as its first page closes — confirmed during testing. Launching fresh each
// time costs ~1-2s extra but is reliable.
async function captureScreenshot(url, timeoutMs = 25000) {
  const runtime = resolveBrowserRuntime();
  if (runtime.error) throw new Error(runtime.error);

  const executablePath = runtime.executablePath || (await runtime.chromium.executablePath());
  const browser = await runtime.launch.launch({
    args: runtime.args,
    executablePath,
    headless: true,
  });
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

module.exports = { captureScreenshot, compareScreenshots, isScreenshotAvailable, VIEWPORT };
