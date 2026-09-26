# Production Readiness

## Data Contract

`CandleData.time` is a Unix timestamp in milliseconds (UTC). Use `Date.UTC(...)` or epoch milliseconds from the provider; do not pass local-time strings or seconds. Input series must have strictly increasing timestamps. Corrections are only accepted for the current last candle through `updateLast()`. Historical corrections require an authoritative `replaceData()`/snapshot.

The horizontal coordinate is the candle's ordinal index, not elapsed wall-clock time. Therefore closed intervals with no candles (overnight sessions, weekends, and holidays) are compressed. Axis and crosshair labels snap to real candle timestamps; they do not interpolate timestamps through those closed intervals.

The chart does not apply exchange calendars, daylight-saving rules, session breaks, or synthetic gap candles. Feed adapters/providers must define session boundaries and repair missing bars before sending a snapshot or append. Missing market intervals remain missing; the chart never invents OHLC values.

## Retention and Memory

`new Chart(containerId, { maxRetainedCandles })` bounds chart history. The default is 1,000,000 candles. When the limit is exceeded, the oldest candles and their timestamps are removed, and the OHLC pyramid is rebuilt from retained data. Live-follow remains at the right edge. Historical views retain their data-space position while those bars remain; if history is evicted, the view clamps to retained data.

The limit applies to retained chart data. Providers may also hold their own snapshots/queues, so production adapters should bound those independently.

## Feed Operation

Use `WebSocketCandleSource` with `ChartFeedController`; do not put sockets in renderers or `Chart`. See [feed-adapters.md](feed-adapters.md) for the wire protocol. Production deployments should use `wss://`, authenticate through the hosting application's established mechanism, and avoid putting credentials in URLs.

The server must send a snapshot after subscribe, sequence every data and heartbeat message, answer resync requests with an authoritative snapshot, and send heartbeats more frequently than the configured timeout. Reconnect backoff is capped but currently retries indefinitely. No client-side missing-bar synthesis is performed.

## Verification

Run the deterministic suite and benchmark:

```powershell
pnpm test
pnpm benchmark
npx tsc --noEmit
```

For the real WebGL/browser integration, start Vite with `pnpm run dev`, then open `/tests/browser/streaming.e2e.html`. A successful run sets `data-test-result="pass"` and checks chart retention, sequence-gap recovery, timestamp-anchor preservation, WebGL draw calls, and GL error state.

The benchmark reports OHLC pyramid build time, append/update throughput, p95 1,000-candle batch time, and Node memory while trimming back to the configured retention cap after each batch. On the current development machine, 100,000 appended candles with one update each and a 100,000-candle cap measured about 118,000 candles/s, 11.82 ms p95 per 1,000-candle batch, and 72.8 MiB RSS. These are reference measurements, not universal guarantees.

Initial production targets are: no unbounded retained chart history; no lost/duplicated candle mutations across tested reconnects; p95 feed apply and retention trim below 16.6 ms per animation frame on the supported reference desktop; and zero WebGL errors during the browser integration run. The current 100k bounded-history benchmark is below that 60 Hz frame budget. Re-baseline performance on each supported browser/device class before treating those numbers as service-level guarantees.
