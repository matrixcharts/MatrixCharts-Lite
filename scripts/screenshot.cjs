// Screenshots a page from the dev server.
//
// This exists because the browser tooling available here cannot produce one, and
// a chart is a visual artefact: three of the pane-phase defects — a starved axis
// tick step, a unit-inverted pane span, a stale demo control — were all found by
// looking at the output, and none of them produced a test failure first.
//
//   node scripts/screenshot.cjs <url> <out.png> [width] [height]
//
// Environment:
//   SHOT_SETUP      "<element-id>=<value>", sets a control and fires 'change'
//   PUPPETEER_CORE  path to puppeteer-core, if it is not resolvable
//   CHROME_PATH     path to a Chrome or Chromium binary
//
// It is a development tool, not part of the package: `files` ships only dist and
// docs, and nothing under scripts/ is referenced by the built output.
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const PUPPETEER_CANDIDATES = [
    'puppeteer-core',
    'puppeteer-core/node_modules/puppeteer-core',
    'D:/Projects/Trade-Metrics/node_modules/puppeteer-core',
];
const CHROME_CANDIDATES = [
    'C:/Users/User/.cache/puppeteer/chrome/win64-152.0.7977.75/chrome-win64/chrome.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

function resolvePuppeteer() {
    if (process.env.PUPPETEER_CORE) return process.env.PUPPETEER_CORE;
    for (const candidate of PUPPETEER_CANDIDATES) {
        try {
            require.resolve(candidate);
            return candidate;
        } catch { /* keep looking */ }
    }
    throw new Error(
        'screenshot.cjs needs puppeteer-core. Set PUPPETEER_CORE to its path, or install it.\n'
        + 'Tried: ' + PUPPETEER_CANDIDATES.join(', '),
    );
}

function resolveChrome() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    for (const candidate of CHROME_CANDIDATES) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error('screenshot.cjs needs a Chrome binary. Set CHROME_PATH to one.');
}

/** WebGL needs a real GL backend; headless defaults to one that has none. */
const LAUNCH_ARGS = [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--hide-scrollbars',
];

async function main() {
    const [url, out, width = '1280', height = '900'] = process.argv.slice(2);
    if (!url || !out) {
        console.error('usage: node scripts/screenshot.cjs <url> <out.png> [width] [height]');
        process.exit(2);
    }

    const puppeteer = require(resolvePuppeteer());
    const browser = await puppeteer.launch({
        executablePath: resolveChrome(),
        headless: true,
        args: [...LAUNCH_ARGS, `--window-size=${width},${height}`],
    });
    try {
        const page = await browser.newPage();
        // dpr 2 is the case that keeps breaking: a CSS-pixel threshold compared
        // against device pixels passes at 1 and fails at 2, and has bitten three
        // separate checks.
        await page.setViewport({ width: Number(width), height: Number(height), deviceScaleFactor: 2 });
        const problems = [];
        page.on('pageerror', (error) => problems.push('pageerror: ' + error.message));
        page.on('console', (message) => {
            if (message.type() === 'error') problems.push('console: ' + message.text().slice(0, 200));
        });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        // Long enough for a live mock feed to produce a screenful of candles.
        await new Promise((resolve) => setTimeout(resolve, 8000));

        const setup = process.env.SHOT_SETUP;
        if (setup) {
            const separator = setup.indexOf('=');
            const id = setup.slice(0, separator);
            const value = setup.slice(separator + 1);
            await page.evaluate((elementId, elementValue) => {
                const element = document.getElementById(elementId);
                if (!element) throw new Error('no element #' + elementId);
                element.value = elementValue;
                element.dispatchEvent(new Event('change'));
            }, id, value);
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }

        const canvases = await page.evaluate(() => Array.from(document.querySelectorAll('canvas'))
            .map((canvas) => `${canvas.width}x${canvas.height}`));
        await page.screenshot({ path: path.resolve(out) });
        console.log(JSON.stringify({ out: path.resolve(out), canvases, problems: problems.slice(0, 5) }, null, 1));
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error('screenshot failed:', error.message);
    process.exit(1);
});
