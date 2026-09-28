const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ChartFeedController } = require('../.test-build/feed/ChartFeedController.js');
const { MockCandleSource } = require('../.test-build/feed/MockCandleSource.js');
const { WebSocketCandleSource } = require('../.test-build/feed/WebSocketCandleSource.js');
const { CandleReplaySource } = require('../.test-build/feed/CandleReplaySource.js');

class CaptureTarget {
    constructor() {
        this.snapshots = [];
        this.batches = [];
        this.updates = [];
    }

    setData(candles) {
        this.snapshots.push(Array.from(candles));
    }

    replaceData(candles) {
        this.snapshots.push(Array.from(candles));
    }

    appendBatch(candles) {
        this.batches.push(Array.from(candles));
    }

    updateLast(candle) {
        this.updates.push(candle);
    }
}

class FakeWebSocket extends EventTarget {
    constructor(url) {
        super();
        this.url = url;
        this.readyState = 0;
        this.closeCalls = 0;
        this.sent = [];
    }

    open() {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
    }

    send(value) {
        this.sent.push(JSON.parse(value));
    }

    sendJson(value) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
    }

    close() {
        this.closeCalls++;
        this.readyState = 3;
        this.dispatchEvent(new Event('close'));
    }
}

const candle = (time, close = 10) => ({
    time,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
});

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('mock source provides an initial snapshot and stops its update timer on dispose', async () => {
    const target = new CaptureTarget();
    const states = [];
    const controller = new ChartFeedController(
        target,
        new MockCandleSource(5, 50),
        (state) => states.push(state),
    );

    assert.equal(controller.state, 'connected');
    assert.deepEqual(states, ['idle', 'connecting', 'connected']);
    assert.equal(target.snapshots.length, 1);
    assert.equal(target.snapshots[0].length, 5);

    controller.dispose();
    await pause(80);
    assert.equal(controller.state, 'disconnected');
    assert.equal(target.updates.length, 0);
});

test('replay source steps deterministically and feed diagnostics count applied messages', () => {
    const target = new CaptureTarget();
    const source = new CandleReplaySource([
        { message: { type: 'snapshot', sequence: 1, candles: [candle(1000)] } },
        { message: { type: 'append', sequence: 2, candles: [candle(2000)] } },
    ]);
    const controller = new ChartFeedController(target, source);
    source.pause();
    assert.equal(source.position, 0);
    assert.equal(source.step(), true);
    assert.equal(source.step(), true);
    assert.equal(source.step(), false);
    assert.deepEqual(controller.getDiagnostics(), {
        received: 2,
        applied: 2,
        rejected: 0,
        lastSequence: 2,
        lastMessageType: 'append',
        lastError: null,
    });
    controller.dispose();
});

test('WebSocket source routes sequenced snapshot, append, and update then detaches on stop', () => {
    const sockets = [];
    const source = new WebSocketCandleSource('ws://localhost:8080', {
        webSocketFactory: (url) => {
            const socket = new FakeWebSocket(url);
            sockets.push(socket);
            return socket;
        },
        reconnectMinDelayMs: 5,
        reconnectMaxDelayMs: 10,
        heartbeatTimeoutMs: 1000,
        watchdogIntervalMs: 20,
    });
    const target = new CaptureTarget();
    const states = [];
    const controller = new ChartFeedController(target, source, (state) => states.push(state));
    const socket = sockets[0];

    socket.open();
    socket.sendJson({ type: 'snapshot', sequence: 10, candles: [candle(1000), candle(2000, 11)] });
    socket.sendJson({ type: 'append', sequence: 11, candles: [candle(3000, 12)] });
    socket.sendJson({ type: 'update', sequence: 12, candle: candle(3000, 13) });

    assert.equal(socket.url, 'ws://localhost:8080');
    assert.equal(controller.state, 'connected');
    assert.deepEqual(states, ['idle', 'connecting', 'resyncing', 'connected']);
    assert.deepEqual(socket.sent[0], { type: 'subscribe' });
    assert.equal(target.snapshots.length, 1);
    assert.equal(target.snapshots[0].length, 2);
    assert.equal(target.batches.length, 1);
    assert.equal(target.batches[0][0].time, 3000);
    assert.equal(target.updates[0].close, 13);

    controller.dispose();
    socket.sendJson({ type: 'append', sequence: 13, candles: [candle(4000)] });
    assert.equal(socket.closeCalls, 1);
    assert.equal(target.batches.length, 1);
    assert.equal(controller.state, 'disconnected');
});

