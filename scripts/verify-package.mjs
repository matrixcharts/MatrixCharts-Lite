// Proves the published artifact, not just the source tree:
//   1. npm pack ships dist/esm, dist/cjs, .d.ts, docs, and the changelog, and
//      nothing internal. The changelog is listed explicitly because `files` is the
//      only thing putting it in the tarball: npm auto-includes README, LICENSE and
//      package.json and nothing else, so a changelog left out of `files` is a
//      changelog nobody reads on npm. Asserted here so tidying `files` cannot drop
//      it without the gate noticing.
//   2. require() and import resolve to the same v1 value exports, and neither
//      can reach an internal module through a subpath.
//   3. TypeScript resolves the "import" and "require" type conditions, and the
//      exports map blocks deep imports of internals.
// No network and no tar dependency: the file list comes from `npm pack --json`
// and the installed tree is assembled from the same files that were listed.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.join(repoRoot, '.tmp', 'verify');
const consumerModules = path.join(workspace, 'node_modules', 'matrixcharts');
const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const VALUE_EXPORTS = ['Chart', 'ChartFeedController', 'MockCandleSource', 'WebSocketCandleSource'];

const REQUIRED_PACK_PATHS = [
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'dist/esm/index.js',
    'dist/esm/index.d.ts',
    'dist/esm/package.json',
    'dist/cjs/index.js',
    'dist/cjs/index.d.ts',
    'dist/cjs/package.json',
    'docs/v1-contract.md',
    'docs/feed-adapters.md',
    'docs/production-readiness.md',
];

const FORBIDDEN_PACK_PATHS = [
    'src/index.ts',
    'src/core/Chart.ts',
    'tests/PublicApi.test.cjs',
    'tsconfig.json',
    'index.html',
];

const failures = [];

function check(label, assertion) {
    try {
        assertion();
        process.stdout.write(`  ok  ${label}\n`);
    } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        process.stdout.write(`FAIL  ${label}\n`);
    }
}

function readJson(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
}

function runNode(scriptPath) {
    return execFileSync(process.execPath, [scriptPath], { encoding: 'utf8' });
}

