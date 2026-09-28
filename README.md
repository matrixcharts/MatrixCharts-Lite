# MatrixCharts

Zero-dependency candlestick chart with WebGL2, Canvas2D fallback, and a sequenced live candle feed.

## Install

```bash
npm install @matrixcharts/lite
```

```ts
import { Chart } from '@matrixcharts/lite';

const chart = new Chart(document.getElementById('chart')!, { theme: 'dark' });
chart.setData([
    { time: Date.UTC(2025, 0, 1), open: 100, high: 102, low: 99, close: 101 },
]);
```

`new Chart(container, options)` takes an `HTMLElement` or an element id.

Ships ESM and CommonJS with separate declarations for each, so both work in Vite/Next and in `require()`-based Node tests. No runtime dependencies.

## Requirements

- A browser DOM.
- WebGL2 is preferred. Canvas2D is used as a bounded fallback when WebGL2 is unavailable.

If the data canvas cannot acquire WebGL2, `Chart` keeps the same public API and uses the Canvas2D data renderer. Direct low-level WebGL renderer construction still throws `MatrixCharts: WebGL2 is required.` for capability diagnostics. WebGL2 remains the preferred path for large datasets.

```ts
try {
    chart = new Chart(host);
} catch (error) {
    if (error instanceof Error && error.message === 'MatrixCharts: WebGL2 is required.') {
        showUnsupportedBrowserNotice();
    } else {
        throw error;
    }
}
```

Supported engines, and the versions that first shipped WebGL2:

| Browser | Minimum |
|---|---|
| Chrome, Edge, Opera | 56 / 79 / 43 |
| Firefox | 51 |
| Safari (macOS, iOS) | 15 |
| Internet Explorer | not supported, at any version |

Safari 14 and earlier are out, including iOS 14. There is no software WebGL polyfill and no reduced-fidelity mode; on an unsupported engine the chart refuses to mount rather than drawing something misleading. A Canvas2D renderer is planned as a separate milestone with a documented cap on visible candles, not as part of v1.

## Reading the viewport

Synchronous, CSS-pixel, DPR-independent reads — no private field access, no series copies:

```ts
const spacing = chart.getBarSpacing();                       // px per bar
const { from, to } = chart.getVisibleLogicalRange();          // half-open [from, to)
const window_ = chart.getVisibleTimeRange();                 // inclusive epoch ms, or null
const bar = chart.getCandleAt(chart.coordinateToNearestIndex(event.clientX - rect.left));
const price = chart.coordinateToPrice(event.clientY - rect.top);
```

Time conversions snap to real candle timestamps and never interpolate across a closed session. Full table in [docs/v1-contract.md](docs/v1-contract.md).

## Reacting to the user

Subscribe to the chart rather than attaching listeners to the canvases:

```ts
const stop = chart.subscribeCrosshairMove((event) => {
    if (!event.candle) return hideReadout();
    showReadout(event.candle, event.price);
});

chart.subscribeClick((event) => select(event.index));
chart.subscribeVisibleRangeChange((event) => syncWindow(event.logical, event.barSpacing));

// Later
stop();
```

`CrosshairMoveEvent` is a union discriminated on `candle`, so narrowing gives you a fully populated payload. `subscribeVisibleRangeChange` fires at most once per animation frame and stays silent when the visible bars are unchanged. `destroy()` drops every handler.

## Restyling at runtime

```ts
chart.applyOptions({ theme: 'paper' });
chart.applyOptions({ candlestick: { upColor: '#ff00ff', wickVisible: false } });
chart.applyOptions({ priceFormat: { precision: 3, minMove: 0.001 } });

chart.options().candlestick.upColor;   // '#ff00ff' — fully resolved snapshot
```

Options deep-merge; an invalid value throws `MatrixCharts: ...` before anything is mutated. A theme change re-seeds colours from that theme's preset and then re-applies your explicit overrides, so `upColor` survives the switch above. `maxRetainedCandles` is constructor-only. Time labels default to UTC; set `locale` and `timeZone` to change that.

## Development

```bash
npm run dev       # demo at /index.html
npm test          # deterministic unit + integration suite
npm run verify    # test, then build and check the published tarball
npm run benchmark # sustained-feed throughput and memory
npm run dev       # required for the browser renderer benchmark
npm run benchmark:renderer # Puppeteer/WebGL frame and upload benchmark
```

Open `/tests/browser/streaming.e2e.html` under `npm run dev` for the WebGL integration run. It sets `data-test-result="pass"` on the `<html>` element.

The renderer benchmark opens `/tests/browser/performance.e2e.html` in headless Chrome and
reports animation-callback p50/p95/p99/max time, frames over the 16.67 ms 60 Hz budget,
WebGL draw calls, and uploaded buffer bytes. Set `CHROME_PATH` when Chrome is not in the
usual installation paths, or pass a different page URL as the first argument. Results are
machine- and GPU-dependent; compare repeated runs on the same browser and device rather
than treating one run as a universal limit.

## v1 API

See [docs/v1-contract.md](docs/v1-contract.md) for the frozen public surface, data rules, and feed protocol. Live sockets go through `WebSocketCandleSource` + `ChartFeedController`. Operational limits are in [docs/production-readiness.md](docs/production-readiness.md).
