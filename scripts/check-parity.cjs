'use strict';
const fs = require('node:fs');
const { createRequire } = require('node:module');
const requireHere = createRequire(__filename);
const puppeteer = requireHere(process.env.PUPPETEER_CORE ?? 'puppeteer-core');
const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter((value) => value && fs.existsSync(value));
if (candidates.length === 0) throw new Error('Set CHROME_PATH to a Chrome executable.');
(async () => {
    const browser = await puppeteer.launch({ executablePath: candidates[0], headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 920, height: 1000, deviceScaleFactor: 1 });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(process.argv[2] ?? 'http://localhost:5173/tests/browser/parity.e2e.html', { waitUntil: 'networkidle2', timeout: 60_000 });
        await page.waitForFunction(() => globalThis.__parityResult !== undefined, { timeout: 60_000 });
        const result = await page.evaluate(() => globalThis.__parityResult);
        console.log(JSON.stringify({ ...result, errors }, null, 2));
        if (errors.length > 0 || result.iou < 0.65) process.exitCode = 1;
    } finally { await browser.close(); }
})().catch((error) => { console.error(`parity check failed: ${error.message}`); process.exitCode = 1; });
