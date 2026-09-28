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
| Measured animation callbacks | 89 |
| Frame p50 | 0.10 ms |
| Frame p95 | 6.10 ms |
| Frame p99 | 7.60 ms |
| Frame maximum | 8.20 ms |
| Frames over 16.67 ms | 0 |
| WebGL draw calls | 90 |
| Buffer uploads | 120 |
| Uploaded buffer bytes | 826,560 |

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
