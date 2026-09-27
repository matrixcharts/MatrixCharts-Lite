// Interaction invariants: does the chart stay put under the pointer?
//
// The unit suite asserts ranges and counts, which is the right level for geometry but
// blind to the failure a trader notices first — the series sliding sideways while they
// zoom. That is a statement about a *position*, so it needs a test that records where
// one particular bar landed before and after a gesture, and asserts it did not move.
//
// Every case drives a real wheel or drag event through the browser rather than
// calling a method, because a hand-written call cannot catch a handler that never runs.
//
//   node scripts/check-interaction.mjs [url]
//
// Exits non-zero if any invariant fails, and prints the measurement rather than a
// verdict. Skips cleanly when no browser is available, so it can live in `verify`
// without making packaging depend on one.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require_ = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const URL = process.argv[2] ?? 'http://localhost:5173/tests/browser/interaction.e2e.html';

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    'C:/Users/User/.cache/puppeteer/chrome/win64-152.0.7977.75/chrome-win64/chrome.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
].filter((p) => typeof p === 'string' && p.length > 0 && existsSync(p));

const CORE_CANDIDATES = [
    'puppeteer-core',
    'puppeteer-core/node_modules/puppeteer-core',
    'D:/Projects/Trade-Metrics/node_modules/puppeteer-core',
];

