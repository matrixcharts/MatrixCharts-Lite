# MatrixCharts v1 contract

This is the frozen public surface for **v1.0**. Additive APIs may appear in later 1.x releases. Removing, renaming, or changing the meaning of anything below is a breaking change.

The normative feed wire format lives in [feed-adapters.md](feed-adapters.md). Operational constraints (retention, timestamps, sessions) live in [production-readiness.md](production-readiness.md).

## Package exports

Installable entry is the package root (`matrixcharts`). Only these names are public:

| Export | Kind |
|---|---|
| `Chart` | class |
| `ChartFeedController` | class |
| `WebSocketCandleSource` | class |
| `MockCandleSource` | class |
| `CandleData` | type |
| `ChartOptions` | type |
| `ChartTheme` | type |
| `PriceFormatOptions` | type |
| `LayoutOptions` | type |
| `GridOptions` | type |
| `CrosshairOptions` | type |
| `TimeScaleOptions` | type |
| `CandlestickOptions` | type |
| `ResolvedChartOptions` | type |
| `LogicalRange` | type |
| `TimeRange` | type |
| `CrosshairMoveEvent` | type |
| `CrosshairData` | type |
| `CrosshairCleared` | type |
| `ChartClickEvent` | type |
| `VisibleRangeEvent` | type |
| `Unsubscribe` | type |
| `CandleFeedMessage` | type |
| `CandleSource` | type |
| `CandleSourceState` | type |
| `CandleTarget` | type |
| `WebSocketCandleSourceOptions` | type |

Renderers, the OHLC pyramid, LTTB, coordinate math, and `IRenderer` are internal. Do not import files under `src/` from an application.

The package ships zero runtime dependencies, `sideEffects: false`, and one entry point with per-condition declarations:

```jsonc
"exports": {
  ".": {
    "import":  { "types": "./dist/esm/index.d.ts", "default": "./dist/esm/index.js" },
    "require": { "types": "./dist/cjs/index.d.ts", "default": "./dist/cjs/index.js" }
  }
}
```

Each condition carries its own `.d.ts` so a CommonJS consumer's `require('matrixcharts')` is not typed as an ESM-only module. `dist/esm` and `dist/cjs` each carry a `package.json` `type` marker, and the ESM output uses explicit `.js` specifiers so it loads in Node as well as in a bundler. Subpath imports are not published; only the root entry resolves. `npm run verify:package` enforces all of this against the packed tarball.

## Runtime requirements

`Chart` requires a browser document and **WebGL2**. `canvas.getContext('webgl2')` must succeed. There is no Canvas2D candlestick fallback in v1, no software WebGL polyfill, and no reduced-fidelity mode.

When the context cannot be acquired, `new Chart(...)` throws exactly:

```
MatrixCharts: WebGL2 is required.
```

That string is stable and safe to match on. The failure is fail-fast and clean: the three layers are built and initialised while detached and are only attached to the caller's container once every renderer is live, so a rejected construction leaves the container byte-for-byte as it was, including any markup the caller put there. There is no window in which a caller can observe a half-mounted chart or a set of empty canvases. A failed construction also poisons nothing: constructing again after the capability returns works normally.

Supported engines, and the versions that first shipped WebGL2:

| Browser | Minimum |
|---|---|
| Chrome, Edge, Opera | 56 / 79 / 43 |
| Firefox | 51 |
| Safari (macOS, iOS) | 15 |
| Internet Explorer | not supported, at any version |

Safari 14 and earlier are out, including iOS 14. A Canvas2D renderer is a separate post-v1 milestone with a documented cap on visible candles; it is deliberately absent from v1 rather than half-present.

## `CandleData`

```ts
interface CandleData {
    time: number; // Unix epoch milliseconds, UTC
    open: number;
    high: number;
    low: number;
    close: number;
}
```

- `time` is milliseconds, not seconds. Do not pass date strings.
- Values must be finite. `high >= max(open, close)` and `low <= min(open, close)`.
- A series must be strictly increasing in `time`.
- v1 has no `volume` field. Extra properties on objects are ignored.

## Chart construction and mutations

```ts
new Chart(container: HTMLElement | string, options?: ChartOptions)
```

`container` is an `HTMLElement` or the `id` of one already in `document`. An element that is not yet attached to the document is accepted; it mounts immediately and picks up its size through `ResizeObserver` once it is attached and has a layout box. A missing id, an empty id, or a non-element throws `MatrixCharts: ...`.

`ChartOptions` in v1: `maxRetainedCandles` (positive safe integer, default `1_000_000`; constructor-only) and `theme` (`'dark' | 'paper'`, default `'dark'`).

