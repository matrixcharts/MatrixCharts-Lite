# Production Readiness

The public v1 data, mutation, export, and WebGL2 rules are frozen in [v1-contract.md](v1-contract.md). This page covers operational limits for production feeds.

Rendering requires WebGL2. The chart throws if the data canvas cannot acquire a `webgl2` context.

## Data Contract

`CandleData.time` is a Unix timestamp in milliseconds (UTC). Use `Date.UTC(...)` or epoch milliseconds from the provider; do not pass local-time strings or seconds. Input series must have strictly increasing timestamps. Corrections are only accepted for the current last candle through `updateLast()`. Historical corrections require an authoritative `replaceData()`/snapshot.

The horizontal coordinate is the candle's ordinal index, not elapsed wall-clock time. Therefore closed intervals with no candles (overnight sessions, weekends, and holidays) are compressed. Axis and crosshair labels snap to real candle timestamps; they do not interpolate timestamps through those closed intervals.

The chart does not apply exchange calendars, daylight-saving rules, session breaks, or synthetic gap candles. Feed adapters/providers must define session boundaries and repair missing bars before sending a snapshot or append. Missing market intervals remain missing; the chart never invents OHLC values.

## Retention and Memory

`new Chart(container, { maxRetainedCandles })` bounds chart history. `container` is an `HTMLElement` or its document id. The default is 1,000,000 candles. When the limit is exceeded, the oldest candles and their timestamps are removed, and the OHLC pyramid is rebuilt from retained data. Live-follow remains at the right edge. Historical views retain their data-space position while those bars remain; if history is evicted, the view clamps to retained data.

The limit applies to retained chart data. Providers may also hold their own snapshots/queues, so production adapters should bound those independently.

## Feed Operation

Use `WebSocketCandleSource` with `ChartFeedController`; do not put sockets in renderers or `Chart`. See [feed-adapters.md](feed-adapters.md) for the wire protocol. Production deployments should use `wss://`, authenticate through the hosting application's established mechanism, and avoid putting credentials in URLs.

The server must send a snapshot after subscribe, sequence every data and heartbeat message, answer resync requests with an authoritative snapshot, and send heartbeats more frequently than the configured timeout. Reconnect backoff is capped but currently retries indefinitely. No client-side missing-bar synthesis is performed.

## Verification

Run the deterministic suite and benchmark:

```powershell
npm test
npm run benchmark
npm run verify:package
```

For the real WebGL/browser integration, run `npm run dev`, then open `/index.html` for the demo and `/tests/browser/streaming.e2e.html` for the integration run. A successful run sets `data-test-result="pass"` and checks chart retention, sequence-gap recovery, timestamp-anchor preservation, both `HTMLElement` and element-id construction, the public read API including its empty and off-screen edge cases, the public event API (hover snapping, leave, click, pan-is-not-click, range coalescing, sub-bar silence, unsubscribe, and no handlers after `destroy()`), and `applyOptions` (GPU recolouring without touching the data, override survival across a theme change, rejection of invalid values without mutation, zoom clamping to `minBarSpacing`/`maxBarSpacing`, price precision, locale, `timeZone`, and the wick and border flags), plus filled candle pixels measured on the main chart's own context and GL error state.

The overlay run adds: rejection of a timestamp that matches no candle, that a refused overlay leaves the existing set untouched, that `getOverlayValueAt` returns `null` across an indicator's warm-up, that the overlay's first drawn pixel sits on its first covered candle at three zoom levels, that both per-point colours reach the screen, and that clearing the set releases the overlays.

Two runner limits are worth knowing. WebGL clears the drawing buffer once a frame is composited, so pixel assertions must sample inside the draw call rather than reading the canvas afterwards. A read taken partway through a frame is also partial, because the passes draw in turn; the overlay colour check accumulates the union across several frames so a pass that draws nothing contributes nothing. And the harness drives `requestAnimationFrame` from a timer, because a window that is not visibly rendering throttles it to zero and any await on it then stalls indefinitely. And the headless browser used to run this page does not deliver `ResizeObserver` notifications at all, even for a plain observer on an element present at load. That is why sizing is not asserted by waiting for the observer: it is asserted through the render-time re-check, which is the mechanism that has to work when the observer does not. A container attached late, and a container resized while the chart is idle, are both attached and then grown with a zoom as the render trigger, and the backing store must match the container at the current device pixel ratio.

