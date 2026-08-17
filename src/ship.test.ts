import { expect } from 'chai';
import { WebSocketServer } from 'ws';
import { AddressInfo } from 'net';
import { ABI } from '@wharfkit/antelope';

import { StateHistoryConnection } from './ship';
import { deserializeEosioType, serializeEosioType } from './deserializer/serialization';
import { EOSJsDeserializer } from './deserializer/eos-js-deserializer';
import { IShipConnectionOptions } from './types/ship';

function listen(server: WebSocketServer): Promise<number> {
    return new Promise((resolve) => {
        server.on('listening', () => resolve((server.address() as AddressInfo).port));
    });
}

// Minimal stand-in for the SHIP ABI, carrying what onMessage() reads off a
// get_blocks_result_v0 or a get_blocks_result_v2 (the block positions, the three
// optional payloads, and the signed block a version 2 result carries as bytes)
// plus the ack request the client sends back.
// Real nodes send a much larger ABI, but every field below is named and typed
// as the state_history_plugin declares it, so a response built here decodes
// through the package's own deserializer exactly as a live one would.
const shipAbiJson = {
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
        {
            name: 'get_blocks_result_v2',
            base: '',
            fields: [
                { name: 'head', type: 'block_position' },
                { name: 'last_irreversible', type: 'block_position' },
                { name: 'this_block', type: 'block_position?' },
                { name: 'prev_block', type: 'block_position?' },
                // Version 2 ships the block as bytes holding a serialized
                // signed_block_variant, where version 1 ships the variant itself.
                { name: 'block', type: 'bytes?' },
                { name: 'traces', type: 'bytes?' },
                { name: 'deltas', type: 'bytes?' },
            ],
        },
        {
            name: 'signed_block_header',
            base: '',
            fields: [
                { name: 'timestamp', type: 'block_timestamp_type' },
                { name: 'producer', type: 'name' },
                { name: 'confirmed', type: 'uint16' },
                { name: 'previous', type: 'checksum256' },
                { name: 'transaction_mroot', type: 'checksum256' },
                { name: 'action_mroot', type: 'checksum256' },
                { name: 'schedule_version', type: 'uint32' },
            ],
        },
        { name: 'signed_block_v0', base: 'signed_block_header', fields: [] },
        { name: 'signed_block_v1', base: 'signed_block_header', fields: [] },
        {
            name: 'get_blocks_ack_request_v0',
            base: '',
            fields: [{ name: 'num_messages', type: 'uint32' }],
        },
    ],
    variants: [
        { name: 'result', types: ['get_blocks_result_v0', 'get_blocks_result_v2'] },
        { name: 'signed_block_variant', types: ['signed_block_v0', 'signed_block_v1'] },
        { name: 'request', types: ['get_blocks_ack_request_v0'] },
    ],
    actions: [],
    tables: [],
    ricardian_clauses: [],
};

const shipAbi = ABI.from(shipAbiJson);

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

/**
 * A get_blocks_result_v2 whose block field holds a serialized
 * signed_block_variant, the shape a node serves at version 2. The variant
 * member is a parameter so a test can send the one the client unwraps
 * (signed_block_v1) or one it has to reject.
 */
