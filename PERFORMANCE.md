# Performance Baseline

Recorded: 2026-09-28
Browser: Headless Chrome 154.0.0.0
Device pixel ratio: 1
Backend: WebGL2 through Puppeteer with SwiftShader

## Renderer Benchmark

Command:

```powershell
pnpm dev
pnpm benchmark:renderer
```

Workload:

- Initial candles: 20,000
- Appended candles: 15,000
- Append batch size: 500
- Append batches: 30
- Retention limit: 50,000 candles
- Frame budget: 16.67 ms at 60 Hz

Measured baseline:

| Metric | Result |
| --- | ---: |
| Measured animation callbacks | 86 |
| Frame p50 | 0.10 ms |
| Frame p95 | 4.30 ms |
| Frame p99 | 6.20 ms |
| Frame maximum | 7.90 ms |
| Frames over 16.67 ms | 0 |
| WebGL draw calls | 90 |
| Buffer uploads | 120 |
| Uploaded buffer bytes | 826,560 |

Run-to-run variance on this machine is around 0.5 ms at p95, so treat a difference
under that as noise.

## What changed, and why the numbers moved

The three changes below were measured individually rather than inferred from this
table, at the default 1,000,000-candle retention. The workload above holds 35,000
candles and never reaches the retention cap, so it does not exercise the third.

| Operation | Before | After |
| --- | ---: | ---: |
| `modalInterval` derivation, 1,000,000 bars | 32.0 ms | once per data change |
| `OHLCPyramid.trimStart(500)`, 1,000,000 bars | 34.9 ms | 0.005 ms |
| `OHLCPyramid.trimStart(500)`, 50,000 bars | 1.72 ms | 0.005 ms |
| `appendOverlayValue` | not available | ~4 us per value |
| `setOverlays` re-supply, 4,000 values | 390.6 ms | n/a |

`trimStart` is flat across a 20x range of series lengths, which is the property the head
offset was for: it advances a per-level window and recomputes the one bucket per level
that straddles the cut, so its cost does not depend on the series length. A level is
rebuilt only when a trim is larger than that level's group size, which bounds the
rebuilds to the size of the trim rather than the size of the series.

`modalInterval` sorts every gap in the retained series, and the time axis needs it on
every frame to pick a step from the calendar ladder. At the default retention that
exceeded the 60 Hz budget on its own, before any rendering happened. It is now derived
once per data change and handed to the axis.

`setOverlays` re-validates and re-aligns every point of every overlay on every call, so
feeding it one value per tick is quadratic in the number of values. `appendOverlayValue`
is the O(1) alternative and is the path a live indicator should use.

## Still O(n) on the retention path

Two of the three retention operations are not yet O(1), and are named here so they are
not mistaken for fixed:

| Operation | 50,000 bars | 100,000 bars | 1,000,000 bars |
| --- | ---: | ---: | ---: |
| `candleTimes.splice(0, 500)` | 0.007 ms | 0.019 ms | 0.60 ms |
| `trimSlotOffsetsIncremental(500)` | 0.21 ms | 0.48 ms | 2.83 ms |

Together about 3.4 ms at a million bars against a 16.67 ms budget, and under 0.5 ms at
the hundred-thousand-candle setting this benchmark uses. Both need a head offset — in
the times array and in the slot table respectively — and the slot table's binary
searches would have to carry it, which is why neither is a small change.

## Interpretation

The frame timings measure work performed inside the chart's animation callbacks. The
benchmark also counts WebGL draw calls and buffer uploads. These numbers are a baseline
for this browser, GPU backend, device-pixel ratio, and workload; compare repeated runs
under the same conditions rather than treating them as universal limits.

The Node benchmark remains separate:

```powershell
pnpm benchmark
```

It measures pyramid and retention throughput, not renderer or GPU frame cost.
