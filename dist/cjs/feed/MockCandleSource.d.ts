import type { CandleFeedMessage, CandleSource, CandleSourceState } from './CandleSource.js';
type FeedListener = (message: CandleFeedMessage) => void;
type StateListener = (state: CandleSourceState) => void;
export declare class MockCandleSource implements CandleSource {
    private readonly historyCount;
    private readonly updateIntervalMs;
    private currentState;
    private readonly messageListeners;
    private readonly stateListeners;
    private timer;
    private currentCandle;
    private tickCount;
    private sequence;
    private randomState;
    /** Bars in a session before the feed jumps to the next one. 0 disables. */
    private readonly barsPerSession;
    /** How far a closed session jumps the clock, in milliseconds. */
    private readonly gapMs;
    private barsThisSession;
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
    constructor(historyCount?: number, updateIntervalMs?: number, sessionBars?: number, gapMs?: number);
    get state(): CandleSourceState;
    subscribe(onMessage: FeedListener, onStateChange: StateListener): () => void;
    start(): void;
    stop(): void;
    private tick;
    private nextRandom;
    private emit;
    private setState;
}
export {};
