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


The horizontal coordinate is the candle **ordinal index**, not wall-clock time. Axis and crosshair labels snap to real candle timestamps.

## Session breaks

A traditional equity feed has overnight and weekend gaps that are not missing data, and drawing a series as though time ran continuously through them is wrong twice over: it asserts the market was trading, and on 1-minute bars a 17-hour break drawn honestly is a thousand bars wide while a weekend is thirty screens of white.

So a break is shown as a break, and sized in **slots** rather than in hours. Every bar is one slot wide. A bar after a break is given extra slots, so the x transform stays affine — `x = offsetX + slot * scaleX` — and the shader, the vertex format, the vertex generators and every existing series are untouched. It is the same trick the log price scale uses on the other axis, and for the same reason: a non-affine transform would have to be reimplemented on both sides of the GPU boundary.

| Option | Default | Meaning |
|---|---|---|
| `timeScale.sessionBreaks.enabled` | `true` | Whether closed sessions are shown as breaks. `false` is the exact transform that shipped before the feature. |
| `timeScale.sessionBreaks.mode` | `'collapsed'` | `'collapsed'` gives every break half a bar. `'proportional'` gives each break width in proportion to its duration, up to the cap. |
| `timeScale.sessionBreaks.maxWhitespaceRatio` | `0.25` | Cap on the **total** whitespace, as a fraction of the series' bar count. |

Three properties are worth stating because they are the ones a caller is likely to depend on:

**The index API is unchanged in meaning.** The ordinal is still the identity of the series. `getVisibleLogicalRange()`, `getCandleAt(i)` and `indexToCoordinate(i)` all work exactly as before, and `getCandleAt` is unaffected by where gaps are. What changed is that the ordinal is no longer the *axis*: `indexToCoordinate` is no longer linear in `i`, and any caller that was treating a difference in indices as a distance in pixels must go through the coordinate methods instead.

**The wall-clock API is additive.** `timeToCoordinate(time)` and `coordinateToTime(x)` sit beside the index methods, and a time inside a break resolves to the bar on the nearer side — the only defensible answer for an instant the market was shut.

**Breaks are found from the data, not from a calendar.** The threshold is the *modal* interval times three. A mean would be the obvious choice and is wrong: one weekend in a week of 1-minute bars moves the mean to nearly ten minutes, and a chart that believed it was drawing 10-minute bars would draw a 17-hour gap as barely one of them. A session calendar is the more principled answer and is not used, because it is the thing that has to be per-exchange and per-holiday and is wrong the day a holiday moves.

The cap is on the total rather than per break, because the failure mode is cumulative: thirty individually reasonable breaks are still a chart of nothing. It is expressed in slots rather than pixels so it survives a resize instead of quietly changing meaning when the window does.

`priceScale` is a separate axis and shares only the tick generator.

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

### Gestures

| Gesture | Surface | Effect |
|---|---|---|
| Drag | the plot | pans horizontally, about the pointer |
| Wheel, pinch | the plot | zooms horizontally, about the pointer |
| Drag | the **price axis** (left gutter) | changes the price span vertically |
| Drag, pinch | the time axis (bottom gutter) | reserved; currently a pan |

A press on the left gutter is a vertical gesture and nowhere else is. It does not pan, it does not move the series, and it does not disturb the live-edge latch, so the two axes stay independent and a caller never gets one gesture's side effects along with the other's.

**The price-axis drag changes the price span, and it takes the vertical scale off `autoScale` to do it.** Dragging down expands and dragging up compresses, one pane height of travel for a factor of two, applied about the middle of the range — so the span is what moves and the middle is what stays. That is the same thing `setPriceRange` does, arrived at by dragging, and it goes through the same lock: the range survives every later append until `fitPriceRange()` hands the pane back to the auto-scaler. A drag of more than one pane height in a single gesture is clamped to a tenth or ten times the span, so the pointer cannot invert or flatten the axis, and dragging back out retraces the range exactly.

The arithmetic is in scale space, so on a log axis the drag scales the *ratio* `high / low` rather than the difference — a log pane's headroom is a ratio of log, which is the same reason the auto-fit applies its padding there. A press that does not travel past the same few-pixel slop as a pan is a click and changes nothing, so brushing the axis cannot silently take the scale away from the caller.