function runNpm(args) {
    // npm ships as a shell shim on Windows, so prefer invoking npm-cli.js with
    // the current node binary. `npm_execpath` is set when this runs as an npm
    // script; otherwise fall back to the copy next to the node executable.
    const candidates = [
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    const npmCli = candidates.find((candidate) => candidate && /\.js$/i.test(candidate) && existsSync(candidate));
    if (npmCli) {
        return execFileSync(process.execPath, [npmCli, ...args], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
    });
}

function runTsc(projectPath) {
    return execFileSync(process.execPath, [tsc, '-p', projectPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tscOrThrow(projectPath) {
    try {
        return runTsc(projectPath);
    } catch (error) {
        const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
        throw new Error(output || String(error.message));
    }
}

function writeProject(dir, files) {
    mkdirSync(dir, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
        writeFileSync(path.join(dir, name), contents);
    }
}

rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });

// --- 1. tarball contents -----------------------------------------------------
const packJson = JSON.parse(
    runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', workspace]),
);
const packedFiles = packJson[0].files.map((entry) => entry.path.replace(/\\/g, '/'));

check('tarball ships the ESM entry, CJS entry, types, and docs', () => {
    const missing = REQUIRED_PACK_PATHS.filter((required) => !packedFiles.includes(required));
    if (missing.length > 0) throw new Error(`missing from tarball: ${missing.join(', ')}`);
});

check('tarball ships no source, tests, or tsconfig', () => {
    const leaked = packedFiles.filter((file) => FORBIDDEN_PACK_PATHS.includes(file));
    if (leaked.length > 0) throw new Error(`leaked into tarball: ${leaked.join(', ')}`);
});

check('tarball has no .ts or .cjs source files outside dist declarations', () => {
    const stray = packedFiles.filter(
        (file) => /\.(test|spec)\.c?js$/.test(file) || (file.endsWith('.ts') && !file.endsWith('.d.ts')),
    );
    if (stray.length > 0) throw new Error(`unexpected source in tarball: ${stray.join(', ')}`);
});

// --- 2. install the packed layout into a throwaway consumer -----------------
mkdirSync(consumerModules, { recursive: true });
for (const file of packedFiles) {
    const destination = path.join(consumerModules, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(repoRoot, file), destination);
}

check('installed package declares per-condition types and defaults', () => {
    const manifest = readJson(path.join(consumerModules, 'package.json'));
    const entry = manifest.exports?.['.'];
    if (manifest.type !== 'module') throw new Error('root "type" must be "module"');
    if (manifest.sideEffects !== false) throw new Error('"sideEffects" must be false');
    // Each condition needs its own .d.ts, otherwise a CJS consumer sees an
    // ESM-only module and TypeScript rejects require('matrixcharts').
    const expected = {
        import: { types: './dist/esm/index.d.ts', default: './dist/esm/index.js' },
        require: { types: './dist/cjs/index.d.ts', default: './dist/cjs/index.js' },
    };
    for (const [condition, mapping] of Object.entries(expected)) {
        for (const [key, file] of Object.entries(mapping)) {
            if (entry?.[condition]?.[key] !== file) {
                throw new Error(`unexpected exports["."].${condition}.${key}: ${entry?.[condition]?.[key]}`);
            }
            if (!existsSync(path.join(consumerModules, file))) {
                throw new Error(`exports["."].${condition}.${key} points at a missing file: ${file}`);
            }
        }
    }
    if (readJson(path.join(consumerModules, 'dist/esm/package.json')).type !== 'module') {
        throw new Error('dist/esm is not marked as ESM');
    }
    if (readJson(path.join(consumerModules, 'dist/cjs/package.json')).type !== 'commonjs') {
        throw new Error('dist/cjs is not marked as CommonJS');
    }
});

check('the ESM entry uses explicit .js specifiers so Node can load it', () => {
    const entrySource = readFileSync(path.join(consumerModules, 'dist/esm/index.js'), 'utf8');
    const specifiers = [...entrySource.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    const extensionless = specifiers.filter((specifier) => specifier.startsWith('.') && !specifier.endsWith('.js'));
    if (extensionless.length > 0) {
        throw new Error(`extensionless relative specifiers break Node ESM: ${extensionless.join(', ')}`);
    }
});

check('require() exposes only the v1 value exports and blocks deep imports', () => {
    const probe = [
        'const assert = require("node:assert/strict");',
        `const expected = ${JSON.stringify(VALUE_EXPORTS.slice().sort())};`,
        'const cjs = require("matrixcharts");',
        'assert.deepEqual(Object.keys(cjs).filter((n) => n !== "__esModule").sort(), expected);',
        'assert.equal(typeof cjs.Chart, "function");',
        'assert.equal(cjs.Chart.prototype.testDrawWebGLData, undefined);',
        'assert.throws(() => require("matrixcharts/dist/esm/renderers/WebGL2Renderer.js"), /ERR_PACKAGE_PATH_NOT_EXPORTED/);',
    ].join('\n');
    writeFileSync(path.join(workspace, 'cjs-probe.cjs'), probe);
    runNode(path.join(workspace, 'cjs-probe.cjs'));
});

const esmProbe = path.join(workspace, 'esm-probe.mjs');
writeFileSync(
    esmProbe,
    [
        "import assert from 'node:assert/strict';",
        'const expected = ' + JSON.stringify(VALUE_EXPORTS.slice().sort()) + ';',
        "const mod = await import('matrixcharts');",
        'assert.deepEqual(Object.keys(mod).sort(), expected);',
        "assert.equal(typeof mod.WebSocketCandleSource, 'function');",
        "await assert.rejects(import('matrixcharts/dist/esm/core/Chart.js'), (error) => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');",
        "process.stdout.write('ok');",
    ].join('\n'),
);
check('ESM import resolves the import condition', () => {
    if (runNode(esmProbe).trim() !== 'ok') throw new Error('esm probe did not report ok');
});

// --- 3. TypeScript conditions ------------------------------------------------
const esmConsumer = path.join(workspace, 'consumer-esm');
writeProject(esmConsumer, {
    'package.json': JSON.stringify({ name: 'consumer-esm', type: 'module', private: true }),
    'index.ts': [
        "import { Chart, WebSocketCandleSource, type ChartOptions, type CandleData, type LogicalRange, type TimeRange, type Unsubscribe, type CrosshairMoveEvent, type ChartClickEvent, type VisibleRangeEvent, type ResolvedChartOptions, type ChartTheme, type CandlestickOptions, type PriceFormatOptions, type TimeScaleOptions, type GridOptions, type CrosshairOptions, type LayoutOptions } from 'matrixcharts';",
        'const options: ChartOptions = { maxRetainedCandles: 500, theme: "paper" };',
        '// Every nested option bag must be independently nameable.',
        'export const bags: [CandlestickOptions, PriceFormatOptions, TimeScaleOptions, GridOptions, CrosshairOptions, LayoutOptions] = [',
        '    { upColor: "#0f0", wickVisible: true },',
        '    { precision: 2, minMove: 0.01 },',
        '    { barSpacing: 12 },',
        '    { vertLines: true, horzLines: true },',
        '    { visible: true },',
        '    { background: "#000" },',
        '];',
        'export const themeName: ChartTheme = "paper";',
        'export function mount(host: HTMLElement, candles: CandleData[]): Chart {',
        '    const byElement = new Chart(host, options);',
        '    const byId = new Chart("chart-container", options);',
        '    byElement.setData(candles);',
        '    byId.appendBatch(candles);',
        '    return byId;',
        '}',
        'export const source = new WebSocketCandleSource("wss://example.test/feed");',
        '// The v1 read API must be nameable and typed through the shipped .d.ts.',
        'export function readViewport(chart: Chart, clientX: number): string {',
        '    const spacing: number = chart.getBarSpacing();',
        '    const range: LogicalRange = chart.getVisibleLogicalRange();',
        '    const times: TimeRange | null = chart.getVisibleTimeRange();',
        '    const nearest: number = chart.coordinateToNearestIndex(clientX);',
        '    const candle: CandleData | null = chart.getCandleAt(nearest);',
        '    const last: CandleData | null = chart.getLastCandle();',
        '    const x: number = chart.coordinateToIndex(clientX);',
        '    const y: number = chart.priceToCoordinate(candle?.close ?? 0);',
        '    const price: number = chart.coordinateToPrice(y);',
        '    const time: number | null = chart.coordinateToTime(clientX);',
        '    const timeX: number | null = chart.timeToCoordinate(time ?? 0);',
        '    const count: number = chart.getCandleCount();',
        '    return `${spacing} ${range.from}-${range.to} ${times?.to ?? 0} ${nearest} ${x} ${price} ${timeX} ${count} ${last?.time ?? 0}`;',
        '}',
        '// The v1 event API must be nameable and typed through the shipped .d.ts,',
        '// including the union narrowing integrators rely on.',
        'export function wireEvents(chart: Chart): () => void {',
        '    const stopMove: Unsubscribe = chart.subscribeCrosshairMove((event: CrosshairMoveEvent) => {',
        '        if (event.candle) {',
        '            const index: number = event.index;',
        '            const time: number = event.time;',
        '            const x: number = event.x;',
        '            const y: number = event.y;',
        '            const price: number = event.price;',
        '            const close: number = event.candle.close;',
        '            void [index, time, x, y, price, close];',
        '        } else {',
        '            const nothing: null = event.candle;',
        '            const off: -1 = event.index;',
        '            void [nothing, off, event.x, event.y, event.time, event.price];',
        '        }',
        '    });',
        '    const stopClick: Unsubscribe = chart.subscribeClick((event: ChartClickEvent) => {',
        '        const button: number = event.button;',
        '        void [button, event.candle?.close ?? 0, event.index];',
        '    });',
        '    const stopRange: Unsubscribe = chart.subscribeVisibleRangeChange((event: VisibleRangeEvent) => {',
        '        const logical: LogicalRange = event.logical;',
        '        const time: TimeRange | null = event.time;',
        '        const barSpacing: number = event.barSpacing;',
        '        void [logical.from, logical.to, time?.from ?? 0, barSpacing];',
        '    });',
        '    return () => { stopMove(); stopClick(); stopRange(); };',
        '}',
        '// The v1 options API must round-trip through the shipped .d.ts.',
        'export function restyle(chart: Chart): string {',
        '    chart.applyOptions({ theme: "paper" });',
        '    chart.applyOptions({ candlestick: { upColor: "#ff00ff", wickVisible: false, borderVisible: true } });',
        '    chart.applyOptions({ priceFormat: { precision: 3, minMove: 0.001 } });',
        '    chart.applyOptions({ timeScale: { barSpacing: 18, minBarSpacing: 1, maxBarSpacing: 90 } });',
        '    chart.applyOptions({ crosshair: { visible: false } });',
        '    chart.applyOptions({ grid: { vertLines: false, horzLines: true, color: "#333" } });',
        '    chart.applyOptions({ layout: { background: "#fff", textColor: "#000" }, locale: "de-DE", timeZone: "Europe/Berlin" });',
        '    const resolved: Readonly<ResolvedChartOptions> = chart.options();',
        '    chart.setTheme("dark");',
        '    return [',
        '        resolved.theme,',
        '        resolved.candlestick.upColor,',
        '        resolved.candlestick.borderVisible,',
        '        resolved.priceFormat.precision,',
        '        resolved.timeScale.maxBarSpacing,',
        '        resolved.crosshair.visible,',
        '        resolved.grid.vertLines,',
        '        resolved.layout.textColor,',
        '        resolved.locale,',
        '        resolved.timeZone,',
        '    ].join(",");',
        '}',
    ].join('\n'),
    'tsconfig.json': JSON.stringify({
        compilerOptions: {
            target: 'ES2020',
            lib: ['ES2020', 'DOM'],
            module: 'node16',
            moduleResolution: 'node16',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
        },
        include: ['index.ts'],
    }),
});

const cjsConsumer = path.join(workspace, 'consumer-cjs');
writeProject(cjsConsumer, {
    'index.cts': [
        "import { Chart, ChartFeedController, type ChartTheme } from 'matrixcharts';",
        'const theme: ChartTheme = "dark";',
        'export function build(host: HTMLElement): Chart {',
        '    return new Chart(host, { theme });',
        '}',
        'export const controller = ChartFeedController;',
    ].join('\n'),
    'tsconfig.json': JSON.stringify({
        compilerOptions: {
            target: 'ES2020',
            lib: ['ES2020', 'DOM'],
            module: 'node16',
            moduleResolution: 'node16',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
        },
        include: ['index.cts'],
    }),
});

for (const [label, project] of [['ESM', esmConsumer], ['CommonJS', cjsConsumer]]) {
    check(`${label} consumer type-checks against the shipped .d.ts`, () => {
        tscOrThrow(path.join(project, 'tsconfig.json'));
    });
}

const leakyConsumer = path.join(workspace, 'consumer-internal');
writeProject(leakyConsumer, {
    'index.ts': ["import { WebGL2Renderer } from 'matrixcharts/dist/esm/renderers/WebGL2Renderer.js';", 'export const r = WebGL2Renderer;'].join('\n'),
    'tsconfig.json': JSON.stringify({
        compilerOptions: { target: 'ES2020', lib: ['ES2020', 'DOM'], module: 'node16', moduleResolution: 'node16', noEmit: true, skipLibCheck: true },
        include: ['index.ts'],
    }),
});
check('a consumer cannot import an internal renderer by path', () => {
    let output = '';
    try {
        runTsc(path.join(leakyConsumer, 'tsconfig.json'));
    } catch (error) {
        output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    // The exports map publishes no subpaths, so the resolution must fail rather
    // than silently reaching into dist.
    const blocked = /error TS2307: Cannot find module .*matrixcharts/.test(output)
        || /is not exported|ERR_PACKAGE_PATH_NOT_EXPORTED/.test(output);
    if (!blocked) {
        throw new Error(`tsc accepted a deep import of an internal module${output.trim() ? `: ${output.trim()}` : ''}`);
    }
});

if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} packaging check(s) failed:\n- ${failures.join('\n- ')}\n`);
    process.stdout.write(`\nartifacts kept for inspection: ${workspace}\n`);
    process.exitCode = 1;
} else {
    rmSync(workspace, { recursive: true, force: true });
    process.stdout.write('\npackaging: all checks passed\n');
}
