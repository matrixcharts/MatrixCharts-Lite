export interface CandleData {
    /** Unix timestamp in milliseconds; timestamps must be strictly increasing. */
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}