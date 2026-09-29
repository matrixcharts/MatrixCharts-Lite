import type { CandleSource, CandleSourceState, CandleTarget, FeedDiagnostics } from './CandleSource.js';
export declare class ChartFeedController {
    private readonly chart;
    private readonly source;
    private readonly onStateChange;
    private readonly onError;
    private readonly unsubscribe;
    private disposed;
    private diagnostics;
    private diagnosticHandlers;
    constructor(chart: CandleTarget, source: CandleSource, onStateChange?: (state: CandleSourceState) => void, onError?: (error: unknown) => void);
    get state(): CandleSourceState;
    getDiagnostics(): FeedDiagnostics;
    subscribeDiagnostics(handler: (diagnostics: FeedDiagnostics) => void): () => void;
    private emitDiagnostics;
    dispose(): void;
    private handleMessage;
}
