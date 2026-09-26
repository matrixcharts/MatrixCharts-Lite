// Node has no DOM, so this harness installs the smallest stub that
// resolveChartContainer touches: a global HTMLElement constructor and a
// document.getElementById lookup. Real mounting is covered by the browser e2e.
const assert = require('node:assert/strict');
const { test } = require('node:test');

function withDom(nodes, run) {
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;
    const byId = new Map(nodes.map((node) => [node.id, node]));

    class StubHTMLElement {}
    globalThis.HTMLElement = StubHTMLElement;
    globalThis.document = {
        getElementById(id) {
            return byId.get(id) ?? null;
        },
    };
    try {
        run();
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
        if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
        else globalThis.HTMLElement = previousHTMLElement;
    }
}

const { resolveChartContainer } = require('../.test-build/core/resolveChartContainer.js');

test('accepts an HTMLElement instance without any lookup', () => {
    withDom([], () => {
        const host = new globalThis.HTMLElement();
        assert.equal(resolveChartContainer(host), host);
    });
});

test('accepts an element that is not attached to the document', () => {
    withDom([], () => {
        const detached = new globalThis.HTMLElement();
        assert.equal(resolveChartContainer(detached), detached);
    });
});

test('resolves a string id through getElementById', () => {
    withDom([], () => {
        const host = new globalThis.HTMLElement();
        host.id = 'chart-container';
        globalThis.document.getElementById = (id) => (id === 'chart-container' ? host : null);
        assert.equal(resolveChartContainer('chart-container'), host);
    });
});

test('rejects an empty id, an unknown id, and non-elements', () => {
    withDom([], () => {
        assert.throws(() => resolveChartContainer(''), /non-empty string/);
        assert.throws(() => resolveChartContainer('nope'), /not found/);
        assert.throws(() => resolveChartContainer({}), /HTMLElement or an element id/);
        assert.throws(() => resolveChartContainer(null), /HTMLElement or an element id/);
        assert.throws(() => resolveChartContainer(undefined), /HTMLElement or an element id/);
    });
});

test('resolving an id without a document fails with a browser error', () => {
    const previousDocument = globalThis.document;
    delete globalThis.document;
    try {
        assert.throws(() => resolveChartContainer('chart-container'), /browser document/);
    } finally {
        if (previousDocument !== undefined) globalThis.document = previousDocument;
    }
});

