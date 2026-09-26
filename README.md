# MatrixCharts

Zero-dependency WebGL2 candlestick chart with a sequenced live candle feed.

## Install

```bash
npm install matrixcharts
```

```ts
import { Chart } from 'matrixcharts';

const chart = new Chart(document.getElementById('chart')!, { theme: 'dark' });
chart.setData([
    { time: Date.UTC(2025, 0, 1), open: 100, high: 102, low: 99, close: 101 },
]);
```

Ships ESM and CommonJS with separate declarations for each, so both work in Vite/Next and in `require()`-based Node tests. No runtime dependencies.

## Requirements

- Browser DOM
- **WebGL2** (no Canvas2D candlestick fallback in v1)

`new Chart(container, options)` takes an `HTMLElement` or an element id.

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
```

Open `/tests/browser/streaming.e2e.html` under `npm run dev` for the WebGL integration run. It sets `data-test-result="pass"` on the `<html>` element.

## v1 API

See [docs/v1-contract.md](docs/v1-contract.md) for the frozen public surface, data rules, and feed protocol. Live sockets go through `WebSocketCandleSource` + `ChartFeedController`. Operational limits are in [docs/production-readiness.md](docs/production-readiness.md).