| Method | Viewport | Meaning |
|---|---|---|
| `setData(candles)` | reset | Replace history; fit/live-follow from the new series. |
| `replaceData(candles)` | preserved | Authoritative snapshot. Keep zoom; rematerialize the time anchor when that timestamp still exists. |
| `appendData(candle)` / `appendBatch(candles)` | follow if at live edge | Each candle `time` must be strictly after the current last. |
| `updateLast(candle)` | unchanged | `candle.time` must equal the current last timestamp. |
| `setTheme(theme)` | redraw | `'dark'` or `'paper'`. Equivalent to `applyOptions({ theme })`. |
| `destroy()` | — | Detach listeners, drop GPU resources, remove the chart's own wrapper. |

Historical corrections that are not the current last candle require `replaceData` (or a feed snapshot). The chart never invents missing bars.

### Teardown

`destroy()` removes only the wrapper the chart created. Any other markup the caller placed in the same container, such as a legend or a toolbar, is left untouched.

After `destroy()` the chart is unusable: every public method, including the read API and the subscriptions, throws exactly `MatrixCharts: This chart has been destroyed.` No method quietly serves stale state. `destroy()` is idempotent, so it is safe to call from more than one teardown path.


The horizontal coordinate is the candle **ordinal index**, not wall-clock time. Closed sessions (nights, weekends, holidays) are compressed. Axis and crosshair labels snap to real candle timestamps.

## Reading the viewport

Every method below is synchronous, works in CSS pixels relative to the container's top-left, and never copies the series. Conversions are independent of `devicePixelRatio`; the renderers apply DPR internally. A value returned here always matches what is drawn.

| Method | Returns |
|---|---|
| `getBarSpacing()` | CSS px per candle index. |
| `getVisibleLogicalRange()` | `{ from, to }` candle indices, **half-open**: `from`..`to - 1`. Partial bars at either edge are included. `from === to` means nothing is visible. |
| `getVisibleTimeRange()` | `{ from, to }` epoch ms of the first and last visible candle, **both inclusive**, or `null` when empty. |
| `getCandleCount()` | Retained candle count. |
| `getCandleAt(index)` | `CandleData \| null`; `null` for a non-integer or out-of-range index. |
| `getLastCandle()` | `CandleData \| null`; `null` when there is no data. |
| `indexToCoordinate(index)` | Screen x of a candle index. |
| `coordinateToIndex(x)` | Fractional candle index at a screen x. Not clamped. |
| `coordinateToNearestIndex(x)` | Nearest whole candle index, or `-1` when empty. |
| `coordinateToTime(x)` | Timestamp of the nearest candle, or `null` when empty. |
| `timeToCoordinate(time)` | Screen x of the candle nearest a timestamp, or `null` when empty. |
| `priceToCoordinate(price)` | Screen y of a price. |
| `coordinateToPrice(y)` | Price at a screen y, on the current auto-fitted vertical scale. |

The index range is half-open because it names a set of bars. The time range is inclusive on both ends because it names two real candles, and a closed session has no end instant to report. The two are related by `getVisibleTimeRange().from === getCandleAt(range.from).time` and `.to === getCandleAt(range.to - 1).time`.

`getCandleAt` and `getLastCandle` read the same float32 store the renderer draws from, so prices come back at float32 precision and may differ in the last bits from the doubles that were passed to `setData`. `time` is exact.

Time conversions snap to a real candle timestamp and never interpolate across a gap, so `coordinateToTime` at the midpoint of a weekend returns the Friday or Monday candle, never a Saturday.

### Handler re-entrancy

A handler may call back into the chart. Doing so cannot start an event loop: while `crosshairMove` or `visibleRangeChange` handlers are running, further crosshair emissions and further range notifications are suppressed. A change a handler causes for itself is therefore not re-notified, but the next change from outside still fires. This makes a handler that restyles the chart on every notification safe rather than a runaway `requestAnimationFrame` chain.

### Sizing

Canvas backing stores are sized from the container on the `ResizeObserver` notification, and re-checked at the top of every render. The re-check is what makes the chart correct in environments where the observer is late, throttled, or unavailable, such as a background tab or an embedded webview: the next time the chart renders, it renders at the right resolution, and a container that changed size while the chart was idle is picked up then. The guarantee is scoped to rendering, so a pointer hover, which repaints only the crosshair layer, deliberately does not resize canvases it is not about to redraw.

`getVisibleTimeRange()` is `null` and `getVisibleLogicalRange()` is `{ from: 0, to: 0 }` when the chart is empty or scrolled entirely off the series.

## User events

Subscribe to the chart; do not attach listeners to the canvases. The chart wrapper is the single input surface, and every layer is transparent to the pointer.

| Method | Fires |
|---|---|
| `subscribeCrosshairMove(handler)` | As the pointer moves over the chart, and once when it leaves. |
| `subscribeClick(handler)` | On a press and release that did not become a pan or pinch. |
| `subscribeVisibleRangeChange(handler)` | When the visible bars or bar spacing change, at most once per animation frame. |

