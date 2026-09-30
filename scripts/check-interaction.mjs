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
// verdict. It runs as part of `npm run verify`, so a failing gesture breaks the build.
//
// When no browser can be found it skips with a zero exit — but only when `CI` is unset.
// Under `CI` (or with `MC_REQUIRE_BROWSER=1`) a missing browser is a hard failure
// instead, because a pipeline that reports green having run none of these is worse than
// one that never claimed to check: it looks like coverage and is not.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require_ = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const URL = process.argv[2] ?? 'http://localhost:5173/tests/browser/interaction.e2e.html';
// The pane cases need a second pane to exist, and a one-pane chart cannot show whether
// a gutter belongs to the price pane or to the chart, so they get their own page.
// Derived from the URL under test so a caller pointing at another host keeps working.
const PANES_URL = URL.replace(/[^/]*\.e2e\.html$/, 'panes.e2e.html');

/**
 * Cheap digest of every 2D canvas on the page, from its own `toDataURL`.
 *
 * This is the only trustworthy way to ask "did the renderer actually repaint" in this
 * environment. `page.screenshot` returns an all-white frame for this chart under
 * swiftshader, and an element screenshot of the WebGL layer reads back a stale buffer
 * because it has no `preserveDrawingBuffer`. Both report two different states as
 * byte-identical. A 2D canvas read back through its own context is faithful.
 */
const readUiLayer = (target) => target.evaluate(() => {
    const parts = [];
    for (const canvas of document.querySelectorAll('canvas')) {
        try {
            const context = canvas.getContext('2d');
            if (context) parts.push(canvas.toDataURL());
        } catch {
            // A canvas that refuses a readback contributes nothing; the ones that
            // answer are what the assertion is about.
        }
    }
    // Length plus a sample of the payload: enough to tell "repainted" from "identical"
    // without carrying a megabyte of data URL around.
    const joined = parts.join('|');
    let hash = 0;
    for (let i = 0; i < joined.length; i++) {
        hash = (Math.imul(hash, 31) + joined.charCodeAt(i)) | 0;
    }
    return `${parts.length} layers, ${joined.length} chars, hash ${hash}`;
});

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
].filter((p) => typeof p === 'string' && p.length > 0 && existsSync(p));

