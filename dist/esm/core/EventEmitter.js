export class EventEmitter {
    constructor() {
        this.listeners = {};
    }
    on(event, listener) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(listener);
    }
    off(event, listener) {
        const eventListeners = this.listeners[event];
        if (eventListeners) {
            this.listeners[event] = eventListeners.filter(cb => cb !== listener);
        }
    }
    emit(event, data) {
        const eventListeners = this.listeners[event];
        if (eventListeners) {
            eventListeners.forEach(listener => listener(data));
        }
    }
}
