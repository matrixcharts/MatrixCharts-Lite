import type { CandleData } from '../core/CandleData.js';
import type { CandleFeedMessage, CandleSource, CandleSourceState, CandleTarget, FeedDiagnostics } from './CandleSource.js';

export class ChartFeedController {
    private readonly unsubscribe: () => void;
    private disposed: boolean = false;
    private diagnostics: FeedDiagnostics = {
        received: 0,
        applied: 0,
        rejected: 0,
        lastSequence: null,
        lastMessageType: null,
        lastError: null,
    };
    private diagnosticHandlers: Set<(diagnostics: FeedDiagnostics) => void> = new Set();

    constructor(
        private readonly chart: CandleTarget,
        private readonly source: CandleSource,
        private readonly onStateChange: (state: CandleSourceState) => void = (): void => undefined,
        private readonly onError: (error: unknown) => void = (error: unknown): void => {
            console.error('MatrixCharts feed message rejected:', error);
        },
    ) {
        this.unsubscribe = source.subscribe(this.handleMessage, this.onStateChange);
        source.start();
    }

    public get state(): CandleSourceState {
        return this.source.state;
    }

    public getDiagnostics(): FeedDiagnostics {
        return { ...this.diagnostics };
    }

    public subscribeDiagnostics(handler: (diagnostics: FeedDiagnostics) => void): () => void {
        this.diagnosticHandlers.add(handler);
        handler(this.getDiagnostics());
        return () => this.diagnosticHandlers.delete(handler);
    }

    private emitDiagnostics(): void {
        const snapshot = this.getDiagnostics();
        for (const handler of Array.from(this.diagnosticHandlers)) handler(snapshot);
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribe();
        this.source.stop();
    }

    private handleMessage = (message: CandleFeedMessage): void => {
        if (this.disposed) return;
        this.diagnostics.received++;
        this.diagnostics.lastSequence = message.sequence;
        this.diagnostics.lastMessageType = message.type;
        try {
            if (message.type === 'snapshot') {
                this.chart.replaceData(message.candles);
            } else if (message.type === 'append') {
                this.chart.appendBatch(message.candles);
            } else if (message.type === 'update') {
                const candle: CandleData = message.candle;
                this.chart.updateLast(candle);
            }
            this.diagnostics.applied++;
        } catch (error: unknown) {
            this.diagnostics.rejected++;
            this.diagnostics.lastError = error instanceof Error ? error.message : String(error);
            this.onError(error);
            this.source.requestSnapshot?.('Chart rejected feed data.');
        }
        this.emitDiagnostics();
    };
}
