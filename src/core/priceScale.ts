// src/core/priceScale.ts
//
// The price-to-axis mapping, and the tick generator that goes with it.
//
// This exists because the transform the shader applies is **affine**
// (`y = offset + value * scale`) and a log axis is not. The resolution is that the
// affine transform does not have to be in *price* space: the vertex generators emit
// log(price) and the axis converts back. Log therefore needs no new uniform, no
// second program, and no change to WebGLSeries — it is a pair of functions
// applied where prices enter and leave the transform.
//
// The tick generator is here for the same reason, and it is deliberately one
// function with two strategies rather than two functions. A linear axis steps by
// a round number of price units; a log axis steps by a round number of *decades*.
// Writing them separately is how the two drift apart, and the time-axis work that
// follows needs the same shape again.

/** How a price maps to a position on the vertical axis. */
export type PriceScale = 'linear' | 'log';

/**
 * Lowest price a log axis will show.
 *
 * Log is undefined at and below zero, so a log pane has to decide what a zero or
 * negative price means. Clamping is the answer, not dropping the bar: the bar still
 * exists and still has a high and a low, it simply has no position on this axis, and
 * pinning it to the floor makes that visible rather than silently omitting it.
 */
export const LOG_PRICE_FLOOR = 1e-9;

/** Price to the value the affine transform actually operates on. */
export function toScaleSpace(price: number, scale: PriceScale): number {
    if (!Number.isFinite(price)) return Number.NaN;
    if (scale === 'linear') return price;
    // Clamped rather than rejected: see LOG_PRICE_FLOOR.
    return Math.log(Math.max(price, LOG_PRICE_FLOOR));
}

/** The inverse. `fromScaleSpace(toScaleSpace(p))` round-trips for positive prices. */
export function fromScaleSpace(value: number, scale: PriceScale): number {
    if (!Number.isFinite(value)) return Number.NaN;
    if (scale === 'linear') return value;
    return Math.exp(value);
}

/** Whether a price has a position on this axis at all. */
export function isRepresentable(price: number, scale: PriceScale): boolean {
    return Number.isFinite(price) && (scale === 'linear' || price > 0);
}

/**
 * The price range a pane should fit on this scale, with non-positive prices
 * excluded.
 *
 * Excluding rather than clamping, because the *range* is a different question from
 * the position: a pane whose range is floored at 1e-9 would have every real price
 * crushed into the top pixel. So a linear pane fits a zero bar at zero, and a log
 * pane fits only the bars that have a position on it.
 */
export function representableRange(
    minimum: number,
    maximum: number,
    scale: PriceScale,
): [number, number] | null {
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return null;
    if (scale === 'linear') return [Math.min(minimum, maximum), Math.max(minimum, maximum)];
    if (maximum <= 0) return null;
    const low: number = Math.max(minimum, LOG_PRICE_FLOOR);
    return [Math.min(low, maximum), maximum];
}

/** A tick value, and the price it labels. */
export interface Tick {
    /** Position on the axis, in scale space. */
    value: number;
    /** The price a reader sees. */
    price: number;
}

/**
 * Round ticks for a linear axis: whole multiples of a 1/2/5 step.
 *
 * The step is chosen from a target *count* rather than a pixel separation, so the
 * same function serves the price axis, a pane's own axis, and the time axis that
 * follows, instead of each working out its own arithmetic.
 */
export function linearTicks(
    minimum: number,
    maximum: number,
    targetCount: number,
    minStep: number = 0,
): Tick[] {
    if (!(maximum > minimum) || !Number.isFinite(minimum) || !Number.isFinite(maximum)) return [];
    const span: number = maximum - minimum;
    const count: number = Math.max(1, Math.floor(targetCount));
    const magnitude: number = Math.pow(10, Math.floor(Math.log10(span / count)));
    const normalized: number = span / count / magnitude;
    const factor: number = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    let step: number = factor * magnitude;
    // A tradable increment is a floor on the step, not a rounding of it: a tick
    // between prices the instrument cannot trade at is a label for nothing.
    if (minStep > 0) step = Math.max(step, minStep);
    if (!(step > 0)) return [];

    const ticks: Tick[] = [];
    const first: number = Math.ceil(minimum / step) * step;
    // Bounded, so a pathological step cannot spin: a float step that never lands
    // exactly on the bound would otherwise loop forever.
    for (let value: number = first, guard: number = 0; value <= maximum + step * 1e-9 && guard < 10000; value += step, guard++) {
        ticks.push({ value, price: value });
    }
    return ticks;
}

