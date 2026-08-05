import { expect } from 'chai';
import { WebSocketServer } from 'ws';
import { AddressInfo } from 'net';
import { ABI } from '@wharfkit/antelope';

import { StateHistoryConnection } from './ship';
import { serializeEosioType } from './deserializer/serialization';
import { IShipConnectionOptions } from './types/ship';

function listen(server: WebSocketServer): Promise<number> {
    return new Promise((resolve) => {
        server.on('listening', () => resolve((server.address() as AddressInfo).port));
    });
}

// Minimal stand-in for the SHIP ABI, carrying only what onMessage() reads off a
// get_blocks_result_v0: the block positions and the three optional payloads.
// Real nodes send a much larger ABI, but every field below is named and typed
// as the state_history_plugin declares it, so a response built here decodes
// through the package's own deserializer exactly as a live one would.
const shipAbi = ABI.from({
    version: 'eosio::abi/1.1',
    types: [],
    structs: [
        {
            name: 'block_position',
            base: '',
            fields: [
                { name: 'block_num', type: 'uint32' },
                { name: 'block_id', type: 'checksum256' },
            ],
        },
        {
            name: 'get_blocks_result_v0',
            base: '',
            fields: [
                { name: 'head', type: 'block_position' },
                { name: 'last_irreversible', type: 'block_position' },
                { name: 'this_block', type: 'block_position?' },
                { name: 'prev_block', type: 'block_position?' },
                { name: 'block', type: 'bytes?' },
                { name: 'traces', type: 'bytes?' },
                { name: 'deltas', type: 'bytes?' },
            ],
        },
    ],
    variants: [{ name: 'result', types: ['get_blocks_result_v0'] }],
    actions: [],
    tables: [],
    ricardian_clauses: [],
});

const BLOCK_ID = '00'.repeat(32);

/**
 * A get_blocks_result_v0 carrying block positions but none of the three
 * optional payloads: what a node serves for a block below its state-history
 * retention floor, which is the shape that wedged the production reader.
 */
function payloadlessBlockMessage(blockNum: number): Uint8Array {
    return serializeEosioType(
        'result',
        [
            'get_blocks_result_v0',
            {
                head: { block_num: blockNum + 10, block_id: BLOCK_ID },
                last_irreversible: { block_num: blockNum - 1, block_id: BLOCK_ID },
                this_block: { block_num: blockNum, block_id: BLOCK_ID },
                prev_block: { block_num: blockNum - 1, block_id: BLOCK_ID },
                block: null,
                traces: null,
                deltas: null,
            },
        ],
        shipAbi
    );
}

interface IDrivenConnection {
    connection: StateHistoryConnection;
    errors: string[];
    warnings: string[];
    consumed: Array<{ block: { block_num: number }; traces: unknown[] }>;
}

/**
 * A connection wired past its handshake so onMessage() can be driven directly:
 * the ABI is already present, a consumer is attached, and the block request is
 * the production shape (fetch_traces on, fetch_block off so the trace branch is
 * the one under test). min_block_confirmation is parked high so a processed
 * block never reaches send(), which the stub ABI cannot serialize.
 */
