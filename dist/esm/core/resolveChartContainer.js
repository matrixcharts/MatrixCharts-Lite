export function resolveChartContainer(container) {
    if (typeof container === 'string') {
        if (container.length === 0) {
            throw new Error('MatrixCharts: Container id must be a non-empty string.');
        }
        if (typeof document === 'undefined') {
            throw new Error('MatrixCharts: Chart requires a browser document to resolve a container id.');
        }
        const element = document.getElementById(container);
        if (!element) {
            throw new Error(`MatrixCharts: Container '${container}' not found.`);
        }
        return element;
    }
    if (typeof HTMLElement !== 'undefined' && container instanceof HTMLElement) {
        return container;
    }
    throw new Error('MatrixCharts: Container must be an HTMLElement or an element id.');
}
