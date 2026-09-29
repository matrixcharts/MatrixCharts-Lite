import type { CandleData } from './CandleData.js';
import type { PlotRect } from './coordinates.js';
import type { ResolvedChartOptions } from './options.js';
import type { PaneLayout } from './panes.js';
import type { PlacedMarker, PlacedZone, ResolvedPriceLine } from './decorations.js';
export interface ChartEvents {
    'viewport': {
        offsetX: number;
        offsetY: number;
        scaleX: number;
        scaleY: number;
        /**
         * Slot offset of every retained bar, or null when the series has no breaks.
         *
         * The transform stays affine: `x = offsetX + slot * scaleX`, with the
         * shader untouched, because it multiplies whatever it is given by the scale
         * and adds the offset. Feeding slots is the entire change on the GPU side.
         */
        slots: Float64Array | null;
        /** Region series occupy, in CSS pixels relative to the canvas. */
        plot: PlotRect;
        /**
         * Pane rects and vertical transforms for this frame, in CSS pixels and
         * index-aligned. `transforms[0]` is the price scale, so it agrees with
         * `offsetY`/`scaleY` above.
         *
         * Internal, not a public event: it exists so the two renderers can clip
         * and label per pane without either owning the layout.
         */
        panes?: PaneLayout;
    };
    /**
     * Retained candle timestamps, used by the axis renderer to label ticks. The
     * candle buffer itself is passed straight to the WebGL renderer rather than
     * broadcast, so it is not copied per frame here.
     *
     * `interval` is the modal bar interval in ms. The time axis needs it to pick a
     * step from the calendar ladder and runs on every frame, so the chart derives it
     * once per data change and hands it over here. A renderer that recomputes it
     * instead pays an O(n log n) sort of the whole retained series per frame.
     */
    'data': {
        times: readonly number[];
        interval?: number;
    };
    /**
     * Decorations to draw on the UI layer: price lines, markers, and the
     * last-price tag state.
     *
     * Internal, like `viewport`. It exists so the UI renderer can draw them
     * without reaching back into Chart, and it is a separate event from
     * `viewport` because decorations change on their own schedule — a marker
     * arrives with a trade, not with a pan.
     */
    'decorations': {
        priceLines: readonly ResolvedPriceLine[];
        markers: readonly PlacedMarker[];
        /**
         * Zones, in the order the caller supplied them. The renderer reorders these
         * for painting; the event reports what was given, so a read of the chart's
         * state is not the renderer's presentation order.
         */
        zones: readonly PlacedZone[];
        /**
         * The newest candle's close and direction, or `null` with no data. Derived
         * by Chart rather than supplied, so the tag cannot disagree with the
         * candles it is labelling.
         */
        lastPrice: {
            price: number;
            direction: 'up' | 'down';
        } | null;
    };
    /** Fully resolved options. Emitted once on construction and on every apply. */
    'options': ResolvedChartOptions;
    /**
     * Crosshair state owned by Chart. The UI layer only draws from this; it never
     * hit-tests the pointer itself, so the drawn crosshair and the public
     * crosshairMove event cannot disagree.
     */
    'crosshair': {
        x: number | null;
        y: number | null;
        time: number | null;
        candle: CandleData | null;
        /**
         * The pane the pointer is over, or `null` on a divider or outside every pane.
         *
         * Resolved by Chart rather than by the renderer, so the crosshair, the axis drag
         * and `getPaneAtCoordinate` all answer "which pane is this y" from one row
         * lookup. Two copies of that answer is how a divider ends up belonging to
         * different panes in different parts of the same frame.
         */
        pane: number | null;
        /**
         * The value at `y` in the hovered pane's own units — an RSI reading under an RSI,
         * a price under the price pane. `null` whenever `pane` is.
         *
         * Carried rather than derived downstream because the conversion is not the
         * renderer's to know: pane 0 is a price and goes through the price scale, every
         * other pane is linear. A renderer that worked it out for itself would need to
         * re-decide which pane is the price one, and would put a price on an oscillator
         * axis — which is exactly what it did.
         */
        value: number | null;
    };
}
type Listener<T> = (data: T) => void;
export declare class EventEmitter<T extends Record<string, any>> {
    private listeners;
    on<K extends keyof T>(event: K, listener: Listener<T[K]>): void;
    off<K extends keyof T>(event: K, listener: Listener<T[K]>): void;
    emit<K extends keyof T>(event: K, data: T[K]): void;
}
export {};
//# sourceMappingURL=EventEmitter.d.ts.map