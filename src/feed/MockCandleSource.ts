import type { CandleData } from '../core/CandleData';
import type { CandleFeedMessage, CandleSource, CandleSourceState } from './CandleSource';

type FeedListener = (message: CandleFeedMessage) => void;
type StateListener = (state: CandleSourceState) => void;

export class MockCandleSource implements CandleSource {
    private currentState: CandleSourceState = 'idle';
    private readonly messageListeners: Set<FeedListener> = new Set<FeedListener>();
    private readonly stateListeners: Set<StateListener> = new Set<StateListener>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private currentCandle: CandleData | null = null;
    private tickCount: number = 0;
    private sequence: number = 0;
    private randomState: number = 0x2f6e2b1;

    constructor(
        private readonly historyCount: number = 120,
        private readonly updateIntervalMs: number = 500,
    ) {
        if (!Number.isSafeInteger(historyCount) || historyCount < 1) {
            throw new Error('MatrixCharts: Mock historyCount must be a positive integer.');
        }
        if (!Number.isFinite(updateIntervalMs) || updateIntervalMs < 50) {
            throw new Error('MatrixCharts: Mock update interval must be at least 50 ms.');
        }
    }

    public get state(): CandleSourceState {
        return this.currentState;
    }

    public subscribe(onMessage: FeedListener, onStateChange: StateListener): () => void {
        this.messageListeners.add(onMessage);
        this.stateListeners.add(onStateChange);
        onStateChange(this.currentState);
        return (): void => {
            this.messageListeners.delete(onMessage);
            this.stateListeners.delete(onStateChange);
        };
    }

    public start(): void {
        if (this.currentState === 'connected' || this.currentState === 'connecting') return;
        this.setState('connecting');

        const now: number = Date.now();
        const firstTime: number = now - (this.historyCount - 1) * 60_000;
        const history: CandleData[] = new Array<CandleData>(this.historyCount);
        let previousClose: number = 100;
        for (let index: number = 0; index < this.historyCount; index++) {
            const open: number = previousClose;
            const close: number = Math.max(1, open + (this.nextRandom() - 0.48) * 1.2);
            const high: number = Math.max(open, close) + this.nextRandom() * 0.7;
            const low: number = Math.min(open, close) - this.nextRandom() * 0.7;
            history[index] = { time: firstTime + index * 60_000, open, high, low, close };
            previousClose = close;
        }

        this.currentCandle = history[history.length - 1];
        this.tickCount = 0;
        this.sequence = 0;
        this.setState('connected');
        this.emit({ type: 'snapshot', sequence: this.sequence, candles: history });
        this.timer = setInterval(this.tick, this.updateIntervalMs);
    }

    public stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.currentCandle = null;
        this.setState('disconnected');
    }

    private tick = (): void => {
        if (!this.currentCandle) return;
        this.tickCount++;
        const previous: CandleData = this.currentCandle;
        const close: number = Math.max(1, previous.close + (this.nextRandom() - 0.49) * 0.8);
        this.currentCandle = {
            ...previous,
            high: Math.max(previous.high, close),
            low: Math.min(previous.low, close),
            close,
        };
        this.emit({ type: 'update', sequence: ++this.sequence, candle: this.currentCandle });

        if (this.tickCount % 4 === 0) {
            const nextTime: number = previous.time + 60_000;
            const open: number = previous.close;
            const nextClose: number = Math.max(1, open + (this.nextRandom() - 0.49) * 1.2);
            this.currentCandle = {
                time: nextTime,
                open,
                high: Math.max(open, nextClose) + this.nextRandom() * 0.5,
                low: Math.min(open, nextClose) - this.nextRandom() * 0.5,
                close: nextClose,
            };
            this.emit({ type: 'append', sequence: ++this.sequence, candles: [this.currentCandle] });
        }
    };

    private nextRandom(): number {
        this.randomState = (this.randomState * 1664525 + 1013904223) >>> 0;
        return this.randomState / 4294967296;
    }

    private emit(message: CandleFeedMessage): void {
        for (const listener of this.messageListeners) listener(message);
    }

    private setState(state: CandleSourceState): void {
        if (this.currentState === state) return;
        this.currentState = state;
        for (const listener of this.stateListeners) listener(state);
    }
}