`setPriceRange([low, high])` sets that range directly, `fitPriceRange()` releases the lock, and `getPriceRange()` reports what the pane is currently showing. `getPriceRange()` and `coordinateToPrice()` agree at the pane edges to within float error, so a readout built on either matches the bars.

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
| `volume.visible` | boolean (additive in 1.x) | `false` |
| `volume.color` | CSS colour, applies to both directions | theme preset |
| `volume.upColor` / `volume.downColor` | CSS colour | theme preset |
| `volume.heightRatio` | number in (0, 1] (additive in 1.x) | `0.2` |
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
| `candlestick.style` | one of the six styles (additive in 1.x) | `'candlestick'` |
| `candlestick.baselinePrice` | non-negative number (additive in 1.x) | first visible close |
| `candlestick.lineColor` | CSS colour (additive in 1.x) | theme up colour |
| `candlestick.areaFillColor` | CSS colour (additive in 1.x) | up colour at 25% |
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

**`options().timeScale.barSpacing` is the live zoom, not the configured one.** After a wheel or pinch zoom, and after `setData`, it reports the spacing actually in effect — the effective value after clamping — so a readout bound to it always agrees with the bars. Read it, scale it, and apply the result to build a zoom button:

```ts
const next = chart.options().timeScale.barSpacing * 1.25;
chart.applyOptions({ timeScale: { barSpacing: next } });
```

The value written back into the options is the clamped one, so asking for a spacing past `maxBarSpacing` reports what was applied rather than what was asked for. Note that `setData` resets the zoom to the default spacing, so a chart constructed with a `barSpacing` other than the default reports the default once data is loaded.

**Time labels default to UTC** so they do not depend on the viewer's zone. `locale` and `timeZone` feed `Intl.DateTimeFormat` and `Intl.NumberFormat`; price labels use `precision` and locale separators.

**The plot is the canvas less two reserved gutters.** `layout.priceAxisWidth` (default 78) is reserved on the left for price labels and `layout.timeAxisHeight` (default 22) along the bottom for time labels. Both are CSS pixels, both are non-negative, and zero restores the old behaviour of drawing labels over the data. Every part of the geometry derives from one plot rect: the visible logical and time ranges, the live edge, the zoom anchor, the vertical fit, the grid lines, the axis frame, and the crosshair rules. Nothing measures the canvas directly to decide what is visible.

Series are **clipped to the plot rect** with a scissor box, so a bar scrolled part-way past an edge is cut at the plot boundary instead of painting over the price labels. Clipping is applied per draw and cleared afterwards, and the clear runs with clipping off so the gutters cannot retain stale pixels.

The gutter widths are a fixed size rather than measured from the label text, because the widest label depends on the visible price range, which depends on the plot height, which depends on the gutter. The default fits a separated price of up to six digits with two decimals; widen `priceAxisWidth` for instruments quoted with more digits.

**`candlestick.wickVisible: false`** skips generating and drawing the wick segments. **`borderVisible: true`** draws a 1 device-pixel frame inside the body outline and insets the fill to match, in the same indexed pass with no extra shader or draw call. The body is never grown, so the gutter between bars is unchanged, and the frame is skipped on bodies too small to hold it.

## Candle styles

`candlestick.style` selects how the same OHLC data is drawn. All six share one program, one uniform set, and one vertex format, and differ only in how vertices are generated and which primitive they draw, so switching costs a repaint and nothing else. They all share the horizontal transform, and the price scale does not move between the body-drawing styles.

| Style | Geometry |
|---|---|
| `candlestick` | Filled body between open and close, with a wick spanning low to high. The default. |
| `hollow` | Body left unfilled and framed in its own body colour, with the wick still drawn. The frame is implied and drawn whether or not `borderVisible` was asked for. |
| `ohlc` | No body. A vertical low-to-high line with a tick left of the bar at open and a tick right at close, each capped at half the bar gap. |
| `baseline` | A filled body plus one horizontal rule across the visible candles, at `baselinePrice` or the first visible close. |
| `line` | A polyline through the close of every candle, on the shared line series. |
| `area` | The same close polyline with the region beneath it filled down to the bottom of the plot. |

`hollow` separates the body fill from the wick colour: a transparent fill must not make the wick invisible, which is a real bug the vertical-extent assertion caught.

## Translucent series compositing

The data layer sits over an opaque grid layer, so its alpha is applied once by the GL blend and once more by the browser when the canvas is composited. The fragment shader therefore emits **premultiplied** colour and the context blends with `ONE, ONE_MINUS_SRC_ALPHA`. Blending with `SRC_ALPHA` instead squares the alpha channel against a transparent destination, which made a 25% area fill land at 6% and a 50% volume bar at 25%. Opaque colours are unaffected, so this changes only the translucent series.

