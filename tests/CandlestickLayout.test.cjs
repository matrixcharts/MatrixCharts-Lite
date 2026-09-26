const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
    candlestickBodyWidthDevicePixels,
    candlestickBodyEdgesData,
    DEFAULT_CANDLE_SPACING_PX,
} = require('../.test-build/math/candlestickBodyWidth.js');

test('default spacing is chunkier than TradingView\'s 6px barSpacing', () => {
    assert.equal(DEFAULT_CANDLE_SPACING_PX, 14);
});

test('readable zoom keeps a 2px gutter and a blocky odd-width body', () => {
    const width = candlestickBodyWidthDevicePixels(14, 1);
    assert.equal(width, 9);
    assert.equal(width % 2, 1);
    assert.ok(14 - width >= 2);
});

test('tight zoom still leaves at least a 1px gutter once bars are 4px apart', () => {
    const width = candlestickBodyWidthDevicePixels(6, 1);
    assert.ok(width >= 4);
    assert.ok(6 - width >= 1);
});

test('body edges preserve integer device-pixel width after rounding', () => {
    const scaleX = 14;
    const offsetX = 40;
    const pixelRatio = 1;
    const { left, right } = candlestickBodyEdgesData(10, 1, scaleX, offsetX, pixelRatio);
    const leftPx = Math.round(left * scaleX * pixelRatio + offsetX * pixelRatio);
    const rightPx = Math.round(right * scaleX * pixelRatio + offsetX * pixelRatio);
    assert.equal(rightPx - leftPx, candlestickBodyWidthDevicePixels(14, 1));
});
