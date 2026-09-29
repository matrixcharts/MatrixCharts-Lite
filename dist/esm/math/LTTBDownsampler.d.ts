/** Reduces an interleaved [x, y, x, y, ...] series with Largest-Triangle-Three-Buckets. */
export declare class LTTBDownsampler {
    /** Builds progressively coarser OHLC levels while preserving each bucket's extrema. */
    static buildOHLCPyramid(candles: Float32Array): Float32Array[];
    static downsample(points: Float32Array, targetPointCount: number): Float32Array;
    /**
     * Aggregates an interleaved [x, open, high, low, close, width, volume]
     * series to a target candle count. Unlike LTTB (which drops points), this
     * fuses buckets into larger timeframe candles to perfectly preserve all
     * extreme highs and lows.
     *
     * Unused by any production path. The pyramid's own multi-resolution levels
     * serve every zoom, so this single-target variant has no caller; it is kept
     * only if a future caller needs an arbitrary candle count rather than a
     * power-of-two level.
     */
    static downsampleOHLC(candles: Float32Array, targetCandleCount: number): Float32Array;
}
//# sourceMappingURL=LTTBDownsampler.d.ts.map