The border is a frame of four strips, never a quad underneath the body. That matters for translucent fills: the fill always composites against the plot background, never against the border colour, so `borderVisible` cannot tint the interior of a candle. Verified by construction, since a body covered by the border quad would blend to the border's hue wherever the fill has alpha.

The frame is exactly one device pixel at any `devicePixelRatio`. Every body edge is resolved to a whole device pixel on the CPU and then emitted as the data value whose device position is that exact pixel, so the shader's `floor(device + 0.5)` snap is never near a rounding boundary. This is not a formality: a body edge landing on a whole CSS pixel puts `position * pixelRatio` on a half-integer at every odd-tenth ratio, where that snap is knife-edge, and the two edges of a one-pixel frame then round independently and produce a two-pixel or zero-pixel frame. The row is computed in `float32` to match the uniforms the GPU actually receives, because a `pixelRatio` such as `2.3` is not representable in `float32` and a row chosen in double precision can be the row the body was never drawn on.

## Series on the data layer

Every series drawn into the plot owns its own vertex array, vertex buffer, and index buffer, and draws from its own geometry. They did not used to: the renderer held a single vertex buffer, so two series could never both be resident and whichever uploaded last won. The visible symptom is narrower than one series disappearing — the candle series is re-uploaded on every viewport update, so a shared buffer is refilled with candle geometry before the next draw, and the corruption lands on whichever series did not upload last, drawing the other series' vertices under its own primitive.

All series share **one** program, one uniform set, and one vertex format: interleaved `[x, y, r, g, b, a]` in data coordinates with per-vertex colour. A series therefore differs only in how its vertices are generated and which primitive it draws, never in how a vertex is transformed, so a new series type cannot drift the transform out of step with the others.

The transform is device pixels in and device pixels out: the shader multiplies by the pixel ratio and divides by the backing store's resolution. There was a second program for lines that worked in CSS pixels against a device-pixel viewport, which placed line geometry in the top-left quarter of the canvas at any ratio above one. Unifying on the device-pixel transform is what makes a second series correct rather than merely present.

A series that measures something other than price sets **its own vertical transform** while continuing to share the horizontal one, because every series is indexed on the same time axis. The volume histogram uses this: its bars are scaled against the largest volume on screen, so a volume spike can never stretch the price axis.

## Volume and the histogram

`CandleData.volume` is **optional**, which is what keeps it additive — a required field is a breaking change. When present it must be a finite, non-negative number; a present-but-invalid volume is rejected as a malformed candle rather than quietly drawn as zero. An absent volume is stored as 0, so absent and a genuine zero are deliberately indistinguishable: both mean nothing to draw.

Volume is a channel on the candle record, not a separate series, so it is aggregated with the rest of the record. The rule is **sum**, in every path: a coarser bar covers more trades, so its traded size is the total of its members. This is the invariant that makes a coarser level honest, and it is asserted directly — the total volume of every level equals the full-resolution total. A reducer that sampled, took a maximum, or took the last value would all produce a plausible-looking pyramid and a wrong total.

`volume.visible` is `false` by default. When switched on, the histogram occupies the bottom `volume.heightRatio` of the plot and is drawn as its own series against its own scale, reading the same pyramid level as the candlesticks so the two cannot drift apart in time. A later release gives volume its own pane; `heightRatio` is what becomes that pane's height, and nothing about the scaling changes.

A present `volume` on the wire is validated and carried through by `WebSocketCandleSource`, and only carried when the wire carried it, so an absent volume stays absent rather than becoming a zero that reads like real data.

Recolouring reaches the GPU without touching the data: `applyOptions` repaints from the existing vertex buffers, and `getCandleCount()` is unchanged.

## Overlays on the shared time index

An overlay is **external values drawn against the candle time index**. There is no indicator maths in the library: an EMA, a band, or a stop level is computed elsewhere and arrives as plain points. This is deliberate — the maths belongs to whoever already owns it, and a second implementation would only be a second thing to keep correct.

`setOverlays(overlays)` replaces the whole set; each call is idempotent and the chart's overlay state is exactly what was last supplied. Passing an empty array removes every overlay and releases its buffers rather than leaving an invisible series alive. The whole set is validated before any of it is applied, so a rejected overlay leaves the chart exactly as it was rather than half-applied.

