export default class ShipError extends Error {
    constructor(message: string, previousError?: Error) {
        super(`${message}\n\n${previousError ? String(previousError) : ''}`);
        this.stack = previousError ? `${previousError.stack}\n${this.stack}` : this.stack;
    }
}
