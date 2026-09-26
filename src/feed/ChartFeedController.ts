import type { CandleData } from '../core/CandleData';
import type { CandleFeedMessage, CandleSource, CandleSourceState, CandleTarget } from './CandleSource';

export class ChartFeedController {
    private readonly unsubscribe: () => void;
    private disposed: boolean = false;

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

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribe();
        this.source.stop();
    }

    private handleMessage = (message: CandleFeedMessage): void => {
        if (this.disposed) return;
        try {
            if (message.type === 'snapshot') {
                this.chart.replaceData(message.candles);
            } else if (message.type === 'append') {
                this.chart.appendBatch(message.candles);
            } else if (message.type === 'update') {
                const candle: CandleData = message.candle;
                this.chart.updateLast(candle);
            }
        } catch (error: unknown) {
            this.onError(error);
            this.source.requestSnapshot?.('Chart rejected feed data.');
        }
    };
}