test('sequence gap pauses deltas and authoritative snapshot resumes the feed', () => {
    let socket;
    const source = new WebSocketCandleSource('ws://localhost/feed', {
        webSocketFactory: (url) => {
            socket = new FakeWebSocket(url);
            return socket;
        },
        reconnectMinDelayMs: 1000,
        reconnectMaxDelayMs: 1000,
        heartbeatTimeoutMs: 5000,
        watchdogIntervalMs: 100,
    });
    const target = new CaptureTarget();
    const states = [];
    const controller = new ChartFeedController(target, source, (state) => states.push(state));
    socket.open();
    socket.sendJson({ type: 'snapshot', sequence: 40, candles: [candle(1000)] });
    socket.sendJson({ type: 'append', sequence: 42, candles: [candle(2000)] });

    assert.equal(controller.state, 'resyncing');
    assert.deepEqual(socket.sent[1], {
        type: 'resync',
        afterSequence: 40,
        reason: 'Sequence gap: expected 41, received 42.',
    });
    socket.sendJson({ type: 'append', sequence: 43, candles: [candle(3000)] });
    assert.equal(target.batches.length, 0);

    socket.sendJson({ type: 'snapshot', sequence: 100, candles: [candle(5000), candle(6000)] });
    socket.sendJson({ type: 'append', sequence: 101, candles: [candle(7000)] });
    assert.equal(controller.state, 'connected');
    assert.equal(target.snapshots.length, 2);
    assert.equal(target.snapshots[1][0].time, 5000);
    assert.equal(target.batches.length, 1);
    assert.equal(target.batches[0][0].time, 7000);
    controller.dispose();
});

test('duplicate sequences are ignored and malformed envelopes request resync', () => {
    let socket;
    const source = new WebSocketCandleSource('ws://localhost/feed', {
        webSocketFactory: (url) => {
            socket = new FakeWebSocket(url);
            return socket;
        },
        reconnectMinDelayMs: 1000,
        reconnectMaxDelayMs: 1000,
        heartbeatTimeoutMs: 5000,
        watchdogIntervalMs: 100,
    });
    const target = new CaptureTarget();
    const controller = new ChartFeedController(target, source);
    socket.open();
    socket.sendJson({ type: 'snapshot', sequence: 5, candles: [candle(1000)] });
    socket.sendJson({ type: 'append', sequence: 6, candles: [candle(2000)] });
    socket.sendJson({ type: 'append', sequence: 6, candles: [candle(3000)] });
    assert.equal(target.batches.length, 1);

    socket.sendJson({ type: 'bad-envelope', sequence: 7 });
    assert.equal(controller.state, 'resyncing');
    assert.equal(socket.sent.at(-1).type, 'resync');
    controller.dispose();
});

test('chart-rejected ordered data requests an authoritative snapshot', () => {
    let socket;
    const source = new WebSocketCandleSource('ws://localhost/feed', {
        webSocketFactory: (url) => {
            socket = new FakeWebSocket(url);
            return socket;
        },
        reconnectMinDelayMs: 1000,
        reconnectMaxDelayMs: 1000,
        heartbeatTimeoutMs: 5000,
        watchdogIntervalMs: 100,
    });
    const target = new CaptureTarget();
    target.appendBatch = () => { throw new Error('out-of-order candle'); };
    const errors = [];
    const controller = new ChartFeedController(target, source, () => {}, (error) => errors.push(error));
    socket.open();
    socket.sendJson({ type: 'snapshot', sequence: 8, candles: [candle(1000)] });
    socket.sendJson({ type: 'append', sequence: 9, candles: [candle(2000)] });

    assert.equal(errors.length, 1);
    assert.equal(controller.state, 'resyncing');
    assert.equal(socket.sent.at(-1).type, 'resync');
    controller.dispose();
});

test('closed socket reconnects with a fresh subscription and stop cancels future retries', async () => {
    const sockets = [];
    const source = new WebSocketCandleSource('ws://localhost/feed', {
        webSocketFactory: (url) => {
            const socket = new FakeWebSocket(url);
            sockets.push(socket);
            return socket;
        },
        reconnectMinDelayMs: 5,
        reconnectMaxDelayMs: 10,
        heartbeatTimeoutMs: 1000,
        watchdogIntervalMs: 50,
    });
    source.subscribe(() => {}, () => {});
    source.start();
    sockets[0].open();
    sockets[0].dispatchEvent(new Event('close'));
    await pause(20);
    assert.equal(sockets.length, 2);
    sockets[1].open();
    assert.equal(source.state, 'resyncing');
    source.stop();
    const socketsAfterStop = sockets.length;
    await pause(20);
    assert.equal(sockets.length, socketsAfterStop);
    assert.equal(source.state, 'disconnected');
});

test('stale heartbeat timeout reconnects the source', async () => {
    const sockets = [];
    const source = new WebSocketCandleSource('ws://localhost/feed', {
        webSocketFactory: (url) => {
            const socket = new FakeWebSocket(url);
            sockets.push(socket);
            return socket;
        },
        reconnectMinDelayMs: 5,
        reconnectMaxDelayMs: 10,
        heartbeatTimeoutMs: 120,
        watchdogIntervalMs: 10,
    });
    source.start();
    sockets[0].open();
    sockets[0].sendJson({ type: 'snapshot', sequence: 0, candles: [candle(1000)] });
    await pause(160);
    assert.ok(sockets.length >= 2);
    source.stop();
});
