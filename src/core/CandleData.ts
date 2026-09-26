export interface CandleData {
    /** Unix timestamp in milliseconds. Series timestamps must be strictly increasing. */
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    /**
     * Traded volume. Additive in 1.x and therefore optional: a required field
     * would be a breaking change. Must be a finite, non-negative number when
     * present; absent is stored as 0, which is also how a genuine zero reads.
     *
     * Supplying it enables the histogram series, which is off by default.
     */
    volume?: number;
}