A point is `{ time, value }`, and `time` must match a candle timestamp **exactly**. Snapping to the nearest candle — which is what the coordinate layer does for a pointer position or an arbitrary timestamp — would let a misaligned overlay look correct, and a line drawn half a bar out of place is the kind of defect that reaches a trading desk rather than a bug report. An unmatched timestamp is refused, naming the offending time. Times must also strictly increase, and ids must be non-empty and unique.

**An indicator's warm-up is part of its shape.** Most indicators emit nothing until they have enough history, so a 21-period EMA over 1000 bars covers a suffix of the series, not all of it. The uncovered leading bars hold no value and are **not drawn**: treating them as zero would draw a line from price zero up to the first real value, which is the single most destructive thing an overlay could do to a chart. `getOverlayValueAt` returns `null` across the warm-up for the same reason, rather than a zero that reads like data.

An overlay is reduced to **the same buckets as the candle pyramid, at the factor the pyramid is currently drawing at**, and the bucket x is computed with the pyramid's own formula. The two are therefore not merely close at a given zoom, they are identical, and an overlay cannot drift from its candles as the chart zooms. A bucket takes the last value in its group, which is the conventional choice for a line and keeps the visible end anchored; it does drop intra-bucket extremes, so an overlay whose peaks matter more than its shape should be sampled at a finer level than the candles.

Interior omissions are **not** supported: a `LINE_STRIP` cannot express a break, so a value missing between two covered ones is drawn as a straight line across the gap. Indicators that emit a contiguous run, which is what a warm-up produces, are unaffected.

Line width is not exposed. WebGL only guarantees `lineWidth` of 1 and most implementations silently clamp anything larger, so an option that appeared to work and did not would be worse than its absence.

Overlays are drawn in the order supplied, over the candles.

### Interoperating with an indicator library

`OverlayPoint` is `{ time, value, color? }`, which is the shape an indicator library's per-plot point type has. A plot therefore satisfies `OverlaySpec.points` structurally, with no adapter and no dependency in either direction:

```ts
const output = myIndicator.calculate(bars, params);
chart.setOverlays(Object.entries(output.plots).map(([id, points]) => ({
    id,
    points,
    color: output.plotConfigs?.[id]?.color,
})));
```

`plotConfigs[].type` is not consulted in this release: an overlay is drawn as a line. An indicator whose plots are histograms wants its own pane rather than the price axis, which is a later phase. `plotConfigs[].lineWidth` is not honoured, for the reason above.

A point may carry its own `color`, which overrides the overlay's colour for that point and lets one overlay change colour along its length — a MACD histogram signed by side, a stop level that flips between bullish and bearish. This is honoured rather than declared-and-ignored, and it costs nothing for the common case: an overlay whose points are all one colour carries no per-point colour array at all, and the renderer expands the single colour itself.

## Panes

A pane is a horizontal band of the plot area with **its own vertical scale**. Pane 0 is the price pane and always exists. Every pane shares the *horizontal* transform, because every series is indexed on the same time axis; only the vertical one differs, which is why a series can be moved to a pane without anything about its data changing.

Panes are what let an indicator that does not measure price — an RSI, a MACD histogram — be drawn readably instead of being squashed into the price range.

`panes.weights` is one relative height per pane and is what **creates** them; a single pane filling the plot is the default, and is the behaviour without this feature. `panes.separatorHeight` (default 1 CSS pixel) is reserved between panes, and a single pane has nothing to separate from so it is never subtracted. `panes.separatorColor` defaults to the grid colour, so a division reads as part of the grid rather than as new chrome. A weight must be greater than zero, and a bad one is rejected rather than repaired.

`overlay.pane` selects the pane, defaulting to 0. **The pane must exist**: an overlay naming an index that was never declared is rejected, because silently drawing it on whichever pane now occupies that index would put an RSI on the price scale — the exact failure panes exist to prevent. A pane index is checked before any data work, so a typo is reported as a typo.

The same rule applies to `applyOptions`. Shrinking `panes.weights` under a supplied overlay is refused, and because the overlay specs are re-validated before the new options are adopted, **both** the options and the overlays are left exactly as they were.

Pane 0 keeps the viewport's price scale, so the price axis, the candles, and every price-derived coordinate are unchanged. Every other pane is fitted to the values actually on screen in it, read at full resolution rather than from the reduced buckets, so a pane's scale cannot clip a peak that is genuinely visible. A series in a pane is clipped to that pane rather than to the whole plot.

