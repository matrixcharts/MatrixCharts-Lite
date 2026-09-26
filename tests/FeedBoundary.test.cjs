// Feed adapter boundary tests. These cover the parser and the state machine at
// the transport edge, which is where malformed server input is cheapest to
// reject. Wire-level framing is not covered; see production-readiness.md.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ChartFeedController } = require('../.test-build/feed/ChartFeedController.js');
const { WebSocketCandleSource } = require('../.test-build/feed/WebSocketCandleSource.js');

class FakeWebSocket extends EventTarget {
    constructor(url) {
        super();
        this.url = url;
        this.readyState = 0;
        this.sent = [];
    }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    /** Raw text, exactly as a server would put it on the wire. */
    emitRaw(text) { this.dispatchEvent(new MessageEvent('message', { data: text })); }
    sentTypes() { return this.sent.map((value) => JSON.parse(value).type); }
}

/**
 * A source that is already synchronized, which is the realistic mid-session case.
 * Cleanup is registered on the test context so a failing assertion cannot leave
 * the watchdog interval running and hang the whole run.
 */
function synchronizedSource(t) {
    const socket = new FakeWebSocket('ws://feed.test/stream');
    const source = new WebSocketCandleSource('ws://feed.test/stream', {
        webSocketFactory: () => socket,
        reconnectMinDelayMs: 1000,
        reconnectMaxDelayMs: 1000,
        heartbeatTimeoutMs: 10_000,
        watchdogIntervalMs: 500,
    });
    t.after(() => source.stop());
    const messages = [];
    const states = [];
    source.subscribe((message) => messages.push(message), (state) => states.push(state));
    source.start();
    socket.open();
    socket.emitRaw('{"type":"snapshot","sequence":1,"candles":[{"time":1000,"open":1,"high":2,"low":0,"close":1}]}');
    assert.equal(states[states.length - 1], 'connected', 'fixture should start synchronized');
    return { socket, source, messages, states };
}

test('an out-of-range JSON literal is rejected at the transport boundary', (t) => {
    // JSON.parse turns 1e999 into Infinity, which is typeof "number" but not a
    // usable price or timestamp. Every other malformed field is rejected here, so
    // this one must be too rather than relying on the chart to catch it.
    const cases = [
        ['time', '{"type":"append","sequence":2,"candles":[{"time":1e999,"open":1,"high":2,"low":0,"close":1}]}'],
        ['open', '{"type":"append","sequence":2,"candles":[{"time":2000,"open":1e999,"high":2,"low":0,"close":1}]}'],
        ['high', '{"type":"append","sequence":2,"candles":[{"time":2000,"open":1,"high":1e999,"low":0,"close":1}]}'],
        ['low', '{"type":"append","sequence":2,"candles":[{"time":2000,"open":1,"high":2,"low":-1e999,"close":1}]}'],
        ['close', '{"type":"append","sequence":2,"candles":[{"time":2000,"open":1,"high":2,"low":0,"close":1e999}]}'],
        ['update candle', '{"type":"update","sequence":2,"candle":{"time":1000,"open":1,"high":1e999,"low":0,"close":1}}'],
        ['snapshot candle', '{"type":"snapshot","sequence":2,"candles":[{"time":1e999,"open":1,"high":2,"low":0,"close":1}]}'],
    ];
    for (const [label, raw] of cases) {
        const { socket, source, messages } = synchronizedSource(t);
        const before = messages.length;
        socket.emitRaw(raw);
        assert.equal(messages.length, before, `${label}: must not be delivered`);
        assert.ok(socket.sentTypes().includes('resync'), `${label}: must request an authoritative snapshot`);
    }
});

test('a large but finite timestamp is left for the chart to range-check', (t) => {
    const { socket, source, messages } = synchronizedSource(t);
    const before = messages.length;
    // 8.6e15 is finite and inside the documented range, so the adapter passes it on.
    socket.emitRaw('{"type":"append","sequence":2,"candles":[{"time":8.6e15,"open":1,"high":2,"low":0,"close":1}]}');
    assert.equal(messages.length, before + 1, 'a finite timestamp is delivered');
    assert.equal(socket.sentTypes().includes('resync'), false, 'and does not trigger a resync');
});

test('non-string frames request a resync instead of being parsed', (t) => {
    const { socket, source, messages } = synchronizedSource(t);
    const before = messages.length;
    socket.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(8) }));
    assert.equal(messages.length, before, 'a binary frame must not be delivered');
    assert.ok(socket.sentTypes().includes('resync'), 'a binary frame must request a resync');
});