const CORE_CANDIDATES = [
    'puppeteer-core',
    'puppeteer-core/node_modules/puppeteer-core',
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
const missing = [];
if (core === null) missing.push('puppeteer-core');
if (CHROME_CANDIDATES.length === 0) missing.push('a Chrome binary');

if (core === null || CHROME_CANDIDATES.length === 0) {
    // A skip is only honest where skipping is allowed. On a build server it is the
    // opposite: the pipeline reports green having executed none of these invariants, and
    // the first thing anyone hears about a broken drag is a user. Both serious defects in
    // this phase were found by measurement rather than by a failing test, and this
    // harness is the only coverage of real pointer plumbing — so "it skipped" and "it
    // passed" must not look the same in a build log.
    //
    // `CI` is the conventional marker and is set by essentially every provider, so this
    // needs no configuration to take effect. A developer with no browser keeps the
    // graceful skip, because their `npm test` should not require a Chrome download.
    //
    // `MC_REQUIRE_BROWSER=1` forces the hard failure anywhere, for a local run that
    // wants to prove the harness is real rather than skipped.
    const required = process.env.CI !== undefined && process.env.CI !== ''
        || process.env.MC_REQUIRE_BROWSER === '1';
    if (required) {
        console.error(`interaction: FAILED — no ${missing.join(' and no ')}.`);
        console.error('  These invariants are the build gate; a skipped run is not a pass.');
        console.error('  Install Chrome, set CHROME_PATH, or make puppeteer-core resolvable.');
        if (process.env.CI === undefined || process.env.CI === '') {
            console.error('  (unset CI to allow a local skip, or set MC_REQUIRE_BROWSER=1 to force this)');
        }
        process.exit(1);
    }
    console.log(`interaction: skipped — no ${missing.join(' and no ')}.`);
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

    // **Refuse to run against another repository's engine.** Both `@matrixcharts/lite` and
    // `@matrixcharts/advanced` ship a `tests/browser/interaction.e2e.html`, and the default
    // URL is a bare `localhost:5173` — so whichever dev server happens to be listening wins,
    // and every invariant below reports on *that* engine while this file's name and this
    // repo's history say otherwise.
    //
    // It is not hypothetical. Running this from the lite checkout while the advanced
    // checkout's `vite` was on 5173 produced a clean-looking 30/32 in which **every result
    // was about the advanced engine** — including a "log axis" failure lite's own engine does
    // not have, which vanished the moment the URL pointed at a lite server (32/33, log span
    // exactly 1.50000x). The tell was in the output the whole time: lite's engine resolves
    // the mode to `'log'` and the failure printed `"logarithmic"`, a spelling that has never
    // existed in lite's source.
    //
    // A check that can silently measure a different codebase is worse than no check, because
    // its result looks like evidence. So the page declares which repository it is, and this
    // asserts it before a single invariant is recorded. `MC_EXPECT_REPO` overrides, for
    // anyone deliberately cross-running.
    const EXPECT_REPO = process.env.MC_EXPECT_REPO
        ?? (existsSync(resolve(root, 'src/core/AdvancedChart.ts')) ? 'advanced' : 'lite');
    const servedRepo = await page.evaluate(() => globalThis.__mc?.repo ?? null);
    if (servedRepo !== EXPECT_REPO) {
        // `null` means the page carries no marker at all, which in practice means it is the
        // *other* repository's copy from before this check existed. Said explicitly, because
        // "repo=null" reads like a bug in the page rather than like a wrong server.
        const why = servedRepo === null
            ? 'that page declares no repository, so it predates this check — which in practice\n'
              + 'means it is the other package\'s copy'
            : `that page declares repo='${servedRepo}'`;
        console.error(
            `interaction: refusing to run. This script is in the ${EXPECT_REPO} checkout, but\n`
            + `  ${URL}\n`
            + `was served by a page this check does not recognise: ${why}.\n`
            + '\n'
            + 'Both packages ship this page at the same path, so a dev server left running\n'
            + 'from the other repository answers this URL, and every invariant below would\n'
            + 'report on the wrong engine — passing or failing for reasons that have nothing\n'
            + 'to do with this checkout.\n'
            + '\n'
            + 'Start this repository\'s own server and pass its URL:\n'
            + `  npx vite --port 5199 --strictPort        # in the ${EXPECT_REPO} checkout\n`
            + '  npm run check:interaction -- http://localhost:5199/tests/browser/interaction.e2e.html',
        );
        await browser.close();
        process.exit(1);
    }

    await wait(500);

    // The reported price range has to be the range the pane is actually showing.
    //
    // This is the vertical half of the bar-spacing check below, and it was wrong by
    // three orders of magnitude. `getPriceRange` read `fromScaleSpace(offsetY)`, which
    // treats `offsetY` as a scale-space value, but `offsetY` is the pixel at which
    // scale-space zero sits, so a pane showing 106.6 to 111.6 reported -56732 to 13568,
    // and a range set with `setPriceRange([100, 200])` read back as -2184 to 1156. Every
    // other vertical reader goes through `paneValueAt` — the axis renderer and
    // `getPaneValueRange` both did, which is what makes this one an outlier rather than
    // a convention.
    //
    // Asserted against `coordinateToPrice` at the two pane edges rather than a
    // hand-written number, so the claim is the one that matters and cannot rot when
    // the auto-fit padding changes.
    const priceRead = await page.evaluate(() => {
        const mc = globalThis.__mc;
        const timeAxisHeight = mc.chart.options().layout.timeAxisHeight;
        const top = mc.plot().y;
        const bottom = top + mc.plot().height - timeAxisHeight;
        const reported = mc.chart.getPriceRange();
        const atTop = mc.chart.coordinateToPrice(top);
        const atBottom = mc.chart.coordinateToPrice(bottom);
        return {
            reportedLow: Math.min(reported[0], reported[1]),
            reportedHigh: Math.max(reported[0], reported[1]),
            drawnLow: Math.min(atTop, atBottom),
            drawnHigh: Math.max(atTop, atBottom),
        };
    });
    const priceReadOff = Math.max(
        Math.abs(priceRead.reportedLow - priceRead.drawnLow),
        Math.abs(priceRead.reportedHigh - priceRead.drawnHigh),
    );
    record(
        'the reported price range is the one on screen',
        priceReadOff <= 1e-6,
        `options say [${priceRead.reportedLow.toFixed(4)}, ${priceRead.reportedHigh.toFixed(4)}], ` +
        `the pane shows [${priceRead.drawnLow.toFixed(4)}, ${priceRead.drawnHigh.toFixed(4)}] ` +
        `(off by ${priceReadOff.toExponential(2)})`,
    );

    // The reported bar spacing has to be the one on screen, and it has to be so from
    // the first frame, not only after a zoom.
    //
    // This is the invariant a zoom readout is built on. A toolbar button has to be
    // able to read the current spacing, scale it, and apply the result, and that is
    // only correct if the number it read was the number being drawn. It was not, on
    // load: `setData` resets the chart to the default spacing by assigning `scaleX`
    // directly, which left the options reporting the construction-time value — a
    // chart built at 12px reported 12 and drew 14, so the very first press of a
    // zoom-in button was 17% out, before any zoom had happened to correct it. The
    // zoom path had already been fixed; the data-load path had not.
    const onLoad = await page.evaluate(() => {
        const mc = globalThis.__mc;
        return {
            reported: mc.chart.options().timeScale.barSpacing,
            drawn: mc.xOf(1) - mc.xOf(0),
        };
    });
    record(
        'the reported bar spacing is the one on screen, before any zoom',
        Math.abs(onLoad.reported - onLoad.drawn) <= 0.001,
        `options() says ${onLoad.reported.toFixed(3)}px, the bars are ${onLoad.drawn.toFixed(3)}px apart`,
    );

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

    // The same button, pressed again. A toolbar is not one call, it is five, and each
    // one reads the current spacing, scales it and applies the result — so the value
    // read has to be the value drawn, or the error compounds press by press.
    //
    // The case above cannot see this: it starts from a known spacing and asks for a
    // multiple of it, so it passes whether or not the reported value is usable as a
    // base. Here the base *is* the reported value, which is what a real button uses,
    // and every press has to land on what it asked for.
    await page.evaluate(() => globalThis.__mc.chart.applyOptions({ timeScale: { barSpacing: 12 } }));
    await wait(250);
    const pressTargets = [];
    for (let press = 0; press < 5; press++) {
        // Read the base the way a caller has to: from the public options.
        const base = await page.evaluate(() => globalThis.__mc.chart.options().timeScale.barSpacing);
        const want = base * 1.25;
        await page.evaluate((t) => globalThis.__mc.chart.applyOptions({ timeScale: { barSpacing: t } }), want);
        await wait(180);
        const now = await page.evaluate(() => {
            const mc = globalThis.__mc;
            return {
                reported: mc.chart.options().timeScale.barSpacing,
                drawn: mc.xOf(1) - mc.xOf(0),
            };
        });
        pressTargets.push({
            press: press + 1,
            want,
            reported: now.reported,
            drawn: now.drawn,
        });
    }
    const pressWorst = Math.max(...pressTargets.flatMap((p) => [
        Math.abs(p.reported - p.want),
        Math.abs(p.drawn - p.want),
    ]));
    record(
        'five successive zoom-in presses each apply, compounding from the reported value',
        pressWorst <= 0.01,
        pressTargets
            .map((p) => `${p.press}:${p.drawn.toFixed(2)}`)
            .join('px ') + 'px  (asked ' + pressTargets.map((p) => p.want.toFixed(2)).join('px ') +
            `px, worst miss ${pressWorst.toFixed(4)}px)`,
    );

    // Put the chart back on the plot-centre branch before the anchor check.
    //
    // The presses above re-latch the chart to the live edge, and a live-edge zoom
    // parks the newest bar rather than scaling about the plot centre — so without
    // this the anchor case below would still pass, while quietly measuring the other
    // branch of `applyBarSpacing` and no longer covering the plot-centre anchoring at
    // all. The anchor came back as the plot's right edge instead of its centre, which
    // is how this was noticed. A test that passes for the wrong reason is worse than
    // one that fails, so the branch is asserted rather than assumed.
    //
    // The spacing is put back to 12 first so this is the same starting state the
    // anchor case was written against, and the drag is then sized off the live bar
    // spacing rather than fixed. It cannot be fixed: the live-edge test is
    // `max(24, scaleX * 1.5)`, so at the 36.6px the five presses leave behind the
    // tolerance is 55px and a 40px drag does not clear it. The chart then never
    // detaches, `isAtRealtime()` stays true, and the case measures the wrong branch
    // while still reporting a plausible anchor.
    await page.evaluate(() => globalThis.__mc.chart.applyOptions({ timeScale: { barSpacing: 12 } }));
    await wait(250);
    await page.evaluate(() => globalThis.__mc.chart.scrollToRealtime());
    await wait(150);
    const detachDrag = await page.evaluate(() => {
        const mc = globalThis.__mc;
        // Comfortably past max(24, scaleX * 1.5), which is what a pan has to beat.
        return -(Math.max(24, (mc.xOf(1) - mc.xOf(0)) * 1.5) + 40);
    });
    await page.mouse.move(plot.x + plot.width * 0.5, midY);
    await page.mouse.down();
    await page.mouse.move(plot.x + plot.width * 0.5 + detachDrag, midY, { steps: 8 });
    await page.mouse.up();
    await wait(200);
    // `isAtRealtime()` reports the *latch*, so a chart that has successfully detached
    // answers false. The name here is the latch, not the outcome, because the guard
    // below reads as "must not still be latched" — the first version of this called it
    // `detached`, tested it inverted, and failed every run while the anchors it was
    // guarding were correct to two decimal places.
    const stillLatched = await page.evaluate(() => globalThis.__mc.chart.isAtRealtime());

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
    const stable = stillLatched
        ? false
        : Number.isFinite(anchors[0])
            && Math.abs(anchors[0] - anchors[1]) <= ANCHOR_TOLERANCE_PX;
    record(
        'a barSpacing change scales about one fixed anchor',
        stable,
        (stillLatched
            ? 'NOT MEASURABLE — still latched to the live edge, so this solved the other branch ' +
                'of applyBarSpacing; '
            : '') +
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

    // --- Vertical: dragging the price axis -------------------------------------
    //
    // The gesture is a drag of the left gutter, and its whole job is to take the
    // vertical scale away from the auto-scaler and hold a span the caller chose. It is
    // deliberately *not* the pinch path: a pinch is a scaleY multiplier about a focal
    // point on the plot, whereas this alters explicit [low, high] bounds and hands them
    // to the lock, so the two would be fighting over the same value.
    //
    // Every assertion below is stated in *scale space*, which is the space the drag
    // works in. That is what makes one set of cases cover both a linear and a log
    // axis: on linear the scale-space span is a difference of prices, on log it is a
    // difference of logs, and "the span grew by half, and the middle did not move" is
    // the same statement either way. Asserting it in prices would have made the log
    // case look like a different feature.
    const axisGeom = await page.evaluate(() => {
        const options = globalThis.__mc.chart.options();
        return {
            priceAxisWidth: options.layout.priceAxisWidth,
            timeAxisHeight: options.layout.timeAxisHeight,
            plotHeight: globalThis.__mc.plot().height,
        };
    });
    const axisPaneHeight = axisGeom.plotHeight - axisGeom.timeAxisHeight;
    // The middle of the reserved gutter, not the middle of the canvas: a press at the
    // canvas centre is in the plot, and would pan instead.
    const axisX = Math.round(axisGeom.priceAxisWidth / 2);
    const axisStartY = Math.round(axisGeom.plotHeight / 2);

    // Range in scale space, plus the horizontal state, in one read so every number
    // below comes from the same instant.
    const readVertical = () => page.evaluate(() => {
        const mc = globalThis.__mc;
        const [low, high] = mc.chart.getPriceRange();
        return {
            low,
            high,
            mode: mc.chart.options().priceScale.mode,
            autoScale: mc.chart.options().priceScale.autoScale,
            barSpacing: mc.chart.options().timeScale.barSpacing,
            offsetX: mc.xOf(0),
            atRealtime: mc.chart.isAtRealtime(),
        };
    });
    // Scale space depends on the mode: on a linear axis it *is* the price, on log it
    // is the log. That is the whole reason the drag does its arithmetic there, and it
    // has to be honoured here too.
    //
    // The first version of this took a difference of logs unconditionally, which is
    // only the scale space on a log axis. It read the linear drag as 1.585x — that is
    // log(225)-log(75) over log(200)-log(100) — while leaving the log case exactly
    // right, so the one axis it was wrong about was the one it was not checking. The
    // drag was correct throughout; 100 -> 150 on a 100 span is 1.5x, and the middle
    // did not move at all.
    const toScale = (price, mode) => (mode === 'log' ? Math.log(price) : price);
    const spanOf = (v) => toScale(v.high, v.mode) - toScale(v.low, v.mode);
    const centreOf = (v) => (toScale(v.low, v.mode) + toScale(v.high, v.mode)) / 2;

    // 1. A press on the axis that never travels is a click, not a drag.
    //
    // Without the slop gate a one-pixel twitch while clicking rescaled the pane by
    // 0.17% *and* locked it, so brushing the axis silently took the vertical scale
    // away from the caller. The gate is the same CLICK_SLOP_PX the pan uses to tell a
    // click from a drag, for the same reason.
    const clickBefore = await readVertical();
    await page.mouse.move(axisX, axisStartY);
    await page.mouse.down();
    await page.mouse.move(axisX + 1, axisStartY + 1);
    await page.mouse.up();
    await wait(200);
    const clickAfter = await readVertical();
    record(
        'a click on the price axis leaves the vertical scale alone',
        Math.abs(spanOf(clickAfter) - spanOf(clickBefore)) <= 1e-9 && clickAfter.autoScale === clickBefore.autoScale,
        `1px press moved the span by ${Math.abs(spanOf(clickAfter) - spanOf(clickBefore)).toExponential(2)}, ` +
        `autoScale stayed ${clickAfter.autoScale}`,
    );

    // 2. A real drag scales the span by the distance travelled, about the middle.
    //
    // The range is locked first, and that is not incidental. The chart is autoscaling
    // against a feed that is still appending, so between the chart's own pointerdown
    // handler — which captures the drag's baseline — and any read taken afterwards, an
    // append can re-fit the range under the measurement. Reading the baseline after
    // mouse.down is not enough: the append lands *between* the handler and the read.
    // It showed up as 1.50030x with the middle 3e-4 out, which is the feed arriving and
    // not the gesture being wrong.
    //
    // So the quantitative claim is measured against a locked range, where nothing can
    // move it, and the claim that the drag takes the scale off autoScale is made by
    // the next case on a live autoscaling chart. Splitting them is also why this is
    // two cases rather than one: each asserts one thing, and neither is at the mercy of
    // the other's timing.
    await page.evaluate(() => globalThis.__mc.chart.setPriceRange([100, 200]));
    await wait(200);
    const wantedFactor = 1.5;
    const travel = Math.round(axisPaneHeight * (wantedFactor - 1));
    const vBefore = await readVertical();
    await page.mouse.move(axisX, axisStartY);
    await page.mouse.down();
    await page.mouse.move(axisX, axisStartY + travel, { steps: 10 });
    await page.mouse.up();
    await wait(250);
    const vAfter = await readVertical();
    const gotFactor = spanOf(vAfter) / spanOf(vBefore);
    const centreHeld = Math.abs(centreOf(vAfter) - centreOf(vBefore));
    record(
        'a price-axis drag scales the span by the distance it travelled',
        Math.abs(gotFactor - wantedFactor) <= 0.002 && centreHeld <= 1e-6,
        `${travel}px of a ${axisPaneHeight}px pane asked for ${wantedFactor}x, applied ` +
        `${gotFactor.toFixed(5)}x, middle held to ${centreHeld.toExponential(2)}`,
    );

    // 3. The vertical gesture must not touch the horizontal one.
    //
    // This is the decoupling stated as an invariant rather than left to inspection: a
    // press on the axis that also slid the series, or that disturbed the live-edge
    // latch, would be two gestures in one and the caller would have no way to ask for
    // only one of them.
    record(
        'a price-axis drag leaves the horizontal axis and the live-edge latch alone',
        Math.abs(vAfter.barSpacing - vBefore.barSpacing) <= 1e-9
            && Math.abs(vAfter.offsetX - vBefore.offsetX) <= 1e-9
            && vAfter.atRealtime === vBefore.atRealtime,
        `bar spacing ${vBefore.barSpacing.toFixed(3)} -> ${vAfter.barSpacing.toFixed(3)}, ` +
        `offsetX ${vBefore.offsetX.toFixed(2)} -> ${vAfter.offsetX.toFixed(2)}, ` +
        `live-edge ${vBefore.atRealtime} -> ${vAfter.atRealtime}`,
    );

    // 4. On a live autoscaling chart, the drag takes the scale off autoScale, the lock
    //    survives the feed, and fitPriceRange hands it back. The middle of that is the
    //    point of routing the drag through the lock: a range the next append quietly
    //    re-fits is not a range anybody chose.
    //
    //    It starts by handing the scale back, because the case above locked it. That is
    //    the only reason this reads `fitPriceRange` twice — once to get a live chart to
    //    drag on, once to prove the drag is reversible.
    //
    //    The fitted span is compared against the *dragged* span, not the autoscaled one
    //    the drag started from. The fit is deterministic, so restoring it necessarily
    //    lands back near where the fit already was; the first version of this asserted
    //    the two differed and failed on exactly that, having read "the fit came back" as
    //    "the fit is somewhere else".
    await page.evaluate(() => globalThis.__mc.chart.fitPriceRange());
    await wait(250);
    const vAuto = await readVertical();
    await page.mouse.move(axisX, axisStartY);
    await page.mouse.down();
    await page.mouse.move(axisX, axisStartY + travel, { steps: 10 });
    await page.mouse.up();
    await wait(250);
    const vLocked = await readVertical();
    await wait(600);
    const vFed = await readVertical();
    await page.evaluate(() => globalThis.__mc.chart.fitPriceRange());
    await wait(300);
    const vFitted = await readVertical();
    record(
        'the drag takes the scale off autoScale, the lock survives the feed, fit restores it',
        vAuto.autoScale === true
            && vLocked.autoScale === false
            && vFed.autoScale === false
            && Math.abs(spanOf(vFed) - spanOf(vLocked)) <= 1e-9
            && vFitted.autoScale === true
            && Math.abs(spanOf(vFitted) - spanOf(vLocked)) > 1e-6,
        `autoScale ${vAuto.autoScale} -> ${vLocked.autoScale}, span held across the feed to ` +
        `${Math.abs(spanOf(vFed) - spanOf(vLocked)).toExponential(2)}, fitPriceRange restored ` +
        `autoScale=${vFitted.autoScale} and undid the drag (span ${spanOf(vFitted).toFixed(4)} ` +
        `vs the dragged ${spanOf(vLocked).toFixed(4)})`,
    );

    // 5. The same gesture on a log axis.
    //
    // Switched here rather than at the top so the horizontal cases above run against
    // the default linear pane, and locked for the same reason as case 2. The assertion
    // is unchanged: the *scale-space* span grows by the same factor and the middle
    // holds. On log that means the ratio high/low grows, not the difference — a log
    // pane's headroom is a ratio of log, which is the same reason `autoScaleY` applies
    // its padding in scale space. Asserting it in prices would make this look like a
    // different feature rather than the same one on another axis.
    await page.evaluate(() => {
        globalThis.__mc.chart.applyOptions({ priceScale: { mode: 'log' } });
        globalThis.__mc.chart.setPriceRange([50, 200]);
    });
    await wait(300);
    const logBefore = await readVertical();
    // **The mode both reads are interpreted in, asserted rather than assumed.** `spanOf` and
    // `centreOf` take each value's *own* `mode`, so if the before-read and the after-read
    // disagree about the mode, the ratio is a quotient of two different quantities and no
    // tolerance can make it meaningful.
    //
    // That is not hypothetical: this invariant was failing at 1.64992x where 1.5x was asked
    // for, and 1.649916 is exactly the *price-difference* ratio of a correctly applied 1.5x
    // log-span scale — the signature of `toScale` being a no-op on the before-read. The
    // engine's drag arithmetic is right; the measurement was mixing spaces, and it presented
    // as a numeric drift rather than as a broken test, which is the worst way for a test to
    // be wrong.
    //
    // So the mode is pinned first, and both reads are then forced into the same space. A
    // failure here says "the mode did not take", which is actionable; a failure downstream
    // says "1.64992x", which is not.
    const logMode = logBefore.mode;
    record(
        'a log price scale reports itself as log when the drag case reads it',
        logMode === 'log',
        `mode before the log drag: ${JSON.stringify(logMode)}`,
    );
    const inLogSpace = (v) => ({ ...v, mode: logMode });
    await page.mouse.move(axisX, axisStartY);
    await page.mouse.down();
    await page.mouse.move(axisX, axisStartY + travel, { steps: 10 });
    await page.mouse.up();
    await wait(250);
    const logAfter = await readVertical();
    const logFactor = spanOf(inLogSpace(logAfter)) / spanOf(inLogSpace(logBefore));
    const logCentreHeld = Math.abs(centreOf(inLogSpace(logAfter)) - centreOf(inLogSpace(logBefore)));
    const ratioBefore = logBefore.high / logBefore.low;
    const ratioAfter = logAfter.high / logAfter.low;
    record(
        'the same drag on a log axis scales the log span, not the price difference',
        Math.abs(logFactor - wantedFactor) <= 0.002
            && logCentreHeld <= 1e-6
            && logAfter.high > logAfter.low,
        `asked ${wantedFactor}x, applied ${logFactor.toFixed(5)}x on the log span; ` +
        `high/low ${ratioBefore.toFixed(5)} -> ${ratioAfter.toFixed(5)}, ` +
        `geometric middle held to ${logCentreHeld.toExponential(2)}`,
    );
    await page.evaluate(() => globalThis.__mc.chart.applyOptions({ priceScale: { mode: 'linear' } }));
    await wait(200);

    // 6. A drag inside the plot is still a pan and must not scale vertically.
    const panGuard = await readVertical();
    const insideX = axisGeom.priceAxisWidth + 60;
    await page.mouse.move(insideX, axisStartY);
    await page.mouse.down();
    await page.mouse.move(insideX - 120, axisStartY, { steps: 10 });
    await page.mouse.up();
    await wait(250);
    const panGuardAfter = await readVertical();
    record(
        'a drag inside the plot still pans and does not scale vertically',
        Math.abs(panGuardAfter.offsetX - (panGuard.offsetX - 120)) <= 2
            && Math.abs(spanOf(panGuardAfter) - spanOf(panGuard)) <= 1e-9,
        `offsetX ${panGuard.offsetX.toFixed(2)} -> ${panGuardAfter.offsetX.toFixed(2)} ` +
        `(wanted ${(panGuard.offsetX - 120).toFixed(2)}), scale-space span moved by ` +
        `${Math.abs(spanOf(panGuardAfter) - spanOf(panGuard)).toExponential(2)}`,
    );

    // 7. The lock has to reach the renderer, not just the model.
    //
    // `setPriceRange` set `scaleY`/`offsetY` and called `redraw()`, and the renderers
    // take `scaleY` from the 'viewport' payload and from nowhere else — so a redraw
    // re-rendered the transform they were last handed. The pane table went stale, the
    // axis labels stayed on the old range, and the chart caught up only on the next
    // unrelated pan. `getPriceRange()` reported the new range throughout, so the model
    // and the screen disagreed: the same rot as the `getPriceRange` bug above, one
    // layer out.
    //
    // Asserted two ways, because they fail differently. The pane table is the cheap
    // deterministic half. The 2D layer's own pixels are the half that proves a repaint
    // actually happened, read back with `toDataURL` over every 2D canvas.
    //
    // Not asserted with a screenshot. `page.screenshot` returns an all-white frame for
    // this chart under swiftshader — verified by looking at the image, not by reading
    // its hash — and an element screenshot of the WebGL layer is worse still, since it
    // has no `preserveDrawingBuffer` and reads back a stale buffer. Both were tried and
    // both report two different states as byte-identical, which is the worst kind of
    // test: one that looks like evidence and is not. A hash that never changes is not a
    // weak assertion, it is a vacuous one.
    await page.evaluate(() => globalThis.__mc.chart.fitPriceRange());
    await wait(300);
    const repaintBefore = await readUiLayer(page);
    await page.evaluate(() => globalThis.__mc.chart.setPriceRange([100, 200]));
    await wait(300);
    const repaintAfter = await readUiLayer(page);
    const lockReach = await page.evaluate(() => {
        const c = globalThis.__mc.chart;
        const price = c.getPriceRange();
        const pane = c.getPaneValueRange(0);
        return { priceSpan: price[1] - price[0], paneSpan: pane[1] - pane[0] };
    });
    record(
        'locking the price range repaints the pane, it does not only move the model',
        Math.abs(lockReach.priceSpan - lockReach.paneSpan) <= 1e-9 && repaintBefore !== repaintAfter,
        `pane table span ${lockReach.paneSpan.toFixed(4)} vs model ${lockReach.priceSpan.toFixed(4)}; ` +
        `the 2D layer ${repaintBefore === repaintAfter ? 'DID NOT REPAINT' : 'repainted'} ` +
        `(${repaintBefore} -> ${repaintAfter})`,
    );
    await page.evaluate(() => globalThis.__mc.chart.fitPriceRange());
    await wait(200);

    // --- Panes: the gutter routes a vertical drag to the pane under the pointer ----
    //
    // Needs a second pane to mean anything. On a one-pane chart the gutter and the
    // price pane's rows are the same rectangle, so none of this is distinguishable
    // there — which is why it gets its own page rather than a flag on the one above.
    // The headless suite covers the same rule in finer detail, down to every pixel of
    // the divider; this is here because the routing has to be right against a real
    // pointer and a real layout, not only against synthetic events.
    const panePage = await browser.newPage();
    const paneErrors = [];
    panePage.on('pageerror', (e) => paneErrors.push(e.message));
    await panePage.setViewport({ width: 1280, height: 700, deviceScaleFactor: 1 });
    await panePage.goto(PANES_URL, { waitUntil: 'networkidle2' });
    await panePage.waitForFunction(() => globalThis.__mcReady === true, { timeout: 20000 });
    await wait(600);

    // Pane geometry read from the chart rather than recomputed here, so the assertions
    // are against the same numbers the renderer used.
    const paneGeom = await panePage.evaluate(() => {
        const mc = globalThis.__mc;
        const options = mc.chart.options();
        const timeAxisHeight = options.layout.timeAxisHeight;
        const plotHeight = mc.plot().height;
        const separatorHeight = options.panes.separatorHeight;
        // paneRects: the first pane takes round(w0 / total * available), the rest follow.
        const available = plotHeight - timeAxisHeight - separatorHeight * (mc.panes().count - 1);
        const priceHeight = Math.round((options.panes.weights[0] /
            options.panes.weights.reduce((a, b) => a + b, 0)) * available);
        return {
            priceAxisWidth: options.layout.priceAxisWidth,
            priceBottom: priceHeight,
            separatorTop: priceHeight,
            lowerTop: priceHeight + separatorHeight,
            plotBottom: plotHeight - timeAxisHeight,
            paneCount: mc.panes().count,
        };
    });
    const paneAxisX = Math.round(paneGeom.priceAxisWidth / 2);

    // Both ranges are locked, so the live feed cannot move either and disguise a leak.
    const paneRead = () => panePage.evaluate(() => {
        const mc = globalThis.__mc;
        const price = mc.chart.getPriceRange();
        return {
            priceSpan: price[1] - price[0],
            lowerSpan: mc.panes().ranges[1][1] - mc.panes().ranges[1][0],
            offsetX: mc.xOf(0),
        };
    });
    const dragInPaneGutter = async (y) => {
        await panePage.evaluate(() => {
            globalThis.__mc.chart.setPriceRange([100, 200]);
            globalThis.__mc.chart.setPaneRange(1, [20, 80]);
        });
        await wait(200);
        const before = await paneRead();
        await panePage.mouse.move(paneAxisX, y);
        await panePage.mouse.down();
        await panePage.mouse.move(paneAxisX, y + 160, { steps: 10 });
        await panePage.mouse.up();
        await wait(250);
        return { before, after: await paneRead() };
    };

    const inPrice = await dragInPaneGutter(Math.round(paneGeom.priceBottom / 2));
    const onSeparator = await dragInPaneGutter(paneGeom.separatorTop);
    const inLower = await dragInPaneGutter(
        Math.round((paneGeom.lowerTop + paneGeom.plotBottom) / 2));
    const onLastRow = await dragInPaneGutter(paneGeom.priceBottom - 3);

    const moved = (d, key) => Math.abs(d.after[key] - d.before[key]) > 1e-9;
    const held = (d, key) => !moved(d, key);
    record(
        'a drag in the price pane gutter scales the price pane',
        moved(inPrice, 'priceSpan') && held(inPrice, 'lowerSpan') && held(inPrice, 'offsetX'),
        `price span ${inPrice.before.priceSpan.toFixed(2)} -> ${inPrice.after.priceSpan.toFixed(2)}, ` +
        `offsetX held at ${inPrice.after.offsetX.toFixed(2)}, lower pane untouched`,
    );
    // The routing rule: the row under the pointer decides which pane owns the drag, so a
    // drag beside the oscillator scales the oscillator — and provably not the price chart.
    // The lower pane's whole reason to exist is that one historical spike would otherwise
    // flatten recent bars with no way back.
    record(
        'a drag in a lower pane gutter scales that pane and not the price pane',
        moved(inLower, 'lowerSpan') && held(inLower, 'priceSpan') && held(inLower, 'offsetX'),
        `lower span ${inLower.before.lowerSpan.toFixed(2)} -> ${inLower.after.lowerSpan.toFixed(2)}, ` +
        `price span held at ${inLower.after.priceSpan.toFixed(2)}, offsetX held`,
    );
    // The divider belongs to no pane, so a drag starting there does nothing at all. This
    // is the boundary the routing rule has to get exactly right, and it is invisible in a
    // screenshot because a pixel-wide band that does nothing looks identical to one that
    // is not there.
    record(
        'a drag on the divider between two panes is inert',
        held(onSeparator, 'priceSpan') && held(onSeparator, 'lowerSpan') && held(onSeparator, 'offsetX'),
        `separator at y=${paneGeom.separatorTop}: price, lower pane and offsetX all unchanged`,
    );
    // Both edges of the boundary, because an off-by-one here is a whole row stolen from
    // one pane and given to the other.
    record(
        'the rows either side of the divider belong to the right pane',
        moved(onLastRow, 'priceSpan') && held(onLastRow, 'lowerSpan'),
        `y=${paneGeom.priceBottom - 3} scaled the price span to ` +
        `${onLastRow.after.priceSpan.toFixed(2)} and left the lower pane alone`,
    );
    record(
        'no page error escaped a pane handler',
        paneErrors.length === 0,
        paneErrors.length === 0 ? 'clean' : paneErrors.slice(0, 3).join(' | '),
    );
    await panePage.close();

    record(
        'no page error escaped a handler',
        pageErrors.length === 0,
        pageErrors.length === 0 ? 'clean' : pageErrors.slice(0, 3).join(' | '),
    );

    // --- the time axis, measured rather than asserted ---------------------------------
    //
    // Everything about these two is a question about the width of text, and the headless
    // stub reports a `measureText` width of zero. So neither could be caught there: the
    // reported symptom was a row of clipped half-dates (`Sep 1, 01:30 PM  Sep 1 Sep 1`),
    // which is not a wrong value anywhere, it is fourteen correct values too wide for the
    // space between them.

    // The feed is stopped for these two. Not tidiness: the source redraws on a timer, so
    // a recorder read across a frame boundary holds two views' worth of labels, and
    // sorting them by x pairs a label from the right of one view with one from the left of
    // the other. That first showed as a 1200px "overlap", and then — once the scan was
    // fixed — as two identical labels 32px apart, which is the same artefact wearing a
    // more convincing disguise. The chart does not need a live feed to have a time axis.
    await page.evaluate(() => globalThis.__mc.source.stop());
    await wait(150);

    // Reset the recorder and force a redraw **in the same evaluate**, so the measurement
    // cannot race the render. `scrollToRealtime` is used only to guarantee a frame; the
    // labels are filtered by position so the price gutter's own labels cannot be mistaken
    // for axis ones.
    const axisText = await page.evaluate(async () => {
        const { chart, drawn, labelWidth, timeAxisHeight, plot } = globalThis.__mc;
        drawn.labels.length = 0;
        drawn.lines.length = 0;
        chart.scrollToRealtime();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const r = plot();
        const stripTop = r.y + r.height - timeAxisHeight();
        return {
            stripTop,
            labels: drawn.labels
                .filter((entry) => entry.y > stripTop)
                .map((entry) => ({
                    text: entry.text,
                    half: labelWidth(entry.text) / 2,
                    x: entry.x - r.x,
                })),
        };
    });

    record(
        'the time axis has labels to measure',
        axisText.labels.length >= 2,
        `${axisText.labels.length} labels in the ${(await page.evaluate(() => globalThis.__mc.plot().height))}px canvas`,
    );
    // The invariant itself: no two labels overlap, so nothing is clipped or overprinted.
    // The old code could not satisfy this at any width, because every label carried the
    // date and the step is chosen from the pixel budget alone.
    // Deduped by text, and this is the load-bearing step rather than a convenience.
    // The 2D layer renders in several passes per frame and the axis labels go down more
    // than once, so a recorder holds each label repeatedly — the same price tag twice at
    // identical coordinates was the first thing that showed it. Left in, those repeats
    // sorted by x become "two identical labels 32px apart" and read as a collision that
    // is not there. Deduping by text is safe because a single axis cannot draw the same
    // text twice: the full form of a label names an instant-group, so two labels with the
    // same text are the same label, drawn again. With the repeats gone, any overlap left
    // is between two *different* labels, which is the actual defect.
    const byText = new Map();
    for (const label of axisText.labels) {
        if (!byText.has(label.text)) byText.set(label.text, label);
    }
    const sorted = [...byText.values()].sort((a, b) => a.x - b.x);
    let worstOverlap = 0;
    let overlapPair = '';
    for (let i = 1; i < sorted.length; i++) {
        const previous = sorted[i - 1];
        const current = sorted[i];
        const overlap = previous.x + previous.half - (current.x - current.half);
        if (overlap > worstOverlap) {
            worstOverlap = overlap;
            overlapPair = `"${previous.text}" / "${current.text}"`;
        }
    }
    record(
        'no two time-axis labels overlap',
        worstOverlap <= 0,
        worstOverlap <= 0
            // Abutting is allowed and reported as such: the renderer drops a label whose box
            // reaches *back into* the previous one, so a pair that exactly touches is the
            // intended outcome rather than a near-miss, and printing "clears by 0.0px"
            // would read as one.
            ? `${sorted.length} distinct labels, tightest pair ${worstOverlap === 0 ? 'abuts exactly' : `clears by ${(-worstOverlap).toFixed(1)}px`}`
            : `worst overlap ${worstOverlap.toFixed(1)}px at ${overlapPair}`,
    );
    // The compaction, stated as the property it is rather than as a count that only holds
    // at one detail: **not every label carries the date.** A minute-level axis is one
    // dated label in eight; a day-level one is roughly one per month. Both are "a small
    // minority", and the old code made it "all of them" at every level. Asserting an exact
    // count here would be asserting the fixture's detail rather than the behaviour.
    const dated = sorted.filter((entry) =>
        /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(entry.text));
    record(
        'most time-axis labels drop the date rather than repeating it',
        dated.length > 0 && dated.length * 2 <= sorted.length,
        `${dated.length} of ${sorted.length} labels carry a date` +
        // Joined on a pipe, not a comma: a full label is `Oct 02, 11:55 AM` and a comma
        // separator makes three labels read as five.
        (dated.length ? ` (${[...new Set(dated.map((d) => d.text))].join(' | ')})` : ''),
    );

    // --- the grid closes where there are no candles -----------------------------------
    //
    // A view parked in the space past the last candle is the case `setVisibleLogicalRange`
    // makes reachable on purpose, and the reported symptom was that the cells never closed
    // out there: the horizontal lines come from the price scale and ran the full width,
    // while the vertical lines stopped dead at the newest candle.
    const gridPastData = await page.evaluate(async () => {
        const { chart, drawn, plot } = globalThis.__mc;
        const count = chart.getCandleCount();
        drawn.lines.length = 0;
        // Fifty bar-widths of empty space after the last candle, forced in the same
        // evaluate as the reset so the frame cannot be missed.
        chart.setVisibleLogicalRange({ from: count - 20, to: count + 50 });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const r = plot();
        // A stroked path is not a line: the grid and the plot border go down in one
        // `beginPath`/`stroke`, so a path is split into its consecutive point pairs and
        // each *segment* judged on its own. Treating a path as a line is how an earlier
        // version of this found only the border and concluded the grid was empty.
        const segments = [];
        for (const path of drawn.lines) {
            for (let i = 1; i < path.length; i++) {
                const [x1, y1] = path[i - 1];
                const [x2, y2] = path[i];
                segments.push({ x1, y1, x2, y2 });
            }
        }
        const plotBottom = r.y + r.height;
        // A vertical grid line: the same x twice, spanning most of the plot's height. One
        // that stops short, or sits outside the plot, is the defect being looked for.
        const verticals = segments
            .filter((s) => s.x1 === s.x2 && Math.abs(s.y2 - s.y1) > 40)
            .map((s) => ({ x: s.x1 - r.x, top: s.y1, bottom: s.y2 }));
        const inPlot = verticals.filter((v) => v.x > 1 && v.x < r.width - 1 && v.bottom <= plotBottom + 1);
        return {
            count,
            verticals: verticals.length,
            inPlot: inPlot.length,
            rightMost: inPlot.length ? Math.max(...inPlot.map((v) => v.x)) : 0,
            plotWidth: r.width,
            lastBarX: chart.indexToCoordinate(count - 1) - r.x,
        };
    });
    record(
        'vertical grid lines reach past the newest candle',
        gridPastData.rightMost > gridPastData.lastBarX,
        `rightmost vertical line at x=${gridPastData.rightMost.toFixed(1)} against the last ` +
        `candle at x=${gridPastData.lastBarX.toFixed(1)} in a ${gridPastData.plotWidth.toFixed(0)}px plot ` +
        `(${gridPastData.inPlot} verticals)`,
    );

    // --- the chrome the caller is expected to own --------------------------------------
    //
    // The floating OHLC panel and the last-price tag were both drawn unconditionally, and
    // neither could be removed: `crosshair.visible: false` took the crosshair lines, the
    // panel and both gutter tags together, and the last-price tag had no option at all.
    // Both are options now, defaulting to off, and these assert the drawing.
    //
    // This can only be measured here. The headless 2D layer is a deliberate no-op double
    // whose `fillText` records nothing, so a test suite can assert that the option exists
    // and nothing about whether it is honoured.

    /** Hovers the middle of the plot and reports the OHLC panel's own text. */
    const readPanel = async (applyOptions) => {
        const box = await page.evaluate(() => globalThis.__mc.plot());
        await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
        await wait(120);
        return page.evaluate(async (patch) => {
            const { chart, drawn, plot } = globalThis.__mc;
            if (patch !== null) chart.applyOptions(patch);
            drawn.labels.length = 0;
            // One redraw after the option lands, so what is measured is the option's
            // effect and not the frame that happened to be on screen already.
            chart.scrollToRealtime();
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return drawn.labels
                .map((entry) => entry.text)
                .filter((text) => /^(O|H|L|C|T) /.test(text));
        }, applyOptions);
    };

    // Off by default: a hover draws no OHLC text at all.
    const panelOff = await readPanel(null);
    record(
        'the library draws no OHLC panel by default',
        panelOff.length === 0,
        panelOff.length === 0 ? 'no O/H/L/C or T text on hover' : panelOff.slice(0, 3).join(' | '),
    );
    // On when asked, and the crosshair is unaffected either way — this is the panel, not
    // the crosshair.
    const panelOn = await readPanel({ crosshair: { readout: true } });
    const wanted = ['O ', 'H ', 'L ', 'C ', 'T '];
    record(
        'crosshair.readout draws the OHLC panel when asked',
        wanted.every((prefix) => panelOn.some((text) => text.startsWith(prefix))),
        `${panelOn.length} lines: ${panelOn.join(' | ') || 'none'}`,
    );
    await page.evaluate(() => globalThis.__mc.chart.applyOptions({ crosshair: { readout: false } }));
    await wait(120);

    // The last-price tag, measured directly rather than through its side effect.
    //
    // An earlier version of this asserted the *consequence* — that a price line sitting at
    // the newest close gets its axis label back when the tag is off — and that was the
    // worst possible fixture: a price line at the same value as the last price draws the
    // same text at the same y, so the two are indistinguishable and the counts came out
    // equal with the tag both on and off. The tag's own presence is measurable on its own:
    // lock the price range so the ticks are round numbers well away from the newest close,
    // and then a label at the newest close's y can only be the tag.
    const lastPriceTagLabels = async (patch) => page.evaluate(async (p) => {
        const { chart, drawn } = globalThis.__mc;
        if (p !== null) chart.applyOptions(p);
        // A locked range puts the ticks at round numbers, so the newest close is not one.
        const last = chart.getLastCandle();
        const lo = Math.floor(last.close) - 4;
        chart.setPriceRange([lo, lo + 8]);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        drawn.labels.length = 0;
        chart.scrollToRealtime();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const plotRect = chart.getPlotRect();
        // Where the newest close sits in y, so the tag can be looked for by position.
        const priceY = chart.priceToCoordinate(last.close);
        return {
            priceY,
            close: last.close,
            atTag: drawn.labels
                .filter((entry) => entry.x > 0 && entry.x <= plotRect.x
                    && Math.abs(entry.y - priceY) < 2)
                .map((entry) => entry.text),
        };
    }, patch);

    const tagOn = await lastPriceTagLabels({ candlestick: { lastPriceTag: true } });
    const tagOff = await lastPriceTagLabels({ candlestick: { lastPriceTag: false } });
    record(
        'candlestick.lastPriceTag draws the price-axis tag only when asked',
        tagOn.atTag.length > 0 && tagOff.atTag.length === 0,
        `close ${tagOn.close} at y=${tagOn.priceY.toFixed(1)} — tag on: ` +
        `[${tagOn.atTag.join(', ') || 'none'}], tag off: [${tagOff.atTag.join(', ') || 'none'}]`,
    );
    await page.evaluate(() => globalThis.__mc.chart.applyOptions({ candlestick: { lastPriceTag: false } }));
    await wait(120);

    // --- the text is actually legible on the chip it is drawn on -----------------------
    //
    // Reported as "the price line badge text is not visible". That is not a wrong value
    // anywhere: the tag was filled with a saturated candle colour and its text painted in
    // the theme's text colour, which on the dark theme is a light ink on saturated green.
    // Nothing was incorrect, so nothing could be asserted about it — legibility is a
    // relationship between two colours, and only the drawn pair shows it.
    const chipContrast = await page.evaluate(async () => {
        const { chart, drawn, rgb } = globalThis.__mc;
        chart.applyOptions({ crosshair: { readout: true }, candlestick: { lastPriceTag: true } });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        drawn.labels.length = 0;
        drawn.rects.length = 0;
        chart.scrollToRealtime();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const plotRect = chart.getPlotRect();
        // A label sitting on a chip: the most recent rect, drawn before it, that contains
        // its anchor. `drawTag` and the OHLC panel both fill then write, so the pairing is
        // by order as well as by geometry.
        const linear = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        const luminance = (rgba) =>
            0.2126 * linear(rgba[0]) + 0.7152 * linear(rgba[1]) + 0.0722 * linear(rgba[2]);
        const ratio = (a, b) => {
            const hi = Math.max(luminance(a), luminance(b));
            const lo = Math.min(luminance(a), luminance(b));
            return (hi + 0.05) / (lo + 0.05);
        };
        const measured = [];
        for (const label of drawn.labels) {
            const ink = rgb(label.fill);
            if (ink === null) continue;
            const chip = [...drawn.rects].reverse().find((rect) =>
                label.x >= rect.x && label.x <= rect.x + rect.w
                && label.y >= rect.y && label.y <= rect.y + rect.h);
            if (chip === undefined) continue;
            const fill = rgb(chip.fill);
            if (fill === null || fill[3] === 0) continue;
            measured.push({
                text: label.text,
                ratio: ratio(ink, fill),
                // Only the gutter chips and the OHLC panel, not the plain axis labels,
                // which sit on the plot and are the theme's business rather than a chip's.
                chip: chip.x < plotRect.x + 200,
            });
        }
        return measured;
    });

    const onChips = chipContrast.filter((entry) => entry.chip);
    const worst = onChips.reduce((min, entry) => Math.min(min, entry.ratio), Infinity);
    record(
        'text on every chip is legible against the chip it sits on',
        onChips.length >= 2 && worst >= 4.5,
        onChips.length === 0
            ? 'no chip text was found to measure'
            : `${onChips.length} labels on chips, worst ${worst.toFixed(2)}:1` +
              (worst < 4.5
                  ? ` — "${onChips.find((entry) => entry.ratio === worst).text}"`
                  : ''),
    );
    await page.evaluate(() => globalThis.__mc.chart.applyOptions({
        crosshair: { readout: false },
        candlestick: { lastPriceTag: false },
    }));

    // --- a claimed press is the caller's, and the claim is released -------------------
    //
    // The same real drag, twice: once with a handler that declines, once with one that
    // claims. Both directions are asserted, because each alone passes against a broken
    // seam — an always-claim passes the claimed case, and a seam that did not exist passes
    // the declined one. The comparison is the assertion.
    await page.evaluate(() => globalThis.__mc.chart.scrollToRealtime());
    await wait(120);
    const claimStartX = plot.x + plot.width * 0.5;
    const claimMidY = plot.y + plot.height * 0.5;
    const claimDrag = 120;

    // Declined: the chart pans, as it always did.
    await page.evaluate(() => globalThis.__mc.claimAll(false));
    await page.mouse.move(claimStartX, claimMidY);
    await page.mouse.down();
    await page.mouse.move(claimStartX + claimDrag, claimMidY, { steps: 12 });
    await page.mouse.up();
    await wait(120);
    const afterDeclined = await page.evaluate(() => globalThis.__mc.chart.getVisibleLogicalRange());

    // Claimed: the identical gesture moves nothing at all.
    await page.evaluate(() => {
        globalThis.__mc.chart.scrollToRealtime();
        globalThis.__mc.claimAll(true);
    });
    await wait(120);
    const beforeClaimed = await page.evaluate(() => globalThis.__mc.chart.getVisibleLogicalRange());
    await page.mouse.move(claimStartX, claimMidY);
    await page.mouse.down();
    await page.mouse.move(claimStartX + claimDrag, claimMidY, { steps: 12 });
    await page.mouse.up();
    await wait(120);
    const afterClaimed = await page.evaluate(() => globalThis.__mc.chart.getVisibleLogicalRange());

    // The declined drag and the claimed drag ended in different places. Comparing the two
    // rather than asserting the declined one moved is what makes this an assertion about
    // the seam: a handler that claimed nothing and a handler that claimed everything would
    // have to differ, and a seam that did not exist could only produce the first.
    const declinedPanned = afterDeclined.from !== afterClaimed.from
        || afterDeclined.to !== afterClaimed.to;
    const claimedHeld = afterClaimed.from === beforeClaimed.from
        && afterClaimed.to === beforeClaimed.to;
    record(
        'a claimed press does not pan, and the claim is released on mouseup',
        declinedPanned && claimedHeld,
        `declined ${afterDeclined.from.toFixed(1)}..${afterDeclined.to.toFixed(1)}, `
        + `claimed ${beforeClaimed.from.toFixed(1)}..${beforeClaimed.to.toFixed(1)} -> `
        + `${afterClaimed.from.toFixed(1)}..${afterClaimed.to.toFixed(1)}`,
    );

    // Released: the very next unclaimed drag has to pan again. A claim that outlived its
    // gesture would leave the chart unpannable for the rest of the session, and the user
    // has no way to recover except reloading the page.
    await page.evaluate(() => globalThis.__mc.claimAll(false));
    const beforeRecovered = await page.evaluate(() => globalThis.__mc.chart.getVisibleLogicalRange());
    await page.mouse.move(claimStartX, claimMidY);
    await page.mouse.down();
    await page.mouse.move(claimStartX - claimDrag, claimMidY, { steps: 12 });
    await page.mouse.up();
    await wait(120);
    const afterRecovered = await page.evaluate(() => globalThis.__mc.chart.getVisibleLogicalRange());
    record(
        'the chart pans again after a claimed gesture ended',
        Math.abs(afterRecovered.from - beforeRecovered.from) > 1
            || Math.abs(afterRecovered.to - beforeRecovered.to) > 1,
        `${beforeRecovered.from.toFixed(1)}..${beforeRecovered.to.toFixed(1)} -> `
        + `${afterRecovered.from.toFixed(1)}..${afterRecovered.to.toFixed(1)}`,
    );

    // --- redraw() reaches the caller's painter ----------------------------------------
    //
    // A real 2D context is in play on this page, so the painter genuinely runs. Before
    // `redraw()` was public there was no way to get a caller's own model change on screen
    // without provoking a gesture, and the symptom was a drawing that only appeared when
    // the user happened to pan.
    const painterReach = await page.evaluate(async () => {
        const { chart, installPainter, paintCount } = globalThis.__mc;
        chart.setPointerClaimHandler(null);
        installPainter();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const before = paintCount();
        chart.redraw();
        return { before, after: paintCount() };
    });
    record(
        'redraw() repaints a registered painter',
        painterReach.after > painterReach.before,
        `${painterReach.before} -> ${painterReach.after} paints`,
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