/**
 * Round ticks for a log axis: 1, 2 and 5 within each decade.
 *
 * 1-2-5 in *price* space, not in log space. Stepping a log axis by a round number
 * of log units gives 1, 2, 5 decades apart and labels the axis 2.7, 7.4, 148, which
 * is not a set of numbers anyone reads prices in.
 */
export function logTicks(minimum: number, maximum: number, targetCount: number): Tick[] {
    if (!(maximum > minimum) || !(minimum > 0) || !Number.isFinite(maximum)) return [];
    const wanted: number = Math.max(1, Math.floor(targetCount));

    const firstDecade: number = Math.floor(Math.log10(minimum));
    const lastDecade: number = Math.floor(Math.log10(maximum));

    // How much of each decade to label, chosen from how many decades are in range
    // rather than by stepping over them. A stride over decades is the obvious way to
    // thin a log axis and it is wrong: the stride has a phase, and depending on
    // where the range starts it skips the decades holding 1, 100 and 10000 — the
    // round numbers a reader navigates by. Anchoring every decade to a power of ten
    // cannot lose them.
    //
    // The set is the one landing closest to the target count rather than the first
    // whose capacity fits. Threshold comparisons are off by one at the boundary and
    // an axis labelled 4 lines when 9 were asked for is a visibly worse answer than
    // one labelled 10.
    const countWith = (set: readonly number[]): number => {
        let total: number = 0;
        for (let decade: number = firstDecade; decade <= lastDecade; decade++) {
            const unit: number = Math.pow(10, decade);
            for (const mantissa of set) {
                const price: number = mantissa * unit;
                if (price >= minimum && price <= maximum) total++;
            }
        }
        return total;
    };
    const CANDIDATES: readonly (readonly number[])[] = [[1, 2, 5], [1, 5], [1]];
    let mantissas: readonly number[] = CANDIDATES[CANDIDATES.length - 1];
    let bestDelta: number = Number.POSITIVE_INFINITY;
    for (const candidate of CANDIDATES) {
        const delta: number = Math.abs(countWith(candidate) - wanted);
        if (delta < bestDelta) {
            bestDelta = delta;
            mantissas = candidate;
        }
    }

    const ticks: Tick[] = [];
    for (let decade: number = firstDecade; decade <= lastDecade; decade++) {
        for (const mantissa of mantissas) {
            const price: number = mantissa * Math.pow(10, decade);
            if (price < minimum || price > maximum) continue;
            ticks.push({ value: Math.log(price), price });
        }
    }
    // A decade-anchored ladder can only place a tick at a mantissa times a power of
    // ten, so a range narrower than one gap in that ladder gets *no* ticks at all. A
    // stock trading 104 to 109 over a session is the commonest shape there is, and
    // the anchor it would respect - 100 - is off screen, so anchoring there is not a
    // virtue, it is the whole axis missing.
    //
    // So the anchor governs while it carries the axis, and a plain step takes over
    // when it cannot. The trigger is a floor rather than anything relative to the
    // requested count: below two labels the axis cannot be read off, and a target
    // has no business overriding that. Measuring against the request instead breaks
    // thinning outright, because asking for many labels makes the ladder look
    // inadequate on a range it is labelling perfectly well.
    if (ticks.length < 2) {
        // The fallback's values are *prices*, and on a log axis a tick's value has to
        // be in the space the axis is affine over, which is the log of the price.
        // Handing the price straight back puts every label and gridline for a
        // sub-decade range at roughly y = -930000, which is silently off the pane
        // rather than visibly wrong: the candles draw, the last-price tag places, and
        // the axis is simply blank.
        return linearTicks(minimum, maximum, wanted).map((tick) => ({
            value: Math.log(tick.price),
            price: tick.price,
        }));
    }
    return ticks;
}

/** Ticks for whichever scale is in use. */
export function priceTicks(
    minimum: number,
    maximum: number,
    scale: PriceScale,
    targetCount: number,
    minStep: number = 0,
): Tick[] {
    return scale === 'log'
        ? logTicks(minimum, maximum, targetCount)
        : linearTicks(minimum, maximum, targetCount, minStep);
}