test('malformed envelopes request a resync and are never delivered', (t) => {
    const malformed = [
        'not json at all',
        '[]',
        'null',
        '"a string"',
        '{}',
        '{"type":"delta","sequence":2,"candles":[]}',
        '{"type":"snapshot","sequence":-1,"candles":[]}',
        '{"type":"snapshot","sequence":1.5,"candles":[]}',
        '{"type":"snapshot","sequence":9007199254740992,"candles":[]}',
        '{"type":"append","sequence":2,"candles":"nope"}',
        '{"type":"append","sequence":2,"candles":[null]}',
        '{"type":"append","sequence":2,"candles":[{"time":2000,"open":1,"high":2,"low":0}]}',
        '{"type":"update","sequence":2}',
    ];
    for (const raw of malformed) {
        const { socket, source, messages } = synchronizedSource(t);
        const before = messages.length;
        socket.emitRaw(raw);
        assert.equal(messages.length, before, `${raw} must not be delivered`);
        assert.ok(socket.sentTypes().includes('resync'), `${raw} must request a resync`);
    }
});

test('an empty snapshot is authoritative and clears the series', (t) => {
    const { socket, source, messages } = synchronizedSource(t);
    socket.emitRaw('{"type":"snapshot","sequence":9,"candles":[]}');
    assert.equal(messages.length, 2, 'the empty snapshot is delivered');
    assert.deepEqual(messages[1], { type: 'snapshot', sequence: 9, candles: [] });
    // Deltas after it resume from the new sequence.
    socket.emitRaw('{"type":"append","sequence":10,"candles":[{"time":1,"open":1,"high":2,"low":0,"close":1}]}');
    assert.equal(messages.length, 3, 'a delta after an empty snapshot is accepted');
});

test('a resync is requested once, not on every malformed frame', (t) => {
    const { socket, source } = synchronizedSource(t);
    for (let attempt = 0; attempt < 5; attempt++) {
        socket.emitRaw('not json at all');
    }
    const resyncs = socket.sentTypes().filter((type) => type === 'resync').length;
    assert.equal(resyncs, 1, 'a pending resync must not be re-sent for each bad frame');
});

test('a chart-rejected batch pauses deltas until an authoritative snapshot', (t) => {
    const socket = new FakeWebSocket('ws://feed.test/stream');
    const source = new WebSocketCandleSource('ws://feed.test/stream', {
        webSocketFactory: () => socket,
        reconnectMinDelayMs: 1000,
        reconnectMaxDelayMs: 1000,
        heartbeatTimeoutMs: 10_000,
        watchdogIntervalMs: 500,
    });
    t.after(() => source.stop());

    const applied = [];
    const target = {
        setData: (candles) => applied.push(['setData', candles.length]),
        replaceData: (candles) => applied.push(['replaceData', candles.length]),
        appendBatch: (candles) => {
            // Mimic the chart's own range check, which rejects an absurd timestamp.
            for (const candle of candles) {
                if (!Number.isFinite(candle.time) || candle.time > 8.64e15) {
                    throw new Error('MatrixCharts: Invalid or out-of-order OHLC candle at index 0.');
                }
            }
            applied.push(['appendBatch', candles.length]);
        },
        updateLast: () => applied.push(['updateLast', 1]),
    };
    const errors = [];
    const controller = new ChartFeedController(target, source, () => {}, (error) => errors.push(String(error)));
    t.after(() => controller.dispose());

    source.start();
    socket.open();
    // A feed snapshot is authoritative, so the controller uses replaceData.
    socket.emitRaw('{"type":"snapshot","sequence":1,"candles":[{"time":1000,"open":1,"high":2,"low":0,"close":1}]}');
    assert.deepEqual(applied, [['replaceData', 1]], 'the snapshot landed');

    // In range for the adapter, rejected by the chart's own validation.
    socket.emitRaw('{"type":"append","sequence":2,"candles":[{"time":9007199254740991,"open":1,"high":2,"low":0,"close":1}]}');
    assert.equal(errors.length, 1, 'the rejection is reported to the caller');
    assert.equal(controller.state, 'resyncing', 'and an authoritative snapshot is requested');
    assert.ok(socket.sentTypes().includes('resync'), 'a resync frame goes out on the wire');

    // Deltas are paused until that snapshot arrives, so this one is dropped.
    socket.emitRaw('{"type":"append","sequence":3,"candles":[{"time":2000,"open":1,"high":2,"low":0,"close":1}]}');
    assert.deepEqual(applied, [['replaceData', 1]], 'no delta is applied while a resync is pending');

    // The snapshot restores the feed and deltas resume.
    socket.emitRaw('{"type":"snapshot","sequence":4,"candles":[{"time":2000,"open":1,"high":2,"low":0,"close":1}]}');
    assert.deepEqual(applied, [['replaceData', 1], ['replaceData', 1]], 'the recovery snapshot is applied');
    assert.equal(controller.state, 'connected');
    socket.emitRaw('{"type":"append","sequence":5,"candles":[{"time":3000,"open":1,"high":2,"low":0,"close":1}]}');
    assert.deepEqual(applied[applied.length - 1], ['appendBatch', 1], 'deltas resume after recovery');
});
