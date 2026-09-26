import type { CandleData } from '../core/CandleData.js';
import type { CandleFeedMessage, CandleSource, CandleSourceState } from './CandleSource.js';

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

    /** Bars in a session before the feed jumps to the next one. 0 disables. */
    private readonly barsPerSession: number;
    /** How far a closed session jumps the clock, in milliseconds. */
    private readonly gapMs: number;
    private barsThisSession: number = 0;

    /**
     * `sessionBars` makes the feed behave like a traditional equity tape: bars
     * arrive in runs and then the clock jumps forward by `gapMs`, which is what
     * produces the overnight and weekend gaps the chart has to show as breaks.
     *
     * A second parameter rather than a flag on the interval because a break is not a
     * property of the bar spacing — the spacing is one minute on both sides of it, and
     * it is the *gap* that is long. That distinction is the whole reason the chart
     * sizes a break separately from a bar.
     */
    constructor(
        private readonly historyCount: number = 120,
        private readonly updateIntervalMs: number = 500,
        sessionBars: number = 0,
        gapMs: number = 17 * 60 * 60 * 1000,
    ) {
        this.barsPerSession = sessionBars;
        this.gapMs = gapMs;
        if (!Number.isSafeInteger(sessionBars) || sessionBars < 0) {
            throw new Error('MatrixCharts: Mock sessionBars must be a non-negative integer.');
        }
        if (!Number.isFinite(gapMs) || gapMs < 0) {
            throw new Error('MatrixCharts: Mock gapMs must be a non-negative number.');
        }
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
        // The clock advances one minute per bar, and jumps by a whole session
        // whenever the current one fills. Both are the same operation on a
        // monotonic counter, which is what keeps the live appends below consistent
        // with this history rather than drifting back into the gaps.
        let time: number = firstTime;
        for (let index: number = 0; index < this.historyCount; index++) {
            if (this.barsPerSession > 0 && this.barsThisSession >= this.barsPerSession) {
                time += this.gapMs;
                this.barsThisSession = 0;
            }
            this.barsThisSession++;
            const open: number = previousClose;
            const close: number = Math.max(1, open + (this.nextRandom() - 0.48) * 1.2);
            const high: number = Math.max(open, close) + this.nextRandom() * 0.7;
            const low: number = Math.min(open, close) - this.nextRandom() * 0.7;
            // Volume tracks the size of the move, so the histogram reads like a
            // market rather than uniform noise and the peak is not always one bar.
            const volume: number = Math.round(
                400 + Math.abs(close - open) * 900 + this.nextRandom() * 600,
            );
            history[index] = { time, open, high, low, close, volume };
            previousClose = close;
            time += 60_000;
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
            let nextTime: number = previous.time + 60_000;
            if (this.barsPerSession > 0 && this.barsThisSession >= this.barsPerSession) {
                nextTime += this.gapMs;
                this.barsThisSession = 0;
            }
            this.barsThisSession++;
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