`getPaneCount()` reports the pane count. `getPaneValueRange(index)` reports what a pane is currently showing, low first, or `null` for an index that does not exist or for a pane with nothing on screen — so a caller labelling its own pane reads the same numbers the chart is drawing rather than recomputing them.

Two behaviours worth stating, because both are the alternative to something worse:

**A non-price pane is guaranteed several axis labels.** Sizing a tick step from a fixed pixel separation suits a tall pane and starves a short one: an RSI pane a quarter as tall as the price pane still spans its whole range in far fewer pixels, so a step chosen for 56px of separation rounds up past the pane's own range and leaves a single label on the axis — an RSI you cannot read a level off. The step is therefore walked *down* a 1/2/5 ladder until the pane carries at least four labels, because snapping *up* to that ladder is what defeats a minimum count.

**An empty pane is left unlabelled.** A pane with nothing on screen to scale to has a placeholder transform spanning 0 to 1, and labelling that would put a real-looking axis beside an empty chart. It is drawn, and it is not labelled.

`priceFormat.minMove` applies to the price pane only. It is the instrument's tradable increment, a property of prices; rounding an RSI pane's ticks to multiples of it would leave a pane spanning 0 to 100 labelled every hundredth.

Pane separators are not draggable in this release. Heights are an option, not an interaction.

## Decorations: price lines, the last price, and markers

These are **decorations, not series**. A price line has no volume, no aggregation, and no business being reduced by the pyramid; teaching the downsampler about them would mean every indicator output had to declare which kind of series it was before a single bar could be aggregated. They are drawn on the UI canvas, under the crosshair and beside the price gutter where the axis labels already live. Nothing here allocates a buffer.

`setPriceLines(lines)` replaces the whole set, as `setOverlays` does, and validates it before applying any of it: a rejected line leaves the existing set untouched. A line needs a unique non-empty `id` and a finite `price`; `lineWidth` is 1 to 4 CSS pixels, `lineStyle` is `solid` or `dashed` (defaulting to dashed, so an annotation does not read as the grid), `axisLabelVisible` defaults to true, and `title` and `axisLabelColor` are optional. Out-of-range values are rejected rather than clamped. `removePriceLine(id)` removes one and reports whether it was there. `getPriceLineIds()` reads the set back.

`setMarkers(markers)` replaces the marker set; `getMarkers()` reports each one with the ordinal its timestamp snapped to and the price it is drawn at; `clearMarkers()` removes them all.

**A marker snaps its time to the nearest candle; an overlay does not.** The distinction is density. An overlay is a continuous series whose whole shape depends on landing on the right bars, so an unmatched timestamp there is a bug worth refusing — a line drawn half a bar out of place reaches a trading desk. A marker is a single annotation, where the nearest bar is what a click between two bars meant. `getMarkers()` reports where each one went, so a caller can see the resolution rather than infer it.

Markers are drawn on the price pane, above or below the bar's high or low, or on its close. A marker's price is recomputed from its bar every frame, so one standing above a still-updating candle follows it.

**Markers are dropped entirely below four pixels per bar**, not shrunk. A marker is a fixed number of pixels wide, so a screen full of them at two pixels per bar is a smear, and an unreadable annotation is worse than an absent one. The positions are still readable through `getMarkers()` at any zoom.

The last-price rule and tag are **derived, not supplied**. Chart already knows the newest candle, so asking a caller to restate it would create a second source of truth that could disagree with the candles by one update. `getLastPrice()` reports the newest close and its direction, and the rule tracks the live edge because it is recomputed with the viewport rather than captured when the decorations were set. The tag is filled in the candle's up or down colour.

When two labels want the same strip of the price gutter, the resolution is **by priority, not by position**: the last-price tag outranks a price-line tag, which outranks an axis tick, and a kept label displaces anything within its own height of it. Sorting by y and thinning out what collides would drop whichever happened to be drawn first, which is not something a reader can predict; dropping the axis tick instead keeps the annotations the caller asked for. A price line scrolled off the price pane is not drawn at all, tag included, because a tag for a price that is not on screen reads as a price that is.

### Zones

A zone is a fixed price rectangle anchored to one candle and extending right — an order block, a breaker, a fair-value gap, a session range. It is candle-anchored rather than a band between two moving lines, because that is what these are: a zone belongs to a specific bar and does not move with price.

