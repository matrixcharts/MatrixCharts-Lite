export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'working' | 'filled' | 'cancelled' | 'rejected';

export interface OrderSpec {
    id: string;
    side: OrderSide;
    price: number;
    quantity: number;
    status?: OrderStatus;
    color?: string;
    label?: string;
}

export interface ResolvedOrder extends OrderSpec {
    status: OrderStatus;
}

export interface DrawingPoint {
    time: number;
    value: number;
}

// --- editable drawings -------------------------------------------------------

export type DrawingType = 'trend-line' | 'horizontal-line' | 'rectangle' | 'fib-retracement';

export interface EditableDrawing {
    id: string;
    type: DrawingType;
    points: DrawingPoint[];
    color: string;
    lineWidth: number;
    lineStyle: 'solid' | 'dashed';
    active: boolean;
    selected: boolean;
    label: string;
    fillColor?: string;
    opacity: number;
}

export interface DragHandle {
    role: 'move' | 'resize-start' | 'resize-end' | 'resize-top' | 'resize-bottom';
    time: number;
    value: number;
    size: number;
    cursor: string;
}

// --- interaction events ------------------------------------------------------
// DrawingOrderEvent is defined in drawingOrderModel.ts to avoid a circular dependency.
// It is re-exported here for convenience.
export type { DrawingOrderEvent } from './drawingOrderModel.js';