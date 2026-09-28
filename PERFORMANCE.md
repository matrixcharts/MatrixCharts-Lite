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

The four changes below were measured individually rather than inferred from this
table, at the default 1,000,000-candle retention. The workload above holds 35,000
candles and never reaches the retention cap, so it does not exercise the third, and it
supplies no overlays, so it does not exercise the fourth.

| Operation | Before | After |
| --- | ---: | ---: |
| `modalInterval` derivation, 1,000,000 bars | 32.0 ms | once per data change |
| `OHLCPyramid.trimStart(500)`, 1,000,000 bars | 34.9 ms | 0.005 ms |
| `OHLCPyramid.trimStart(500)`, 50,000 bars | 1.72 ms | 0.005 ms |
| `appendOverlayValue` | not available | ~4 us per value |
| `setOverlays` re-supply, 4,000 values | 390.6 ms | n/a |
| 32 overlays reduced per frame, 50,000 bars | 11.7 ms | 0.47 ms |

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

## Overlays were reduced over the whole series, every frame

The candle path has always been culled: the engine slices the pyramid to the buckets the
plot covers, so its cost tracks the screen rather than the history. Overlays were not. On
every frame, for every overlay, the engine re-reduced the **entire** retained series and
uploaded all of it — including the tens of thousands of bars scrolled off the left edge,
which the GPU clips anyway.

`uploadVisibleOverlays` passed `candlePyramid.candleCount` as the range, thirty lines below
where the same method had already computed the visible window for the candles. One
argument was the whole difference.

Per frame, 32 indicators, 800 bars on screen:

| Retained bars | Before, one colour | Before, 1 in 4 coloured | After | Share of the 16.67 ms budget |
| --- | ---: | ---: | ---: | ---: |
| 50,000 | 11.7 ms | 16.5 ms | 0.47 ms | 3.0% |
| 200,000 | 49.3 ms | 64.0 ms | 0.48 ms | 3.0% |
| 1,000,000 | out of memory | out of memory | 0.50 ms | 3.0% |

At 50,000 bars the old path was one frame from missing 60 Hz with the plain case, and
**over** it at 16.5 ms once a quarter of the indicators carried a per-point colour — the
MACD-histogram case. At 1,000,000 bars it exhausted the heap, because 32 coloured
overlays at full width is 3.9 GB of per-point colour buffers.

The cull is a one-line change of argument, and it is free: the work is the same reduction,
over a narrower range. The buffer is now sized from the emitted window rather than from
`sourceCount`, since allocating a full-length buffer per overlay per frame would leave the
O(history) cost on the allocation side after removing it from the write side.

Three properties are asserted rather than assumed, in `Overlays.test.cjs`:

- **A culled reduction is a contiguous slice of the full reduction**, at factors 1, 2, 4, 8
  and 16. Every emitted bucket must be the same bucket the full reduction emitted, carrying
  the same value. This is the test that catches a cull which shifts an indicator off the
  candles it annotates — the failure would be a moving average half a bar out, invisible
  until the chart is panned.
- **The range is clamped to the covered window and widened by a bucket at each end**, so an
  overlay entering from off-screen still reaches the plot edge, and a warm-up still starts
  partway across the chart rather than trailing in from the left.
- **A trimmed series still buckets on the absolute grid.** Derived from the absolute grid
  rather than compared against a rebuild, because a rebuild *re-cuts* and would assert the
  opposite of what is intended.

Six of the eight new tests fail against the pre-fix code. The two that pass are the
one-bar widening and the off-window guard, which are invariants the fix preserved rather
than behaviour it added.

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
