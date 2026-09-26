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

Two runner limits are worth knowing. WebGL clears the drawing buffer once a frame is composited, so pixel assertions must sample inside the draw call rather than reading the canvas afterwards. And the headless browser used to run this page does not deliver `ResizeObserver` notifications at all, even for a plain observer on an element present at load, so backing-store sizing is only asserted for a container that already has a size at construction; the late-attach path is not asserted there.

`npm test` also covers `src/core/options.ts` and `src/core/coordinates.ts` directly, since both are pure: colour parsing and clamping, validation messages, deep-merge and theme-preset precedence, the float-epsilon rule behind `visibleRangeChange`, conversion invertibility, DPR independence, live-edge framing, visible-range rounding, and gap-snap time lookup.

Time labels default to UTC so they do not vary with the viewer's zone. Set `locale` and `timeZone` to change that.

`npm run verify:package` builds the dual package, packs it, and asserts the published artifact without network access: the tarball file list, the per-condition `exports` map, `require()` and `import` of the installed package, that the ESM entry has no extensionless specifiers, that ESM and CommonJS consumers both type-check against the shipped declarations, and that a deep import of an internal module is rejected.

The benchmark reports OHLC pyramid build time, append/update throughput, p95 1,000-candle batch time, and Node memory while trimming back to the configured retention cap after each batch. On the current development machine, 100,000 appended candles with one update each and a 100,000-candle cap measured about 118,000 candles/s, 11.82 ms p95 per 1,000-candle batch, and 72.8 MiB RSS. These are reference measurements, not universal guarantees.

Initial production targets are: no unbounded retained chart history; no lost/duplicated candle mutations across tested reconnects; p95 feed apply and retention trim below 16.6 ms per animation frame on the supported reference desktop; and zero WebGL errors during the browser integration run. The current 100k bounded-history benchmark is below that 60 Hz frame budget. Re-baseline performance on each supported browser/device class before treating those numbers as service-level guarantees.