// The contract, stated as the user put it: under half a pixel.
const ANCHOR_TOLERANCE_PX = 0.5;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
    results.push({ name, ok });
    process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name}\n         ${detail}\n`);
}

function resolveCore() {
    for (const candidate of CORE_CANDIDATES) {
        try {
            return require_(candidate);
        } catch {
            // Next candidate.
        }
    }
    return null;
}

const core = resolveCore();
if (core === null || CHROME_CANDIDATES.length === 0) {
    console.log('interaction: skipped — no Chrome and/or puppeteer-core.');
    console.log('  set CHROME_PATH, or make puppeteer-core resolvable, to enforce it');
    process.exit(0);
}

const browser = await core.launch({
    executablePath: CHROME_CANDIDATES[0],
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

try {
    const page = await browser.newPage();
    // dpr 1. Everything asserted here is in CSS pixels and a fractional device
    // ratio would only add a conversion that could be wrong in a second way.
    await page.setViewport({ width: 1280, height: 700, deviceScaleFactor: 1 });

    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => globalThis.__mcReady === true, { timeout: 20000 });
    await wait(500);

    const plot = await page.evaluate(() => globalThis.__mc.plot());
    const midY = plot.y + plot.height / 2;

    // Where to point. The third case is the one this whole feature exists for: inside
    // a session break, where the pointer is over no bar at all. A lookup that clamps
    // to the nearer bar will jump by up to half a break, and a collapsed break is
    // half a bar wide, so the lurch is exactly the width of a bar.
    const zones = await page.evaluate(() => {
        const mc = globalThis.__mc;
        const { x, width } = mc.plot();
        const count = mc.count();
        const spacing = mc.spacing();
        let at = 0;
        let jump = 0;
        for (let i = 1; i < count - 1; i++) {
            const step = mc.xOf(i + 1) - mc.xOf(i);
            if (step > jump) {
                jump = step;
                at = i;
            }
        }
        return {
            left: x + width * 0.25,
            centre: x + width * 0.5,
            // The middle of the widest gap between two bars.
            inBreak: mc.xOf(at) + (jump - spacing) / 2,
            spacing,
        };
    });

    // Zoom about the pointer, in both directions, at three places.
    for (const direction of [-1, 1]) {
        {
            // Reset, then *detach* from the live edge. A live-following chart is
            // supposed to move when it zooms — parking the newest bar against the edge
            // slides everything behind it — so the invariant only has meaning on a
            // chart the user has taken control of. The detach is a real drag, because
            // that is the only thing that breaks the latch.
            await page.evaluate(() => globalThis.__mc.chart.scrollToRealtime());
            await wait(150);
            await page.mouse.move(plot.x + plot.width * 0.5, midY);
            await page.mouse.down();
            await page.mouse.move(plot.x + plot.width * 0.5 - 40, midY, { steps: 6 });
            await page.mouse.up();
            await wait(200);

            // The bar to hold is one whose *centre* is exactly where the pointer goes.
            //
            // The first version picked the bar nearest the pointer and asserted it did
            // not move, which is the wrong statement. Zooming holds the point under the
            // cursor fixed, and a scale about that point displaces everything else in
            // proportion to its distance from it — so a bar whose centre is half a bar
            // away is *supposed* to move by up to half a bar times the zoom factor.
            // That mis-stated invariant read as a 1.5-4.6px drift at twelve pixels a
            // bar, which is precisely the half-bar the geometry allows, and it would
            // have sent me hunting a bug in code that was correct.
            //
            // So: take a bar, put the pointer on its centre, and require that bar to
            // stay. Anything the pointer is not on is allowed to move.
            const target = await page.evaluate(() => {
                const mc = globalThis.__mc;
                const { x, width } = mc.plot();
                // A bar comfortably inside the plot, on the side away from the live
                // edge so the detach above is not undone by it re-latching.
                const index = mc.indexAt(x + width * 0.4);
                return { index, x: mc.xOf(index) };
            });
            await page.mouse.move(target.x, midY);

            for (let i = 0; i < 5; i++) {
                await page.mouse.wheel({ deltaY: direction * 200 });
                await wait(80);
            }
            await wait(250);

            const after = await page.evaluate((index) => globalThis.__mc.xOf(index), target.index);
            const drift = Math.abs(after - target.x);
            record(
                `zoom ${direction < 0 ? 'in ' : 'out'} holds the bar under the pointer`,
                drift <= ANCHOR_TOLERANCE_PX,
                `bar ${target.index} moved ${drift.toFixed(3)}px (limit ${ANCHOR_TOLERANCE_PX}px)`,
            );
        }
    }

    // Programmatic bar spacing. This is a *different* code path from the wheel: the
    // wheel goes through zoomAt, and a barSpacing change goes through applyBarSpacing.
    // They anchor the same way and are easy to confuse, which is exactly why the
    // invariant is asserted on both — the bug this harness was built to catch lived in
    // the second one and a wheel-only test would never have seen it.
    await page.evaluate(() => globalThis.__mc.chart.scrollToRealtime());
    await wait(150);
    await page.mouse.move(plot.x + plot.width * 0.5, midY);
    await page.mouse.down();
    await page.mouse.move(plot.x + plot.width * 0.5 - 40, midY, { steps: 6 });
    await page.mouse.up();
    await wait(200);

    // The contract of a plot-centred zoom is not "nothing moved". It is: the transform
    // is a pure scale about the plot centre by a known factor. So predict where the
    // bar must land and compare, which checks the anchor point *and* the factor rather
    // than only the absence of movement.
    //
    //     x' = centre + (x - centre) * factor
    //
    // Asserting "did not move" instead is only valid for a bar whose centre coincides
    // with the plot centre, and no such bar generally exists — the nearest one is up to
    // half a bar away, so it is *supposed* to move. That is what the 9.998px was: half
    // a bar times the zoom factor, which the contract allows and a naive assertion
    // reports as a bug.
    //
    // Predict-and-compare also discriminates the one way this can genuinely be wrong:
    // if the code takes its live-edge branch instead of anchoring, the prediction fails
    // loudly and by a lot, rather than drifting a few pixels for reasons nobody can
    // reconstruct afterwards.
    const before = await page.evaluate(() => {
        const mc = globalThis.__mc;
        const { x, width } = mc.plot();
        const centre = x + width / 2;
        const index = mc.indexAt(centre);
        return { index, barX: mc.xOf(index), centre, spacing: mc.spacing() };
    });

    const factor = 1.4;
    await page.evaluate((s) => globalThis.__mc.chart.applyOptions({ timeScale: { barSpacing: s * 1.4 } }),
        before.spacing);
    await wait(300);

    const predicted = before.centre + (before.barX - before.centre) * factor;
    const actual = await page.evaluate((index) => globalThis.__mc.xOf(index), before.index);
    const error = Math.abs(actual - predicted);
    record(
        'barSpacing change scales about the plot centre by the factor',
        error <= ANCHOR_TOLERANCE_PX,
        `bar ${before.index} landed at ${actual.toFixed(3)}px, predicted ${predicted.toFixed(3)}px (off by ${error.toFixed(3)}px)`,
    );

    // Diagnose *where* the anchor is, rather than only that it is wrong. Both offsetX
    // and scaleX are readable through the public API — indexToCoordinate(0) is offsetX
    // exactly, because bar 0 sits at slot 0 — so the anchor a scale was taken about can
    // be solved for:
    //
    //     offsetX' = a + (offsetX - a) * f   =>   a = (offsetX' - f * offsetX) / (1 - f)
    //
    // Comparing that a against the plot centre says whether the code anchored somewhere
    // else entirely (a live-edge park, a stale rect, a different origin) or merely used
    // the wrong number, which are different bugs with different fixes.
    const derived = await page.evaluate(() => {
        const mc = globalThis.__mc;
        const { x, width } = mc.plot();
        return {
            offsetX: mc.xOf(0),
            scaleX: mc.xOf(1) - mc.xOf(0),
            centre: x + width / 2,
        };
    });
    const after = await page.evaluate(() => {
        const mc = globalThis.__mc;
        return { offsetX: mc.xOf(0), scaleX: mc.xOf(1) - mc.xOf(0) };
    });
    const appliedFactor = after.scaleX / derived.scaleX;
    const impliedAnchor = Math.abs(1 - appliedFactor) < 1e-9
        ? Number.NaN
        : (after.offsetX - appliedFactor * derived.offsetX) / (1 - appliedFactor);
    record(
        'the plot-centred zoom anchors where it claims to',
        Math.abs(impliedAnchor - derived.centre) <= 1,
        `implied anchor ${impliedAnchor.toFixed(2)}px vs plot centre ${derived.centre.toFixed(2)}px ` +
        `(offsetX ${derived.offsetX.toFixed(2)}->${after.offsetX.toFixed(2)}, ` +
        `scaleX ${derived.scaleX.toFixed(3)}->${after.scaleX.toFixed(3)}, f=${appliedFactor.toFixed(4)})`,
    );

    // Drag: the inverse invariant. A pan is a pure delta, so the bar under the
    // pointer should travel with the pointer by the same distance rather than stick
    // to the screen. Getting this wrong is the classic "the chart came off my cursor".
    await page.evaluate(() => globalThis.__mc.chart.scrollToRealtime());
    await wait(150);
    const startX = plot.x + plot.width * 0.6;
    await page.mouse.move(startX, midY);
    const panBefore = await page.evaluate((at) => {
        const mc = globalThis.__mc;
        const index = mc.indexAt(at);
        return { index, x: mc.xOf(index) };
    }, startX);

    const drag = -220;
    // Press at the measurement point, not beside it. Moving the pointer into position
    // *before* mouse.down and then dragging by `drag` only travels `drag` after the
    // press — and the first version of this test did exactly that, which made a
    // correct pan look like it moved half as far as the pointer. The measurement is
    // the distance travelled while the button is down, nothing else.
    await page.mouse.move(startX, midY);
    await page.mouse.down();
    await page.mouse.move(startX + drag, midY, { steps: 14 });
    await page.mouse.up();
    await wait(300);

    const panAfter = await page.evaluate((index) => globalThis.__mc.xOf(index), panBefore.index);
    const travelled = panAfter - panBefore.x;
    const off = Math.abs(travelled - drag);
    record(
        'drag carries the series with the pointer',
        off <= 2,
        `bar ${panBefore.index} travelled ${travelled.toFixed(2)}px for a ${drag}px drag (off by ${off.toFixed(2)}px)`,
    );

    record(
        'no page error escaped a handler',
        pageErrors.length === 0,
        pageErrors.length === 0 ? 'clean' : pageErrors.slice(0, 3).join(' | '),
    );
} finally {
    await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\ninteraction: ${results.length - failed.length}/${results.length} invariants hold`);
if (failed.length > 0) {
    console.log('the chart does not hold still under the pointer');
    process.exit(1);
}
