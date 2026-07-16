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

describe('StateHistoryConnection reconnect stall vectors', () => {
    let server: WebSocketServer;
    let connection: StateHistoryConnection;

    afterEach(async () => {
        // stopProcessing() is the real teardown path: it flips stopped, stops
        // the heartbeat, and - the part that matters here - clears any pending
        // reconnectTimer. Without that, a test that exercised reconnect()
        // leaves a live setTimeout behind and mocha hangs on exit.
        (connection as any).stopProcessing();
        (connection as any).ws?.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('does not leave a permanent connecting latch when error fires without close', async () => {
        server = new WebSocketServer({ port: 0 });
        const port = await listen(server);

        connection = new StateHistoryConnection({
            endpoint: `ws://127.0.0.1:${port}`,
        });

        connection.on('error', () => undefined);
        connection.on('info', () => undefined);

        (connection as any).stopped = false;
        connection.connect();

        // Simulate an 'error' event before the real handshake can complete
        // ('open' fires asynchronously), reproducing 'error' without 'close'
        // - the confirmed stall vector - while connecting is still latched.
        expect((connection as any).connecting).to.equal(true);

        (connection as any).ws.emit('error', new Error('simulated socket error'));

        expect((connection as any).connecting).to.equal(false);
        // The 'error' handler also calls reconnect() itself now, so a missing
        // 'close' still gets a retry scheduled instead of waiting forever.
        expect((connection as any).reconnectTimer).to.not.equal(undefined);

        // With connecting cleared, a later connect() call is not a silent no-op.
        (connection as any).connected = false;
        (connection as any).ws = undefined;
        connection.connect();

        expect((connection as any).connecting).to.equal(true);
    });

    it('still schedules a reconnect when deserializer.terminate() rejects', async () => {
        server = new WebSocketServer({ port: 0 });
        const port = await listen(server);

        connection = new StateHistoryConnection({
            endpoint: `ws://127.0.0.1:${port}`,
            deserializer: {
                init: async () => undefined,
                deserialize: async () => [],
                terminate: async () => {
                    throw new Error('simulated terminate failure');
                },
            } as any,
        });

        const errors: string[] = [];
        connection.on('error', (e: Error) => errors.push(e.message));
        connection.on('info', () => undefined);

        let reconnectCalled = false;
        (connection as any).reconnect = () => {
            reconnectCalled = true;
        };

        (connection as any).stopped = false;
        connection.connect();

        await new Promise((resolve) => setTimeout(resolve, 50));

        await (connection as any).onClose();

        expect(reconnectCalled).to.equal(true);
        expect(errors.some((m) => m.includes('Failed to terminate deserializer'))).to.equal(true);
    });

    it('schedules exactly one pending reconnect when error and close both fire, doubling backoff once', async () => {
        server = new WebSocketServer({ port: 0 });
        const port = await listen(server);

        // A stub deserializer keeps terminate() from touching the real
        // worker-thread pool, so the only setTimeout calls observed below
        // come from reconnect() itself.
        connection = new StateHistoryConnection({
            endpoint: `ws://127.0.0.1:${port}`,
            deserializer: {
                init: async () => undefined,
                deserialize: async () => [],
                terminate: async () => undefined,
            } as any,
        });

        connection.on('error', () => undefined);
        connection.on('info', () => undefined);

        (connection as any).stopped = false;
        connection.connect();

        const initialDelay = (connection as any).reconnectDelay;
        const socket = (connection as any).ws;

        const originalSetTimeout = global.setTimeout;
        let scheduleCount = 0;
        (global as any).setTimeout = ((...args: unknown[]) => {
            scheduleCount += 1;

            return (originalSetTimeout as any)(...args);
        }) as typeof setTimeout;

        try {
            // 'error' fires first: clears the connecting latch and calls
            // reconnect(), which schedules the only timer we expect.
            socket.emit('error', new Error('simulated socket error'));

            // 'close' follows right after (the real handler order once a
            // socket errors out); onClose() calls reconnect() again, and it
            // must see the pending timer and no-op rather than schedule a
            // second one or double the backoff again.
            await (connection as any).onClose();
        } finally {
            global.setTimeout = originalSetTimeout;
        }

        expect(scheduleCount).to.equal(1);
        expect((connection as any).reconnectDelay).to.equal(initialDelay * 2);
        expect((connection as any).reconnectTimer).to.not.equal(undefined);
    });

    it("ignores a stale socket's late error and does not clear a newer connect's latch", async () => {
        server = new WebSocketServer({ port: 0 });
        const port = await listen(server);

        connection = new StateHistoryConnection({
            endpoint: `ws://127.0.0.1:${port}`,
        });

        connection.on('error', () => undefined);
        connection.on('info', () => undefined);

        (connection as any).stopped = false;
        connection.connect();

        // Captures the socket connect() just wired 'error'/'close' handlers
        // onto, before it is replaced by a newer in-flight attempt below.
        const staleSocket = (connection as any).ws;

        // Simulate the old socket having already been superseded (e.g. by
        // onClose() tearing down and a fresh connect() firing) without
        // waiting for a real close round-trip.
        (connection as any).connected = false;
        (connection as any).connecting = false;
        (connection as any).ws = undefined;
        connection.connect();

        expect((connection as any).connecting).to.equal(true);
        expect((connection as any).ws).to.not.equal(staleSocket);

        // staleSocket's handlers were closed over the old `socket` identity;
        // this.ws now points at the newer socket, so the identity guard must
        // make this a no-op instead of clearing the newer attempt's latch.
        staleSocket.emit('error', new Error('stale socket error'));

        expect((connection as any).connecting).to.equal(true);
    });
});