function versionedBlockMessage(blockNum: number, blockVariant: string): Uint8Array {
    const block = serializeEosioType(
        'signed_block_variant',
        [
            blockVariant,
            {
                // The block_timestamp epoch: a fixture value, not a slot any
                // assertion depends on.
                timestamp: '2000-01-01T00:00:00.000',
                producer: 'eosio',
                confirmed: 0,
                previous: BLOCK_ID,
                transaction_mroot: BLOCK_ID,
                action_mroot: BLOCK_ID,
                schedule_version: 3,
            },
        ],
        shipAbi
    );

    return serializeEosioType(
        'result',
        [
            'get_blocks_result_v2',
            {
                head: { block_num: blockNum + 10, block_id: BLOCK_ID },
                last_irreversible: { block_num: blockNum - 1, block_id: BLOCK_ID },
                this_block: { block_num: blockNum, block_id: BLOCK_ID },
                prev_block: { block_num: blockNum - 1, block_id: BLOCK_ID },
                block,
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
 * the one under test). min_block_confirmation is parked high unless a caller
 * lowers it, so a processed block only reaches send() where a test wants it to.
 * A caller whose payload has to decode for real passes an initialized
 * deserializer; the default stub returns nothing and suits the tests that never
 * put a block payload on the wire.
 */
function driveConnection(
    port: number,
    connectionOptions: IShipConnectionOptions,
    deserializer?: EOSJsDeserializer
): IDrivenConnection {
    const connection = new StateHistoryConnection({
        endpoint: `ws://127.0.0.1:${port}`,
        deserializer: (deserializer ?? {
            init: async () => undefined,
            deserialize: async () => [],
            terminate: async () => undefined,
        }) as any,
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

interface IReceivedAck {
    numMessages: number;
    receivedAt: number;
}

/**
 * Acks the fake node received, decoded back through the stub ABI. An ack is the
 * only thing the client sends in these tests, so the array is the ack cadence.
 */
function collectAcks(server: WebSocketServer): IReceivedAck[] {
    const acks: IReceivedAck[] = [];

    server.on('connection', (ws) => {
        ws.on('message', (data: Buffer) => {
            const [, request] = deserializeEosioType('request', Uint8Array.from(data), shipAbi);

            acks.push({ numMessages: request.num_messages, receivedAt: Date.now() });
        });
    });

    return acks;
}

/**
 * Parks every block inside consume() until the returned function releases one,
 * so each ack decision runs at a queue depth the test controls.
 */
function gateConsumer(driven: IDrivenConnection): () => Promise<void> {
    const parked: Array<() => void> = [];

    (driven.connection as any).consumer = {
        consume: async (block: any) => {
            driven.consumed.push(block);

            await new Promise<void>((resolve) => parked.push(resolve));
        },
    };

    return async function releaseOne(): Promise<void> {
        const release = parked.shift();

        if (!release) {
            throw new Error('No block is parked inside consume()');
        }

        release();

        // Let the released task reach its ack decision and the next queued block
        // reach its own park before the caller asserts.
        await new Promise((resolve) => setTimeout(resolve, 10));
    };
}

describe('StateHistoryConnection ack backpressure', () => {
    let server: WebSocketServer;
    let connection: StateHistoryConnection;

    afterEach(async () => {
        (connection as any).stopProcessing();
        (connection as any).ws?.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function connectDriven(connectionOptions: IShipConnectionOptions): Promise<IDrivenConnection> {
        const port = await listen(server);
        const driven = driveConnection(port, { allow_empty_traces: true, ...connectionOptions });

        connection = driven.connection;

        (connection as any).stopped = false;
        connection.connect();
        await new Promise((resolve) => setTimeout(resolve, 50));

        return driven;
    }

    // Four blocks arrive while the consumer is parked, so the running block's
    // ack decision sees three queued behind it, the next sees two, then one.
    async function feedFourBlocks(driven: IDrivenConnection): Promise<void> {
        for (let i = 0; i < 4; i += 1) {
            await driven.connection.onMessage(payloadlessBlockMessage(391178535 + i));
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    it('withholds the ack while the block queue sits at or above max_blocks_queue', async () => {
        server = new WebSocketServer({ port: 0 });
        const acks = collectAcks(server);

        const driven = await connectDriven({ min_block_confirmation: 1, max_blocks_queue: 2 });
        const releaseOne = gateConsumer(driven);

        await feedFourBlocks(driven);

        // Both ack decisions run at a depth of at least two, the ceiling, so
        // neither confirmation reaches the node.
        await releaseOne();
        await releaseOne();

        expect(driven.consumed).to.have.length(3);
        expect(connection.getQueueSize()).to.equal(1);
        expect(acks).to.have.length(0);
        expect((connection as any).unconfirmed).to.equal(2);
    });

    it('sends the accumulated count in one ack once the queue drains under the threshold', async () => {
        server = new WebSocketServer({ port: 0 });
        const acks = collectAcks(server);

        const driven = await connectDriven({ min_block_confirmation: 1, max_blocks_queue: 2 });
        const releaseOne = gateConsumer(driven);

        await feedFourBlocks(driven);

        await releaseOne();
        await releaseOne();

        expect(acks).to.have.length(0);

        // The third block acks at a depth of one, under the ceiling, so the two
        // withheld confirmations go out with it as a single ack.
        await releaseOne();

        expect(acks.map((ack) => ack.numMessages)).to.deep.equal([3]);
        expect((connection as any).unconfirmed).to.equal(0);
    });

    it('keeps the min_block_confirmation cadence when max_blocks_queue is 0', async () => {
        server = new WebSocketServer({ port: 0 });
        const acks = collectAcks(server);

        const driven = await connectDriven({ min_block_confirmation: 2, max_blocks_queue: 0 });
        const releaseOne = gateConsumer(driven);

        await feedFourBlocks(driven);

        for (let i = 0; i < 4; i += 1) {
            await releaseOne();
        }

        // The second block acks at a depth of two, which any non-zero ceiling of
        // two or less would withhold. Zero applies no ceiling at all.
        expect(acks.map((ack) => ack.numMessages)).to.deep.equal([2, 2]);
        expect(connection.getQueueSize()).to.equal(0);
    });

    it('keeps the socket when backpressure holds the ack longer than idle_timeout_ms', async () => {
        server = new WebSocketServer({ port: 0 });
        const acks = collectAcks(server);

        const idleTimeoutMs = 100;
        const driven = await connectDriven({
            min_block_confirmation: 1,
            max_blocks_queue: 3,
            heartbeat_interval_ms: 25,
            idle_timeout_ms: idleTimeoutMs,
        });

        // Twelve blocks at 30ms each hold the queue above the ceiling for nine of
        // them, so the client sends nothing for several times idle_timeout_ms.
        (connection as any).consumer = {
            consume: async (block: any) => {
                driven.consumed.push(block);

                await new Promise((resolve) => setTimeout(resolve, 30));
            },
        };

        const startedAt = Date.now();

        for (let i = 0; i < 12; i += 1) {
            await connection.onMessage(payloadlessBlockMessage(391178535 + i));
        }

        await (connection as any).blocksQueue.onIdle();

        expect(driven.consumed).to.have.length(12);
        // The first ack only leaves once the queue drains under the ceiling,
        // which is well past the window the idle watchdog tears down on.
        expect(acks[0]?.receivedAt).to.be.greaterThanOrEqual(startedAt + idleTimeoutMs);
        expect(driven.warnings.some((w) => w.includes('terminating dead connection'))).to.equal(false);
        expect(driven.errors).to.deep.equal([]);
        expect((connection as any).connected).to.equal(true);
        expect((connection as any).reconnectTimer).to.equal(undefined);
    });
});

describe('StateHistoryConnection get_blocks_result_v2', () => {
    let server: WebSocketServer;
    let connection: StateHistoryConnection;

    afterEach(async () => {
        (connection as any).stopProcessing();
        (connection as any).ws?.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    // The block in a version 2 result only exists as bytes, so these tests run
    // the real deserializer over the stub ABI instead of the stub deserializer
    // the payloadless tests use.
    async function connectDriven(): Promise<IDrivenConnection> {
        const port = await listen(server);
        const deserializer = new EOSJsDeserializer({ threads: 0 });

        await deserializer.init(shipAbiJson);

        const driven = driveConnection(port, { allow_empty_traces: true }, deserializer);

        connection = driven.connection;

        (connection as any).stopped = false;
        connection.connect();
        await new Promise((resolve) => setTimeout(resolve, 50));

        return driven;
    }

    it('unwraps the signed_block_v1 a v2 result carries and passes the block to the consumer', async () => {
        server = new WebSocketServer({ port: 0 });

        const driven = await connectDriven();

        await connection.onMessage(versionedBlockMessage(391178535, 'signed_block_v1'));
        await (connection as any).blocksQueue.onIdle();

        expect(driven.consumed).to.have.length(1);

        // The consumer sees the same merge the v0 and v1 paths produce: the
        // unwrapped block fields over this_block, with head and last_irreversible
        // attached.
        const block = driven.consumed[0]?.block as any;

        expect(block.block_num).to.equal(391178535);
        expect(block.block_id).to.equal(BLOCK_ID);
        expect(block.producer).to.equal('eosio');
        expect(block.schedule_version).to.equal(3);
        expect(block.head.block_num).to.equal(391178545);
        expect(block.last_irreversible.block_num).to.equal(391178534);
        expect((connection as any).shipOptions.start_block_num).to.equal(391178536);
    });

    it('errors and pauses the queue when a v2 result carries an unsupported block variant', async () => {
        server = new WebSocketServer({ port: 0 });

        const driven = await connectDriven();

        // The package leaves the queued task's rejection unhandled on purpose,
        // so capture it here instead of letting it fail the run as an
        // unhandledRejection.
        const blocksQueue = (connection as any).blocksQueue;
        const originalAdd = blocksQueue.add.bind(blocksQueue);
        let taskError: unknown;
        blocksQueue.add = (fn: () => Promise<unknown>, options?: unknown) =>
            originalAdd(fn, options).catch((e: unknown) => {
                taskError = e;
            });

        await connection.onMessage(versionedBlockMessage(391178535, 'signed_block_v0'));
        await blocksQueue.onIdle();
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(driven.consumed).to.have.length(0);
        expect(blocksQueue.isPaused).to.equal(true);
        expect((taskError as Error).message).to.equal('Unsupported table block type received signed_block_v0');
        expect(
            driven.errors.some(
                (m) =>
                    m.includes('Failed to deserialize Block at block #391178535') &&
                    m.includes('Unsupported table block type received signed_block_v0')
            )
        ).to.equal(true);
    });
});
