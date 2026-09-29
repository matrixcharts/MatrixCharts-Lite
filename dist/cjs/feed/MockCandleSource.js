"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockCandleSource = void 0;
class MockCandleSource {
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
    constructor(historyCount = 120, updateIntervalMs = 500, sessionBars = 0, gapMs = 17 * 60 * 60 * 1000) {
        this.historyCount = historyCount;
        this.updateIntervalMs = updateIntervalMs;
        this.currentState = 'idle';
        this.messageListeners = new Set();
        this.stateListeners = new Set();
        this.timer = null;
        this.currentCandle = null;
        this.tickCount = 0;
        this.sequence = 0;
        this.randomState = 0x2f6e2b1;
        this.barsThisSession = 0;
        this.tick = () => {
            if (!this.currentCandle)
                return;
            this.tickCount++;
            const previous = this.currentCandle;
            const close = Math.max(1, previous.close + (this.nextRandom() - 0.49) * 0.8);
            this.currentCandle = {
                ...previous,
                high: Math.max(previous.high, close),
                low: Math.min(previous.low, close),
                close,
            };
            this.emit({ type: 'update', sequence: ++this.sequence, candle: this.currentCandle });
            if (this.tickCount % 4 === 0) {
                let nextTime = previous.time + 60000;
                if (this.barsPerSession > 0 && this.barsThisSession >= this.barsPerSession) {
                    nextTime += this.gapMs;
                    this.barsThisSession = 0;
                }
                this.barsThisSession++;
                const open = previous.close;
                const nextClose = Math.max(1, open + (this.nextRandom() - 0.49) * 1.2);
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
    get state() {
        return this.currentState;
    }
    subscribe(onMessage, onStateChange) {
        this.messageListeners.add(onMessage);
        this.stateListeners.add(onStateChange);
        onStateChange(this.currentState);
        return () => {
            this.messageListeners.delete(onMessage);
            this.stateListeners.delete(onStateChange);
        };
    }
    start() {
        if (this.currentState === 'connected' || this.currentState === 'connecting')
            return;
        this.setState('connecting');
        const now = Date.now();
        const firstTime = now - (this.historyCount - 1) * 60000;
        const history = new Array(this.historyCount);
        let previousClose = 100;
        // The clock advances one minute per bar, and jumps by a whole session
        // whenever the current one fills. Both are the same operation on a
        // monotonic counter, which is what keeps the live appends below consistent
        // with this history rather than drifting back into the gaps.
        let time = firstTime;
        for (let index = 0; index < this.historyCount; index++) {
            if (this.barsPerSession > 0 && this.barsThisSession >= this.barsPerSession) {
                time += this.gapMs;
                this.barsThisSession = 0;
            }
            this.barsThisSession++;
            const open = previousClose;
            const close = Math.max(1, open + (this.nextRandom() - 0.48) * 1.2);
            const high = Math.max(open, close) + this.nextRandom() * 0.7;
            const low = Math.min(open, close) - this.nextRandom() * 0.7;
            // Volume tracks the size of the move, so the histogram reads like a
            // market rather than uniform noise and the peak is not always one bar.
            const volume = Math.round(400 + Math.abs(close - open) * 900 + this.nextRandom() * 600);
            history[index] = { time, open, high, low, close, volume };
            previousClose = close;
            time += 60000;
        }
        this.currentCandle = history[history.length - 1];
        this.tickCount = 0;
        this.sequence = 0;
        this.setState('connected');
        this.emit({ type: 'snapshot', sequence: this.sequence, candles: history });
        this.timer = setInterval(this.tick, this.updateIntervalMs);
    }
    stop() {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.currentCandle = null;
        this.setState('disconnected');
    }
    nextRandom() {
        this.randomState = (this.randomState * 1664525 + 1013904223) >>> 0;
        return this.randomState / 4294967296;
    }
    emit(message) {
        for (const listener of this.messageListeners)
            listener(message);
    }
    setState(state) {
        if (this.currentState === state)
            return;
        this.currentState = state;
        for (const listener of this.stateListeners)
            listener(state);
    }
}
exports.MockCandleSource = MockCandleSource;
