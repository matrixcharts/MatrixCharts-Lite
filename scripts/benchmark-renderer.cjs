'use strict';

const fs = require('node:fs');
const { createRequire } = require('node:module');

const requireFromHere = createRequire(__filename);
const URL = process.argv[2] ?? 'http://localhost:5173/tests/browser/performance.e2e.html';
const puppeteer = requireFromHere(process.env.PUPPETEER_CORE ?? 'puppeteer-core');
const chromeCandidates = [
    process.env.CHROME_PATH,
    'C:/Users/User/.cache/puppeteer/chrome/win64-152.0.7977.75/chrome-win64/chrome.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter((candidate) => candidate && fs.existsSync(candidate));

if (chromeCandidates.length === 0) {
    throw new Error('No Chrome executable found. Set CHROME_PATH.');
}

const launchArgs = [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
];

async function main() {
    const browser = await puppeteer.launch({
        executablePath: chromeCandidates[0],
        headless: true,
        args: launchArgs,
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60_000 });
        await page.waitForFunction(() => globalThis.__mcPerformanceResult !== undefined, { timeout: 120_000 });
        const result = await page.evaluate(() => globalThis.__mcPerformanceResult);
        if (errors.length > 0) result.pageErrors = errors;
        console.log(JSON.stringify(result, null, 2));
        if (errors.length > 0 || result.measuredFrames === 0) process.exitCode = 1;
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error(`renderer benchmark failed: ${error.message}`);
    process.exitCode = 1;
});