Each returns an `Unsubscribe` (`() => void`). Calling it more than once is harmless. `destroy()` drops every handler, so a destroyed chart never calls back into application code.

`crosshair.visible: false` suppresses the drawn crosshair only. `crosshairMove` still fires, because the payload describes the pointer position over the data and is useful for a tooltip that should keep working with the crosshair hidden. A subscriber that wants neither should ignore the events.

`CrosshairMoveEvent` and `ChartClickEvent` are discriminated unions on `candle`:

| Field | `candle` present | `candle: null` |
|---|---|---|
| `x` | CSS x, snapped to the bar centre | `null` |
| `y` | CSS y, following the pointer | `null` |
| `index` | ordinal candle index | `-1` |
| `time` | candle timestamp, epoch ms | `null` |
| `price` | price at `y` | `null` |
| `candle` | the `CandleData` under the pointer | `null` |
| `button` | click only: the pointer button | click only: the pointer button |

`candle` is `null` when the pointer left, when a drag or pinch is in progress, when the chart has no data, or when `x` is past the series. Narrow on `event.candle` to get the populated form.

`x` is snapped to the bar centre so a tooltip can be positioned at the crosshair, while `y` keeps following the pointer so the price readout tracks the cursor. The drawn crosshair and the reported event always agree: Chart owns the hit-test and the UI layer only draws what Chart resolved. The reported `candle` is the exact retained candle, not an aggregate bucket, so it is correct at any zoom level.

`VisibleRangeEvent` carries `logical`, `time`, and `barSpacing` from the read API above. It is silent when the visible bars and bar spacing are unchanged, so a drag that stays between bar boundaries produces no events and float drift from wheel or pinch arithmetic does not re-notify.

A press that travels more than a few CSS pixels is a pan, not a click, and reports no `click`. Touch and pen contacts clear the crosshair on release because they have no hover state.

## Runtime options

Constructor options are the initial `applyOptions`.

```ts
chart.applyOptions(partial: ChartOptions): void
chart.options(): Readonly<ResolvedChartOptions>
chart.setTheme(theme: ChartTheme): void   // same as applyOptions({ theme })
```

`applyOptions` deep-merges a partial over the current options and re-resolves. An invalid value throws `MatrixCharts: ...` **before anything is mutated**, so a rejected call leaves the chart exactly as it was. `options()` returns a fully resolved snapshot; every field is concrete, including the theme preset colours.

| Section | Fields | Default |
|---|---|---|
| `maxRetainedCandles` | positive safe integer | `1_000_000`, **constructor-only** |
| `theme` | `'dark' \| 'paper'` | `'dark'` |
| `locale` | BCP 47 tag | the runtime locale |
| `timeZone` | IANA zone | `'UTC'` |
| `priceFormat.precision` | integer 0-20 | `2` |
| `priceFormat.minMove` | positive number | `0.01` |
| `layout.background` | CSS colour | theme preset |
| `layout.textColor` | CSS colour | theme preset |
| `layout.priceAxisWidth` | non-negative number (additive in 1.x) | `78` |
| `layout.timeAxisHeight` | non-negative number (additive in 1.x) | `22` |
| `grid.vertLines` / `grid.horzLines` | boolean | `true` |
| `grid.color` | CSS colour, alpha honoured | theme preset |
| `crosshair.visible` | boolean | `true` |
| `crosshair.color` | CSS colour (additive in 1.x) | theme preset |
| `timeScale.barSpacing` | positive number | `14` |
| `timeScale.minBarSpacing` | positive number | `0.5` |
| `timeScale.maxBarSpacing` | positive number | `400` |
| `candlestick.upColor` / `downColor` | CSS colour | theme preset |
| `candlestick.wickVisible` | boolean | `true` |
| `candlestick.borderVisible` | boolean | `false` |
| `candlestick.borderUpColor` / `borderDownColor` | CSS colour | theme preset |

**Theme switching and overrides.** A theme change re-seeds every colour from that theme's preset and then re-applies anything the caller set explicitly, so an override survives a theme switch:

```ts
chart.applyOptions({ candlestick: { upColor: '#ff00ff' } });
chart.applyOptions({ theme: 'paper' });
chart.options().candlestick.upColor;    // still '#ff00ff'
```

**Colours** accept `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` with numeric or percentage channels, and `transparent`. Channels clamp the way CSS clamps them. Anything else throws rather than rendering black. Colours are parsed to RGBA once per `applyOptions`, never per candle.

**`maxRetainedCandles` is constructor-only.** `applyOptions` rejects it, because changing it means rebuilding the retained pyramid under a live viewport.

**`priceFormat.precision` and `minMove` must agree.** A `precision` that cannot display `minMove` (`precision: 0` with `minMove: 0.01`) throws, so lower precision together with a wider tick:

