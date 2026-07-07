import { expect } from 'chai';
import { WebSocketServer } from 'ws';
import { AddressInfo } from 'net';

import { StateHistoryConnection } from './ship';

function listen(server: WebSocketServer): Promise<number> {
    return new Promise((resolve) => {
        server.on('listening', () => resolve((server.address() as AddressInfo).port));
    });
}

describe('StateHistoryConnection heartbeat watchdog', () => {
    let server: WebSocketServer;
    let connection: StateHistoryConnection;

    afterEach(async () => {
        // Reach into privates to silence reconnect timers without a full
        // startProcessing/stopProcessing lifecycle (no consumer in these tests).
        (connection as any).stopped = true;
        (connection as any).stopHeartbeat();
        (connection as any).ws?.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('terminates an idle connection whose peer never responds, then reconnects', async () => {
        // autoPong: false simulates a half-open/dead peer: the socket stays
        // open but pings are never answered and no data ever arrives.
        server = new WebSocketServer({ port: 0, autoPong: false });
        const port = await listen(server);

        connection = new StateHistoryConnection({
            endpoint: `ws://127.0.0.1:${port}`,
            connectionOptions: {
                heartbeat_interval_ms: 25,
                idle_timeout_ms: 100,
            },
        });

        const warnings: string[] = [];
        connection.on('warning', (msg: string) => warnings.push(msg));
        connection.on('error', () => undefined); // expected disconnect errors
        connection.on('info', () => undefined);

        (connection as any).stopped = false;
        connection.connect();

        await new Promise((resolve) => setTimeout(resolve, 400));

        expect(warnings.some((w) => w.includes('terminating dead connection'))).to.equal(true);
        // onClose ran and scheduled a reconnect instead of hanging forever
        expect((connection as any).connected).to.equal(false);
    });

    it('keeps a responsive connection alive past the idle timeout', async () => {
        // Default autoPong: the server answers pings, which counts as activity.
        // Count the pings the server receives so the assertion proves the
        // heartbeat is actively firing, independent of wall-clock timing.
        server = new WebSocketServer({ port: 0 });
        let pingsSeen = 0;
        server.on('connection', (ws) => ws.on('ping', () => (pingsSeen += 1)));
        const port = await listen(server);

        // idle_timeout is deliberately far larger than heartbeat_interval and
        // larger than any plausible CI event-loop stall: a full-suite CPU stall
        // exceeding a tiny idle_timeout used to trip a spurious "dead connection"
        // termination on this healthy peer (the flake). The window below still
        // exceeds idle_timeout, so a heartbeat that failed to refresh activity
        // would trip the watchdog and fail the test.
        connection = new StateHistoryConnection({
            endpoint: `ws://127.0.0.1:${port}`,
            connectionOptions: {
                heartbeat_interval_ms: 25,
                idle_timeout_ms: 1000,
            },
        });

        const warnings: string[] = [];
        connection.on('warning', (msg: string) => warnings.push(msg));
        connection.on('error', () => undefined);
        connection.on('info', () => undefined);

        (connection as any).stopped = false;
        connection.connect();

        // Run past the idle timeout so staying alive is attributable to the
        // heartbeat refreshing activity, not to the window ending early.
        await new Promise((resolve) => setTimeout(resolve, 1200));

        expect(warnings.some((w) => w.includes('terminating dead connection'))).to.equal(false);
        expect((connection as any).connected).to.equal(true);
        // The heartbeat fired repeatedly (25ms interval over a 1200ms window);
        // require several to confirm it is running, tolerant of scheduling jitter.
        expect(pingsSeen).to.be.greaterThanOrEqual(3);
    });
});