`setZones(zones)` replaces the whole set, validated before any of it is applied, so a rejected zone leaves the existing set untouched. `getZoneIds()` reads it back, including any zone left undrawn by the budget below. `clearZones()` removes them all.

A zone's `time` must match a candle **exactly**, unlike a marker's. A marker is a point, so being a bar out is invisible; a zone's left edge is a boundary, so snapping would displace the whole zone by a bar and quietly change which bar it claims to be. A timestamp is taken rather than an ordinal because ordinals shift under retention trimming and timestamps do not.

`top` and `bottom` default to the anchor candle's high and low, so a caller holding a bar and nothing else gets the conventional zone for it. Omitting `to` extends the zone to the right edge of the plot.

**One `color` gives the conventional fill and border pairing**: a low-alpha fill and a firmer border in the same hue. The ratio is the point — a border that fades along with the fill has no definition, which is the washed-out look the decoupling exists to fix. Override `fill` or `border` to change either, including their alpha. Borders are one CSS pixel with square corners, snapped to a device boundary; a 2px border or a rounded corner reads as a web control rather than an instrument.

A zone's `state` is **the caller's to decide**, because when a zone stops mattering is an analytical judgement about their own indicator. `live` is a filled box with a solid border. `mitigated` and `invalidated` fade to a faint dashed outline with no fill — the chart keeps its own history instead of resetting as the session runs, which is the alternative to hiding them, and a caller who wants them hidden can drop them from the set. The state is carried by the **border**, not by swapping the fill colour, so a zone that has stopped mattering recedes rather than raising a colour alarm.

**A zone that is no longer live should also stop being extended.** There is nothing in "this was violated thirty bars ago" that needs thirty bars of width, and a mitigated zone that still runs to the live edge is the single biggest source of clutter on a chart of zones. Set `to` to the candle it was violated at.

Zones are drawn on the **grid layer**, beneath the data layer, and painted before the grid lines. That is deliberate: a translucent fill there composites against the background only, and the candles composite on top at full opacity. A zone on the data layer would multiply over the candle pixels and tint them — the very look the fill and border decoupling exists to avoid.

Zones paint invalidated first, then mitigated, then live, each oldest first. A mitigated zone must sit *under* the live ones: a faint dashed outline drawn on top of a live fill puts the quietest thing in the chart over the loudest.

Drawing is capped, because translucent fills compound where they overlap and a few hundred stacked zones turn the plot into mud. Over the cap, **every live zone is kept** and the remaining budget goes to the most recent mitigated ones — dropping the oldest *live* zone would drop the most visually dominant thing on the chart, since a live zone extends right across everything.

A zone scrolled off the top or bottom of the price pane is not drawn at all. A zone partly off screen is clipped to the plot rect and never paints over the price gutter.

## Feed v1

Use `WebSocketCandleSource` + `ChartFeedController` against a `CandleTarget` (`Chart` implements this). Do not open sockets inside renderers.

Message types: `snapshot`, `update`, `append`, `heartbeat`. Sequences are non-negative safe integers and increase once per message. Snapshot is authoritative. Gaps pause deltas and emit `{"type":"resync","afterSequence":n,"reason":"..."}`. Heartbeats must arrive more often than the client timeout. Reconnect backoff is capped; v1 retries indefinitely.

A candle field that is not a finite number is rejected at the transport boundary and requests a snapshot. `JSON.parse` turns an out-of-range literal such as `1e999` into `Infinity`, which is a `number` but not a usable price or timestamp, so it is rejected like any other malformed field rather than passed downstream for a consumer to catch. A malformed frame requests a resync once; further bad frames do not re-send it while one is already pending.

`MockCandleSource` is a development source, not a production protocol.

## Breaking vs additive

**Breaking:** changing `CandleData` field units; adding required fields; new required feed message types for a working live chart; removing any export in the table above; changing the package entry or its `exports` conditions; changing mutation ordering rules; changing the half-open index range or inclusive time range conventions; making a conversion depend on `devicePixelRatio`; changing when an event fires or what a `null` field means; making `maxRetainedCandles` settable at runtime; changing a resolved default or a validation rule; changing the WebGL2 or post-destroy error strings, or what `destroy()` removes; removing or reinterpreting the index-space read API; dropping the WebGL2 requirement without a replacement renderer.

**Additive (allowed in 1.x):** extra optional `ChartOptions`; new `Chart` methods; optional feed fields the v1 client ignores; extra exports.
