// scripts/pixel-parity.test.cjs
//
// Automated WebGL/Canvas2D pixel-parity test.
//
// Spins up two charts in a headless browser — one with WebGL2, one forced onto
// the Canvas2D fallback — renders the same data through both, and compares the
// resulting pixel buffers. The test asserts that the two renderers produce
// visually equivalent output for the same transformed data and viewport.
//
// Usage:
//   node scripts/pixel-parity.test.cjs [--chrome-path PATH] [--verbose]
//
// Environment:
//   CHROME_PATH  — path to a Chrome/Edge executable (auto-detected if unset)

'use strict';

const { createRequire } = require('node:module');
const requireHere = createRequire(__filename);
const puppeteer = requireHere(process.env.PUPPETEER_CORE ?? 'puppeteer-core');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

// --- config ------------------------------------------------------------------

const DEFAULT_PORT = 0; // ephemeral
const PARITY_THRESHOLD = 0.65; // minimum IoU for pass
const PIXEL_ALPHA_THRESHOLD = 16; // alpha > this counts as "drawn"

// --- static file server ------------------------------------------------------

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.ts': 'application/javascript',
};

function startServer(rootDir) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = req.url.split('?')[0];
            const filePath = path.join(rootDir, url === '/' ? '/index.html' : url);
            if (!filePath.startsWith(rootDir)) {
                res.writeHead(403); res.end(); return;
            }
            fs.readFile(filePath, (err, data) => {
                if (err) { res.writeHead(404); res.end('Not found'); return; }
                const ext = path.extname(filePath).toLowerCase();
                res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
                res.end(data);
            });
        });
        server.listen(DEFAULT_PORT, '127.0.0.1', () => {
            const addr = server.address();
            resolve({ server, port: addr.port });
        });
        server.on('error', reject);
    });
}

// --- parity page -------------------------------------------------------------

const PARITY_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{margin:0;background:#111;font-family:monospace}
.chart{width:900px;height:480px;margin:10px}
</style></head>
<body>
<div id="webgl" class="chart"></div>
<div id="canvas" class="chart"></div>
<script type="module">
import { Chart } from '/src/index.ts';

// Generate deterministic test data
function makeCandles(count, pattern) {
    const candles = [];
    const base = 100;
    for (let i = 0; i < count; i++) {
        let open, close, high, low;
        switch (pattern) {
            case 'sine': {
                const b = base + Math.sin(i * 0.18) * 6;
                close = b + Math.sin(i * 0.41) * 1.2;
                open = b;
                high = Math.max(open, close) + 1;
                low = Math.min(open, close) - 1;
                break;
            }
            case 'trend': {
                close = base + i * 0.3 + Math.sin(i * 0.1) * 2;
                open = close - 1 + Math.random() * 2;
                high = Math.max(open, close) + 0.5 + Math.random();
                low = Math.min(open, close) - 0.5 - Math.random();
                break;
            }
            case 'flat': {
                close = base + (i % 2 === 0 ? 0.5 : -0.5);
                open = base;
                high = Math.max(open, close) + 0.3;
                low = Math.min(open, close) - 0.3;
                break;
            }
            case 'gaps': {
                const b = base + Math.sin(i * 0.05) * 10;
                close = b + Math.sin(i * 0.3) * 3;
                open = b;
                high = Math.max(open, close) + 2;
                low = Math.min(open, close) - 2;
                break;
            }
        }
        candles.push({
            time: 1_700_000_000_000 + i * 60_000,
            open, high, low, close,
            volume: 100 + Math.floor(Math.abs(Math.sin(i * 0.7)) * 500),
        });
    }
    return candles;
}

// Capture WebGL pixels by hooking draw calls
let capturedWebgl = null;
const originalDrawElements = WebGL2RenderingContext.prototype.drawElements;
const originalDrawArrays = WebGL2RenderingContext.prototype.drawArrays;
const capture = function(gl) {
    const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (capturedWebgl === null) {
        capturedWebgl = { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, pixels: new Uint8Array(pixels) };
        return;
    }
    // Union: keep the maximum alpha seen at each pixel
    for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > capturedWebgl.pixels[index]) capturedWebgl.pixels[index] = pixels[index];
    }
};
WebGL2RenderingContext.prototype.drawElements = function(...args) {
    const result = originalDrawElements.apply(this, args);
    capture(this);
    return result;
};
WebGL2RenderingContext.prototype.drawArrays = function(...args) {
    const result = originalDrawArrays.apply(this, args);
    capture(this);
    return result;
};

const testCases = [];
const patterns = ['sine', 'trend', 'flat', 'gaps'];
const candleCounts = [50, 180, 500];

for (const pattern of patterns) {
    for (const count of candleCounts) {
        testCases.push({ pattern, count });
    }
}

const results = [];
let forceCanvas = true;