The run also covers the WebGL2 requirement directly, by stubbing `getContext` to return `null` for `webgl2`: the constructor must throw exactly `MatrixCharts: WebGL2 is required.`, must leave the caller's container with no canvases and no wrapper element, must not disturb markup the caller put in that container, and a subsequent construction after the stub is removed must mount normally.

Teardown is asserted as a contract rather than assumed: `destroy()` must remove the chart's three layers but leave sibling markup the caller placed in the same container, and all 24 public entry points, reads and subscriptions included, must then throw exactly `MatrixCharts: This chart has been destroyed.` with `destroy()` itself staying idempotent.

Re-entrancy is asserted too. A `visibleRangeChange` and a `crosshairMove` handler that both restyle the chart from inside the callback must not be able to drive an unbounded event loop, and the chart must still work once the handlers stop.

Border rendering is asserted as geometry, not just as "some pixels changed". On a single large-bodied candle the e2e checks that the border covers exactly the perimeter of the body rectangle, `2 * (width + height) - 4`, which also proves no pixel is covered twice; that the outer bounds are identical with and without a border, so the bar gutter is preserved; that the frame is continuous along the top edge; and, with a translucent fill, that the interior still composites against the background instead of picking up the border colour. That last case was a real defect: the border was originally one quad drawn under the body, so a translucent fill blended with the border colour across the whole candle. The opaque-colour assertions in place at the time did not catch it.

The frame is also swept across `devicePixelRatio` rather than checked at whatever ratio the test browser happens to have, which is how a second defect surfaced: at odd-tenth ratios the top strip came out two device pixels thick, and at one ratio it collapsed to nothing. The single-ratio check that existed passed throughout, because the ratio it used was one of the ones that works. Each configuration asserts the frame is exactly the perimeter, that no frame pixel lands inside the body, and that the body bounds and total footprint match the border-off render, so a frame that is merely *present* is never mistaken for a frame that is *correct*.

The six candle styles are asserted by the *shape* of what each draws rather than by a colour, since a colour census cannot tell an outline from a filled body. A hollow candle must be markedly lighter than the filled body it replaces; the baseline rule must produce a horizontal run spanning at least half the plot, where a bar-shaped style produces a run of bar width; the line must produce no run wider than an eighth of the plot; the area fill must be part-alpha and must extend below the line; and the three body-drawing styles must share a vertical extent, so switching style cannot quietly move the price scale. The hollow assertion earned its place: it caught the wick being drawn in the transparent fill colour, which made hollow candles silently wick-less.

Translucency is asserted in the same pass. The area fill must contain part-alpha pixels, which is what distinguishes a fill from an opaque body and would have failed while the blend function was squaring alpha.

Volume is asserted as a data invariant, not as a picture. Every pyramid level's total volume must equal the full-resolution total, and a single large spike must still be present in the coarsest bucket; those two catch a sampled or max-reducing aggregator, which would otherwise produce a plausible-looking pyramid with a wrong total. The feed path is asserted too, because a `volume` on the wire is carried by an explicit field list and a transport boundary that reconstructs the object will silently drop anything it does not name — the integration test reported a total of `0` until the parser was taught the field. The e2e then checks the bars exist, that the spike reaches the top of its strip (proving they are scaled against the peak rather than the price range), and that the read-back total matches the source.

Multiple series on one layer are asserted by drawing a real second series and reading both. The e2e uploads a polyline in a colour no theme uses, then checks the line drew its own pixels, that those pixels start to the right of the price gutter, that the candle bodies are pixel-identical before and after, and that the line sits in the middle vertical band of the buffer. That last check is what pins the device-pixel transform: a line placed in CSS pixels against a device-pixel viewport lands near the top quarter instead, which is exactly what the retired second program did at any ratio above one.

Overlays are asserted for alignment rather than for presence, because an overlay that draws *somewhere* is easy and one that draws in the *right* place is the whole requirement. The pure test compares the overlay's bucket x against the pyramid's own level x for every level, at counts that are and are not powers of two — a trailing partial group is where two plausible x formulas disagree — and for a warm-up suffix, where the overlay is offset from the level's start and only the surviving points must still land on the candles they share buckets with. That test is worth more than the pixel check, since it covers the aggregated levels where drift would actually appear without depending on a zoom threshold. The e2e then confirms the same property end to end: it locates the leftmost pixel of the overlay's colour and requires it to sit on the first covered candle, at three bar spacings, to within half a bar. That measurement also caught a units error in the test itself — `indexToCoordinate` is canvas-relative, not plot-relative, so adding the gutter shifted the expectation by exactly the gutter width.

