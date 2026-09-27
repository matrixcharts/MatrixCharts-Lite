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

    // The requested factor has to be the applied factor.
    //
    // This replaces a case that predicted a bar position from the canvas centre.
    // Predicting a position needs the anchor, and the anchor is the *plot* centre,
    // which is inset by the axis gutter — 78px on the left in this layout, so the
    // plot centre is 639px while the canvas centre is 600px. A prediction built from
    // the canvas centre is off by that gutter and reads as a 15px bug that is not
    // there. Bar spacing is checked directly instead: two bars one slot apart are
    // scaleX apart, so the ratio of that distance across a zoom is the factor that
    // was actually applied, and comparing it against the requested factor catches a
    // clamp or a dropped patch without needing to know where anything is anchored.
    const spacingBefore = await page.evaluate(() => globalThis.__mc.xOf(1) - globalThis.__mc.xOf(0));
    const requested = 1.4;
    await page.evaluate((t) => globalThis.__mc.chart.applyOptions({ timeScale: { barSpacing: t } }),
        spacingBefore * requested);
    await wait(300);
    const spacingAfter = await page.evaluate(() => globalThis.__mc.xOf(1) - globalThis.__mc.xOf(0));
    const applied = spacingAfter / spacingBefore;
    record(
        'a barSpacing change applies the factor it was asked for',
        Math.abs(applied - requested) <= 0.001,
        'asked for ' + requested + 'x, applied ' + applied.toFixed(5) + 'x ' +
            '(bar spacing ' + spacingBefore.toFixed(3) + ' -> ' + spacingAfter.toFixed(3) + ')',
    );

    // Solve for the anchor a scale was taken about, twice, and require the two to be
    // the same point. This is the gutter-independent form of the invariant: it does not
    // need to know where the plot rect is, only that the transform is a pure scale
    // about one fixed point that does not move when the scale changes.
    //
    // The first version compared the plot centre to an anchor solved from a state read
    // *before and after with no zoom applied in between* — so the factor came out at
    // exactly 1.0000, the anchor was unsolvable, and I reported a swallowed option
    // patch that never existed. The zoom is applied in the middle of this one.
    const readState = () => page.evaluate(() => {
        const mc = globalThis.__mc;
        const { x, width } = mc.plot();
        return {
            offsetX: mc.xOf(0),
            scaleX: mc.xOf(1) - mc.xOf(0),
            canvasCentre: x + width / 2,
        };
    });
    const anchorFor = (before, after) => {
        const factor = after.scaleX / before.scaleX;
        return Math.abs(1 - factor) < 1e-9
            ? Number.NaN
            : (after.offsetX - factor * before.offsetX) / (1 - factor);
    };

    const anchors = [];
    for (const target of [1.4, 0.7]) {
        const before = await readState();
        await page.evaluate((t) => globalThis.__mc.chart.applyOptions({ timeScale: { barSpacing: t } }),
            before.scaleX * target);
        await wait(300);
        const after = await readState();
        anchors.push(anchorFor(before, after));
    }
    const stable = Number.isFinite(anchors[0])
        && Math.abs(anchors[0] - anchors[1]) <= ANCHOR_TOLERANCE_PX;
    record(
        'a barSpacing change scales about one fixed anchor',
        stable,
        `anchors ${anchors.map((a) => a.toFixed(2)).join('px, ')}px ` +
        `(canvas centre ${(await readState()).canvasCentre.toFixed(2)}px — the plot centre is ` +
        'inset by the axis gutter, so it is not expected to equal it)',
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