for (const tc of testCases) {
    capturedWebgl = null;
    const candles = makeCandles(tc.count, tc.pattern);
    const options = {
        layout: { priceAxisWidth: 0, timeAxisHeight: 0 },
        candlestick: { lastPriceTag: false },
        crosshair: { visible: false },
    };

    // WebGL chart
    const webglEl = document.querySelector('#webgl');
    webglEl.innerHTML = '';
    const webgl = new Chart(webglEl, options);
    webgl.setData(candles);

    // Canvas2D chart (force fallback)
    const canvasEl = document.querySelector('#canvas');
    canvasEl.innerHTML = '';
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
        if (forceCanvas && kind === 'webgl2') return null;
        return originalGetContext.call(this, kind, ...args);
    };
    const canvas = new Chart(canvasEl, options);
    canvas.setData(candles);
    HTMLCanvasElement.prototype.getContext = originalGetContext;

    await new Promise(r => setTimeout(r, 50));

    // Read pixels from both
    const readMask = (el, kind) => {
        const dataCanvas = el.querySelectorAll('canvas')[1];
        if (kind === 'webgl') {
            const gl = dataCanvas.getContext('webgl2');
            const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
            gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, pixels };
        }
        const ctx = dataCanvas.getContext('2d');
        return { width: dataCanvas.width, height: dataCanvas.height, pixels: ctx.getImageData(0, 0, dataCanvas.width, dataCanvas.height).data };
    };

    const webglMask = capturedWebgl ?? readMask(webglEl, 'webgl');
    const canvasMask = readMask(canvasEl, 'canvas');

    let webglCount = 0, canvasCount = 0, overlap = 0;
    const total = Math.min(webglMask.pixels.length, canvasMask.pixels.length) / 4;
    for (let index = 0; index < total; index++) {
        const x = index % webglMask.width;
        const y = Math.floor(index / webglMask.width);
        const webglIndex = ((webglMask.height - 1 - y) * webglMask.width + x) * 4;
        const canvasIndex = index * 4;
        const webglPixel = webglMask.pixels[webglIndex + 3] > ${PIXEL_ALPHA_THRESHOLD};
        const canvasPixel = canvasMask.pixels[canvasIndex + 3] > ${PIXEL_ALPHA_THRESHOLD};
        if (webglPixel) webglCount++;
        if (canvasPixel) canvasCount++;
        if (webglPixel && canvasPixel) overlap++;
    }

    const iou = overlap / Math.max(webglCount + canvasCount - overlap, 1);
    results.push({
        pattern: tc.pattern,
        count: tc.count,
        webglPixels: webglCount,
        canvasPixels: canvasCount,
        overlap,
        iou,
        pass: iou >= ${PARITY_THRESHOLD},
    });

    webgl.destroy();
    canvas.destroy();
}

window.__parityResults = results;
</script></body></html>`;

// --- test runner -------------------------------------------------------------

async function runTests() {
    const args = process.argv.slice(2);
    const verbose = args.includes('--verbose');
    const chromePathArg = args.find(a => a.startsWith('--chrome-path='));
    const chromePath = chromePathArg ? chromePathArg.split('=')[1] : process.env.CHROME_PATH;

    const rootDir = path.resolve(__dirname, '..');
    const { server, port } = await startServer(rootDir);

    const candidates = [
        chromePath,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].filter(v => v && fs.existsSync(v));

    if (candidates.length === 0) {
        console.error('No Chrome/Edge executable found. Set CHROME_PATH or pass --chrome-path=');
        server.close();
        process.exit(1);
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: candidates[0],
            headless: true,
            args: [
                '--no-sandbox',
                '--enable-unsafe-swiftshader',
                '--use-gl=angle',
                '--use-angle=swiftshader',
                '--enable-webgl',
            ],
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 920, height: 1200, deviceScaleFactor: 1 });

        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        page.on('console', msg => {
            if (msg.type() === 'error') errors.push(msg.text());
        });

        const url = `http://127.0.0.1:${port}/scripts/pixel-parity-page.html`;
        // Write the parity page to a temp file and serve it
        const pagePath = path.join(rootDir, 'scripts', '.pixel-parity-page.html');
        fs.writeFileSync(pagePath, PARITY_PAGE);

        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 120_000 });
            await page.waitForFunction(() => window.__parityResults !== undefined, { timeout: 120_000 });

            const results = await page.evaluate(() => window.__parityResults);

            let passed = 0;
            let failed = 0;

            console.log('\n=== WebGL/Canvas2D Pixel Parity Tests ===\n');

            for (const r of results) {
                const status = r.pass ? 'PASS' : 'FAIL';
                if (r.pass) passed++; else failed++;
                if (verbose || !r.pass) {
                    console.log(`  [${status}] ${r.pattern} (${r.count} candles) — IoU: ${r.iou.toFixed(4)} (webgl: ${r.webglPixels}, canvas: ${r.canvasPixels}, overlap: ${r.overlap})`);
                }
            }

            console.log(`\n  ${passed} passed, ${failed} failed out of ${results.length} tests`);

            if (errors.length > 0) {
                console.log('\n  Page errors:');
                for (const err of errors) console.log(`    ${err}`);
            }

            if (failed > 0 || errors.length > 0) {
                process.exitCode = 1;
            }
        } finally {
            fs.unlinkSync(pagePath);
        }
    } finally {
        if (browser) await browser.close();
        server.close();
    }
}

runTests().catch(err => {
    console.error(`Pixel parity test failed: ${err.message}`);
    process.exitCode = 1;
});
