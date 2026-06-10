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
        server = new WebSocketServer({ port: 0 });
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
        connection.on('error', () => undefined);
        connection.on('info', () => undefined);

        (connection as any).stopped = false;
        connection.connect();

        await new Promise((resolve) => setTimeout(resolve, 400));

        expect(warnings.some((w) => w.includes('terminating dead connection'))).to.equal(false);
        expect((connection as any).connected).to.equal(true);
    });
});
