export default class ShipError extends Error {
    constructor(message: string, previousError?: unknown) {
        super(`${message}\n\n${previousError ? String(previousError) : ''}`, { cause: previousError });
        const previousStack = previousError instanceof Error ? previousError.stack : undefined;
        this.stack = previousStack ? `${previousStack}\n${this.stack}` : this.stack;
    }
}
