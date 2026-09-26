const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ChartFeedController } = require('../.test-build/feed/ChartFeedController.js');
const { WebSocketCandleSource } = require('../.test-build/feed/WebSocketCandleSource.js');
const { OHLCPyramid } = require('../.test-build/math/OHLCPyramid.js');

class Socket extends EventTarget {
    readyState = 0;
    sent = [];
    open() {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
    }
    send(value) {
        this.sent.push(JSON.parse(value));
    }
    publish(value) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
    }
    close() {
        this.readyState = 3;
    }
}

class RetainedChartTarget {
    constructor(maxCandles) {
        this.maxCandles = maxCandles;
        this.candles = [];
        this.pyramid = new OHLCPyramid();
    }
    setData(candles) {
        this.replaceData(candles);
    }
    replaceData(candles) {
        this.candles = Array.from(candles).slice(-this.maxCandles);
        this.rebuild();
    }
    appendBatch(candles) {
        this.candles.push(...candles);
        if (this.candles.length > this.maxCandles) {
            this.candles.splice(0, this.candles.length - this.maxCandles);
        }
        this.rebuild();
    }
    updateLast(candle) {
        assert.notEqual(this.candles.length, 0);
        assert.equal(candle.time, this.candles[this.candles.length - 1].time);
        this.candles[this.candles.length - 1] = candle;
        this.rebuild();
    }
    rebuild() {
        // Mirrors Chart.writeCandleRecord, including the volume channel, so a
        // change to the record layout is caught here rather than as a truncated
        // buffer that happens to throw somewhere less obvious.
        const data = new Float32Array(this.candles.length * STRIDE);
        this.candles.forEach((candle, index) => data.set([
            index,
            candle.open,
            candle.high,
            candle.low,
            candle.close,
            0.7,
            candle.volume ?? 0,
        ], index * STRIDE));
        this.pyramid.reset(data);
    }

    totalVolume() {
        const level = this.pyramid.getLevelData(0);
        let sum = 0;
        for (let index = 0; index < level.length / STRIDE; index++) {
            sum += level[index * STRIDE + VOLUME];
        }
        return sum;
    }
}

const STRIDE = 7;
const VOLUME = 6;

const makeCandle = (index, close = 100 + index % 31) => ({
    time: 1735689600000 + index * 60_000,
    open: close - 0.5,
    high: close + 2 + index % 13,
    low: close - 3 - index % 11,
    close,
    volume: 500 + (index % 211),
});

test('feed ingest, retention, aggregate integrity, and snapshot recovery work together', (context) => {
    const sockets = [];
    const source = new WebSocketCandleSource('ws://integration.test', {
        webSocketFactory: () => {
            const socket = new Socket();
            sockets.push(socket);
            return socket;
        },
        reconnectMinDelayMs: 1000,
        reconnectMaxDelayMs: 1000,
        heartbeatTimeoutMs: 5000,
        watchdogIntervalMs: 100,
    });
    const target = new RetainedChartTarget(1000);
    const errors = [];
    const controller = new ChartFeedController(target, source, () => {}, (error) => errors.push(error));
    const socket = sockets[0];
    socket.open();

    socket.publish({ type: 'snapshot', sequence: 20, candles: Array.from({ length: 100 }, (_, index) => makeCandle(index)) });
    socket.publish({ type: 'append', sequence: 21, candles: Array.from({ length: 1500 }, (_, index) => makeCandle(index + 100)) });
    assert.equal(target.candles.length, 1000);
    assert.equal(target.candles[0].time, makeCandle(600).time);
    assert.equal(target.pyramid.candleCount, 1000);

    const expectedHigh = Math.max(...target.candles.map((candle) => candle.high));
    const expectedLow = Math.min(...target.candles.map((candle) => candle.low));
    const root = target.pyramid.getLevelData(target.pyramid.levelCount - 1);
    assert.equal(root[2], expectedHigh);
    assert.equal(root[3], expectedLow);

    const revisedLast = makeCandle(1599, 999);
    socket.publish({ type: 'update', sequence: 22, candle: revisedLast });
    assert.equal(target.candles.at(-1).close, 999);

    socket.publish({ type: 'append', sequence: 24, candles: [makeCandle(1600)] });
    assert.equal(controller.state, 'resyncing');
    socket.publish({ type: 'append', sequence: 25, candles: [makeCandle(1601)] });
    assert.equal(target.candles.at(-1).time, revisedLast.time);

    const recovery = Array.from({ length: 1000 }, (_, index) => makeCandle(index + 600));
    socket.publish({ type: 'snapshot', sequence: 1000, candles: recovery });
    assert.equal(controller.state, 'connected');
    assert.equal(target.candles.length, 1000);
    assert.equal(target.candles[0].time, recovery[0].time);
    // Volume survives the whole feed path, and retention trims exactly the
    // candles that were dropped rather than their volume.
    const expectedVolume = recovery.reduce((sum, candle) => sum + candle.volume, 0);
    assert.equal(target.totalVolume(), expectedVolume);
    assert.deepEqual(errors, []);
    controller.dispose();
    // A failed assertion above would otherwise leave the source's watchdog and
    // reconnect timers running, and the test process would never exit.
    context.after(() => source.stop());
});