```ts
chart.applyOptions({ priceFormat: { precision: 0, minMove: 1 } });
```

**`timeScale.barSpacing`** sets the zoom while holding the view still: a live-following chart stays pinned to the newest bar, anything else keeps the bar under the viewport centre. `minBarSpacing` and `maxBarSpacing` clamp wheel and pinch zoom, and re-clamp immediately if the current zoom becomes illegal. These replace the old unbounded `1e-4`..`1e4` range.

**Time labels default to UTC** so they do not depend on the viewer's zone. `locale` and `timeZone` feed `Intl.DateTimeFormat` and `Intl.NumberFormat`; price labels use `precision` and locale separators.

**The plot is the canvas less two reserved gutters.** `layout.priceAxisWidth` (default 78) is reserved on the left for price labels and `layout.timeAxisHeight` (default 22) along the bottom for time labels. Both are CSS pixels, both are non-negative, and zero restores the old behaviour of drawing labels over the data. Every part of the geometry derives from one plot rect: the visible logical and time ranges, the live edge, the zoom anchor, the vertical fit, the grid lines, the axis frame, and the crosshair rules. Nothing measures the canvas directly to decide what is visible.

Series are **clipped to the plot rect** with a scissor box, so a bar scrolled part-way past an edge is cut at the plot boundary instead of painting over the price labels. Clipping is applied per draw and cleared afterwards, and the clear runs with clipping off so the gutters cannot retain stale pixels.

The gutter widths are a fixed size rather than measured from the label text, because the widest label depends on the visible price range, which depends on the plot height, which depends on the gutter. The default fits a separated price of up to six digits with two decimals; widen `priceAxisWidth` for instruments quoted with more digits.

**`candlestick.wickVisible: false`** skips generating and drawing the wick segments. **`borderVisible: true`** draws a 1 device-pixel frame inside the body outline and insets the fill to match, in the same indexed pass with no extra shader or draw call. The body is never grown, so the gutter between bars is unchanged, and the frame is skipped on bodies too small to hold it.

The border is a frame of four strips, never a quad underneath the body. That matters for translucent fills: the fill always composites against the plot background, never against the border colour, so `borderVisible` cannot tint the interior of a candle. Verified by construction, since a body covered by the border quad would blend to the border's hue wherever the fill has alpha.

The frame is exactly one device pixel at any `devicePixelRatio`. Every body edge is resolved to a whole device pixel on the CPU and then emitted as the data value whose device position is that exact pixel, so the shader's `floor(device + 0.5)` snap is never near a rounding boundary. This is not a formality: a body edge landing on a whole CSS pixel puts `position * pixelRatio` on a half-integer at every odd-tenth ratio, where that snap is knife-edge, and the two edges of a one-pixel frame then round independently and produce a two-pixel or zero-pixel frame. The row is computed in `float32` to match the uniforms the GPU actually receives, because a `pixelRatio` such as `2.3` is not representable in `float32` and a row chosen in double precision can be the row the body was never drawn on.

Recolouring reaches the GPU without touching the data: `applyOptions` repaints from the existing vertex buffers, and `getCandleCount()` is unchanged.



## Feed v1

Use `WebSocketCandleSource` + `ChartFeedController` against a `CandleTarget` (`Chart` implements this). Do not open sockets inside renderers.

Message types: `snapshot`, `update`, `append`, `heartbeat`. Sequences are non-negative safe integers and increase once per message. Snapshot is authoritative. Gaps pause deltas and emit `{"type":"resync","afterSequence":n,"reason":"..."}`. Heartbeats must arrive more often than the client timeout. Reconnect backoff is capped; v1 retries indefinitely.

A candle field that is not a finite number is rejected at the transport boundary and requests a snapshot. `JSON.parse` turns an out-of-range literal such as `1e999` into `Infinity`, which is a `number` but not a usable price or timestamp, so it is rejected like any other malformed field rather than passed downstream for a consumer to catch. A malformed frame requests a resync once; further bad frames do not re-send it while one is already pending.

`MockCandleSource` is a development source, not a production protocol.

## Breaking vs additive

**Breaking:** changing `CandleData` field units; adding required fields; new required feed message types for a working live chart; removing any export in the table above; changing the package entry or its `exports` conditions; changing mutation ordering rules; changing the half-open index range or inclusive time range conventions; making a conversion depend on `devicePixelRatio`; changing when an event fires or what a `null` field means; making `maxRetainedCandles` settable at runtime; changing a resolved default or a validation rule; changing the WebGL2 or post-destroy error strings, or what `destroy()` removes; requiring wall-clock X; dropping the WebGL2 requirement without a replacement renderer.

**Additive (allowed in 1.x):** extra optional `ChartOptions`; new `Chart` methods; optional feed fields the v1 client ignores; extra exports.