function driveConnection(port: number, connectionOptions: IShipConnectionOptions): IDrivenConnection {
    const connection = new StateHistoryConnection({
        endpoint: `ws://127.0.0.1:${port}`,
        deserializer: {
            init: async () => undefined,
            deserialize: async () => [],
            terminate: async () => undefined,
        } as any,
        connectionOptions: { min_block_confirmation: 1000, ...connectionOptions },
    });

    const errors: string[] = [];
    const warnings: string[] = [];
    const consumed: IDrivenConnection['consumed'] = [];

    connection.on('error', (e: Error) => errors.push(e.message));
    connection.on('warning', (msg: string) => warnings.push(msg));
    connection.on('info', () => undefined);
    connection.on('debug', () => undefined);

    (connection as any).shipAbi = shipAbi;
    (connection as any).consumer = { consume: async (block: any) => void consumed.push(block) };
    (connection as any).shipOptions = {
        start_block_num: 999,
        end_block_num: 0xffffffff,
        max_messages_in_flight: 30,
        have_positions: [],
        irreversible_only: false,
        fetch_block: false,
        fetch_traces: true,
        fetch_deltas: false,
    };

    return { connection, errors, warnings, consumed };
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

describe('StateHistoryConnection missing block payloads', () => {
    let server: WebSocketServer;
    let connection: StateHistoryConnection;

    afterEach(async () => {
        (connection as any).stopProcessing();
        (connection as any).ws?.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('reconnects instead of pausing the queue when a block arrives without trace data', async () => {
        // Pins the wedge shape: with fetch_traces on and allow_empty_traces off,
        // a payloadless block must reconnect with the queue unpaused, never pause
        // it permanently. A permanent pause here goes silent for the life of the
        // process while the socket stays open, because the peer keeps answering
        // pings so the idle watchdog never fires either.
        server = new WebSocketServer({ port: 0 });
        const port = await listen(server);

        const driven = driveConnection(port, { allow_empty_traces: false });
        connection = driven.connection;

        (connection as any).stopped = false;
        connection.connect();
        await new Promise((resolve) => setTimeout(resolve, 50));

        await connection.onMessage(payloadlessBlockMessage(391178535));

        expect((connection as any).blocksQueue.isPaused).to.equal(false);
        expect(connection.getMissingDataFailures()).to.equal(1);
        expect(
            driven.errors.some(
                (m) =>
                    m.includes('Block #391178535 does not contain trace data') &&
                    m.includes('consecutive missing-data failures: 1')
            )
        ).to.equal(true);

        // The socket teardown routes through 'close' -> onClose() -> reconnect(),
        // so a retry is pending rather than the reader sitting dark forever.
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect((connection as any).connected).to.equal(false);
        expect((connection as any).reconnectTimer).to.not.equal(undefined);
        expect((connection as any).blocksQueue.isPaused).to.equal(false);
    });

    it('passes a block with no traces through to the consumer when allow_empty_traces is set', async () => {
        server = new WebSocketServer({ port: 0 });
        const port = await listen(server);

        const driven = driveConnection(port, { allow_empty_traces: true });
        connection = driven.connection;

        (connection as any).stopped = false;
        connection.connect();
        await new Promise((resolve) => setTimeout(resolve, 50));

        await connection.onMessage(payloadlessBlockMessage(391178535));
        await (connection as any).blocksQueue.onIdle();

        expect(driven.consumed).to.have.length(1);
        expect(driven.consumed[0]?.block.block_num).to.equal(391178535);
        expect(driven.consumed[0]?.traces).to.deep.equal([]);
        expect(driven.warnings.some((m) => m.includes('does not contain trace data'))).to.equal(true);

        // An opted-in consumer must see no recovery machinery at all: the block
        // is normal traffic, not a failure.
        expect(connection.getMissingDataFailures()).to.equal(0);
        expect((connection as any).connected).to.equal(true);
        expect((connection as any).reconnectTimer).to.equal(undefined);
        expect((connection as any).shipOptions.start_block_num).to.equal(391178536);
    });

    it('clears the missing-data failure count once a block processes end to end', async () => {
        server = new WebSocketServer({ port: 0 });
        const port = await listen(server);

        const driven = driveConnection(port, { allow_empty_traces: true });
        connection = driven.connection;

        (connection as any).stopped = false;
        connection.connect();
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Stand in for three failed cycles already behind this connection.
        (connection as any).missingDataFailures = 3;

        await connection.onMessage(payloadlessBlockMessage(391178535));
        await (connection as any).blocksQueue.onIdle();

        expect(driven.consumed).to.have.length(1);
        expect(connection.getMissingDataFailures()).to.equal(0);
    });

    it('guards the ack send instead of throwing when the socket tears down mid in-flight task', async () => {
        server = new WebSocketServer({ port: 0 });
        const port = await listen(server);

        const driven = driveConnection(port, { allow_empty_traces: true, min_block_confirmation: 1 });
        connection = driven.connection;

        // Parks the queued task mid-await (inside processBlock()'s
        // this.consumer.consume() call) until the test releases it, so a
        // teardown can be injected while the task is running, not queued.
        let releaseConsume: () => void = () => undefined;
        const consumeStarted = new Promise<void>((resolve) => {
            (connection as any).consumer = {
                consume: async (block: any) => {
                    driven.consumed.push(block);
                    resolve();
                    await new Promise<void>((r) => (releaseConsume = r));
                },
            };
        });

        // Intercepts the promise blocksQueue.add() returns for the queued
        // task so the test can assert on it directly instead of relying on
        // process-level unhandledRejection timing.
        const blocksQueue = (connection as any).blocksQueue;
        const originalAdd = blocksQueue.add.bind(blocksQueue);
        let taskPromise: Promise<unknown> | undefined;
        blocksQueue.add = (fn: () => Promise<unknown>, options?: unknown) => {
            taskPromise = originalAdd(fn, options);
            return taskPromise;
        };

        (connection as any).stopped = false;
        connection.connect();
        await new Promise((resolve) => setTimeout(resolve, 50));

        await connection.onMessage(payloadlessBlockMessage(391178535));
        await consumeStarted;

        // A second missing-data failure arrives while the first block's task
        // is still parked mid-await: clear() cannot reach it (already
        // running, not queued), and terminate() tears down ws/shipAbi
        // underneath it via onClose().
        (connection as any).handleMissingBlockData('trace', 391178536);
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect((connection as any).ws).to.equal(undefined);
        expect((connection as any).shipAbi).to.equal(undefined);

        releaseConsume();

        let taskError: unknown;
        await taskPromise!.catch((e) => {
            taskError = e;
        });

        expect(taskError).to.equal(undefined);
    });

    it('keeps the missing-data count when an in-flight task finishes after a teardown', async () => {
        server = new WebSocketServer({ port: 0 });
        const port = await listen(server);

        const driven = driveConnection(port, { allow_empty_traces: true, min_block_confirmation: 1 });
        connection = driven.connection;

        let releaseConsume: () => void = () => undefined;
        const consumeStarted = new Promise<void>((resolve) => {
            (connection as any).consumer = {
                consume: async (block: any) => {
                    driven.consumed.push(block);
                    resolve();
                    await new Promise<void>((r) => (releaseConsume = r));
                },
            };
        });

        (connection as any).stopped = false;
        connection.connect();
        await new Promise((resolve) => setTimeout(resolve, 50));

        await connection.onMessage(payloadlessBlockMessage(391178535));
        await consumeStarted;

        (connection as any).handleMissingBlockData('trace', 391178536);
        const failuresAtTeardown = connection.getMissingDataFailures();

        // The parked task completes against the dead connection. Its
        // end-to-end success says nothing about the connection now being
        // retried, so it must not zero the count the escalation runs on.
        releaseConsume();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(connection.getMissingDataFailures()).to.equal(failuresAtTeardown);
        expect(failuresAtTeardown).to.be.greaterThan(0);
    });
});

describe('StateHistoryConnection missing-data backoff', () => {
    let connection: StateHistoryConnection;

    afterEach(() => {
        connection.stopProcessing();
    });

    it('escalates the reconnect delay per consecutive failure and caps it', () => {
        // A cursor below the node's retention floor fails identically on every
        // attempt, and onConnect() resets reconnectDelay on each successful
        // handshake, so the escalation has to key off the failure count or the
        // reader would hammer the node at the base delay indefinitely.
        connection = new StateHistoryConnection({ endpoint: 'ws://127.0.0.1:1' });
        connection.on('error', () => undefined);

        const delays: number[] = [];

        for (let i = 0; i < 6; i += 1) {
            (connection as any).handleMissingBlockData('trace', 391178535 + i);
            delays.push((connection as any).reconnectDelay);
        }

        expect(delays).to.deep.equal([5000, 10000, 20000, 40000, 60000, 60000]);
        expect(connection.getMissingDataFailures()).to.equal(6);
        expect((connection as any).blocksQueue.isPaused).to.equal(false);
    });
});
