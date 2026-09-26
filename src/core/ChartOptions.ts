export type ChartTheme = 'dark' | 'paper';

export interface ChartOptions {
    /** Maximum number of newest candles retained in chart memory. Defaults to 1,000,000. */
    maxRetainedCandles?: number;
    /** Plot presentation. Defaults to dark. */
    theme?: ChartTheme;
}