Getting that e2e right took three attempts, and each earlier version would have passed while testing nothing. The first used a 400-bar series, which put the chart at the live edge with the warm-up scrolled off-screen, so the assertion was measuring where the overlay was *clipped* and the expected coordinate was thousands of pixels off screen. A guard now refuses to run unless the first covered bar is actually on screen, so the test cannot silently degrade into measuring clipping again.

Axis gutters are asserted by reading both layers at once, because neither layer alone can show the defect. The data layer must have **zero** pixels inside either gutter, which is what proves the scissor box is actually applied rather than merely configured, and the axis layer must have ink inside both gutters, which proves the labels moved out of the plot. Introducing the gutters without clipping passes every unit test and fails only this check: a bar scrolled part-way past the left edge keeps painting over the price labels. That was a real defect found this way, and the same measurement caught a units bug in the check itself, where a CSS-pixel threshold was compared against device pixels and so silently halved at `dpr 2`.

## Known coverage limits

**The benchmark does not measure the renderer.** `benchmarks/sustained-feed.cjs` imports only `OHLCPyramid` and never constructs a chart, a renderer, or a GL context. Its `candlesPerSecond`, `batchP95Ms`, and `rssMiB` therefore say nothing about per-frame vertex generation, which is the hot path the geometry, border, clipping, and series work all touch. Run-to-run spread on a shared machine is large enough (78k-113k candles/s observed) that a change to those numbers cannot be attributed to code. There is no benchmark covering renderer frame cost, and p95 sits near the 16.6 ms budget of a 60 Hz frame, so that gap matters.

Two things are deliberately not covered, and should not be read as verified:

**WebSocket wire behaviour.** `WebSocketCandleSource` is tested against a fake that implements the browser `WebSocket` interface, which covers connect, subscribe, message routing, sequencing, gaps, resync, reconnect backoff, and heartbeat timeout. What is not covered is real network framing: partial frames, permessage-deflate, a proxy that mutates frames, or a server that closes uncleanly. Hand-rolling a WebSocket server to test this was judged a poor trade against the bug surface it would add to the suite; a single integration test against a real server in a separate harness is the better place for it.

**Renderer parity.** There is no Canvas2D candlestick renderer in v1, so there is nothing to compare the WebGL output against. The body-width math a fallback would need is already shared and unit tested in `CandlestickLayout.test.cjs`, but pixel parity between the two renderers is unverified because the second renderer does not exist. That check belongs to the fallback milestone.

`npm test` also covers `src/core/options.ts` and `src/core/coordinates.ts` directly, since both are pure: colour parsing and clamping, validation messages, deep-merge and theme-preset precedence, the float-epsilon rule behind `visibleRangeChange`, conversion invertibility, DPR independence, live-edge framing, visible-range rounding, and gap-snap time lookup.

Time labels default to UTC so they do not vary with the viewer's zone. Set `locale` and `timeZone` to change that.

`npm run verify:package` builds the dual package, packs it, and asserts the published artifact without network access: the tarball file list, the per-condition `exports` map, `require()` and `import` of the installed package, that the ESM entry has no extensionless specifiers, that ESM and CommonJS consumers both type-check against the shipped declarations, and that a deep import of an internal module is rejected.

The benchmark reports OHLC pyramid build time, append/update throughput, p95 1,000-candle batch time, and Node memory while trimming back to the configured retention cap after each batch. On the current development machine, 100,000 appended candles with one update each and a 100,000-candle cap measures roughly 96,000-113,000 candles/s, a p95 of 13-18 ms per 1,000-candle batch, and 60-90 MiB RSS. These are reference measurements, not universal guarantees.

Initial production targets are: no unbounded retained chart history; no lost/duplicated candle mutations across tested reconnects; p95 feed apply and retention trim at or below 16.6 ms per animation frame on the supported reference desktop; and zero WebGL errors during the browser integration run.

The p95 target is currently **met only intermittently**: repeated runs land between about 13 ms and 18 ms, so a 1,000-candle batch straddles the 60 Hz frame budget rather than sitting comfortably inside it. Treat the batch size as the tuning knob, not the frame rate: a feed that sends fewer candles per frame stays inside the budget, and the chart already batches mutations onto a single animation frame. Re-baseline on each supported browser and device class before treating any of these numbers as a service-level guarantee.
