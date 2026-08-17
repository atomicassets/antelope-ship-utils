import PQueue from 'p-queue';
import { ABI } from '@wharfkit/antelope';
import WebSocket from 'ws';
import { EventEmitter } from 'events';

import { IBlockRequest, IShipConnectionOptions, ShipBlockResponse } from './types/ship';
import { deserializeEosioType, serializeEosioType } from './deserializer/serialization';
import ShipError from './error/ship';
import { IShipConsumer } from './types/interfaces';
import { oneLine, oneLineTrim } from 'common-tags';
import { EOSJsDeserializer } from './deserializer/eos-js-deserializer';

interface IStateHistoryConnectionParams {
    endpoint: string;
    connectionOptions?: IShipConnectionOptions;
    deserializer?: EOSJsDeserializer;
}

export class StateHistoryConnection extends EventEmitter {
    private readonly endpoint: string;
    private connectionOptions: Required<IShipConnectionOptions>;
    // Every field of IBlockRequest is individually optional (it also serves as a
    // caller-supplied partial override in startProcessing()), but this instance's
    // copy is always fully populated: the constructor seeds it with defaults, and
    // startProcessing() merges caller overrides on top of those same defaults.
    private shipOptions: Required<IBlockRequest>;

    // Only set while a consumer is actively driving this connection (startProcessing()
    // sets it, stopProcessing() clears it back to undefined).
    private consumer?: IShipConsumer;
    private requiredDeltas: string[];

    private shipAbi?: ABI;

    private ws?: WebSocket;

    private connected: boolean;
    private connecting: boolean;
    private stopped: boolean;

    private blocksQueue: PQueue;
    private deserializer: EOSJsDeserializer;

    private unconfirmed = 0;
    private reconnectDelay: number;

    // Consecutive block/trace/delta payloads the node served empty while the
    // matching fetch_* flag was on and the consumer did not opt into empty
    // data. Drives the reconnect escalation in handleMissingBlockData() and is
    // exported through getMissingDataFailures().
    private missingDataFailures = 0;

    // Bumped whenever handleMissingBlockData() tears the connection down. A
    // queued task captures it at entry, so work that started before the
    // teardown can tell it belongs to a dead connection and skip both the
    // failure-counter reset and the ack.
    private connectionGeneration = 0;

    private lastActivityAt = 0;
    private heartbeatTimer?: NodeJS.Timeout;
    private reconnectTimer?: NodeJS.Timeout;

    private static readonly INITIAL_RECONNECT_DELAY_MS = 5000;
    private static readonly MAX_RECONNECT_DELAY_MS = 60000;

    constructor(params: IStateHistoryConnectionParams) {
        super();
        this.endpoint = params.endpoint;
        this.connectionOptions = {
            min_block_confirmation: 1,
            allow_empty_deltas: false,
            allow_empty_traces: false,
            allow_empty_blocks: false,
            heartbeat_interval_ms: 30 * 1000,
            idle_timeout_ms: 300 * 1000,
            max_blocks_queue: 0,
            ...(params.connectionOptions || {}),
        };

        this.deserializer = params.deserializer || new EOSJsDeserializer({ threads: 0 });

        this.connected = false;
        this.connecting = false;
        this.stopped = true;
        this.reconnectDelay = StateHistoryConnection.INITIAL_RECONNECT_DELAY_MS;

        this.blocksQueue = new PQueue({ concurrency: 1, autoStart: true });

        this.requiredDeltas = [];

        // Real values are supplied by startProcessing(), which rebuilds this from the
        // same defaults and layers the caller's overrides on top before any block
        // request is sent.
        this.shipOptions = StateHistoryConnection.createDefaultShipOptions();
    }

    // A factory (not a shared constant) because have_positions is a mutable array:
    // a shared default would let every instance's positions bleed into each other.
    private static createDefaultShipOptions(): Required<IBlockRequest> {
        return {
            start_block_num: 0,
            end_block_num: 0xffffffff,
            max_messages_in_flight: 1,
            have_positions: [],
            irreversible_only: false,
            fetch_block: false,
            fetch_traces: false,
            fetch_deltas: false,
        };
    }

    connect(): void {
        if (!this.connected && !this.connecting && !this.stopped) {
            this.emit('info', `Connecting to ship endpoint ${this.endpoint}`);

            this.connecting = true;

            // SHIP frames are large binary payloads, and the ws client default would
            // negotiate compression with any server offering it, at a CPU cost per frame.
            this.ws = new WebSocket(this.endpoint, {
                perMessageDeflate: false,
                maxPayload: 16 * 1024 * 1024 * 1024,
            });

            // Captured so the 'error'/'close' handlers below can tell a stale
            // socket's late event apart from the currently active one: once
            // onClose() or a fresh connect() replaces this.ws, an event still
            // in flight from the old socket must not touch the new state.
            const socket = this.ws;

            socket.on('open', () => this.onConnect());
            socket.on('message', (data: any) => {
                this.lastActivityAt = Date.now();
                this.onMessage(data);
            });
            socket.on('pong', () => {
                this.lastActivityAt = Date.now();
            });
            socket.on('close', () => {
                if (this.ws !== socket) {
                    return;
                }

                this.onClose().catch((closeError) => {
                    this.emit('error', new ShipError('Failed to close Ship connection cleanly', closeError));
                });
            });
            socket.on('error', (e: Error) => {
                if (this.ws !== socket) {
                    return;
                }

                // 'close' normally drives onClose() -> reconnect(), but is not
                // guaranteed to fire after every 'error' (e.g. some errors never
                // reach a close frame). Clear the connecting latch and schedule
                // a reconnect here too so a missing 'close' can't permanently
                // stall the reader. reconnect() itself is idempotent against a
                // 'close' that follows and also calls it.
                this.connecting = false;

                this.emit('error', new ShipError('Websocket Error', e));

                this.reconnect();
            });
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();

        this.lastActivityAt = Date.now();
        this.heartbeatTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return;
            }

            if (Date.now() - this.lastActivityAt > this.connectionOptions.idle_timeout_ms) {
                this.emit(
                    'warning',
                    oneLineTrim`No ship traffic for ${this.connectionOptions.idle_timeout_ms / 1000}s,
                        terminating dead connection to force a reconnect`
                );

                // terminate() destroys the socket immediately and fires 'close',
                // which routes through onClose() -> reconnect(). A graceful
                // close() would wait for a close frame the dead peer never sends.
                this.ws.terminate();

                return;
            }

            try {
                this.ws.ping();
            } catch (e) {
                this.emit('error', new ShipError('Websocket ping failed', e));
            }
        }, this.connectionOptions.heartbeat_interval_ms);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    reconnect(): void {
        if (this.stopped || this.connecting || this.connected) {
            return;
        }

        // A reconnect timer is already pending (e.g. 'error' scheduled one and
        // the following 'close' called reconnect() again) - never schedule a
        // second one, and never double the backoff for a call that didn't
        // actually schedule anything.
        if (this.reconnectTimer) {
            return;
        }

        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, StateHistoryConnection.MAX_RECONNECT_DELAY_MS);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;

            this.emit('info', `Reconnecting to Ship in ${delay / 1000}s...`);

            this.connect();
        }, delay);
    }

    send(request: [string, any]): void {
        if (!this.ws || !this.shipAbi) {
            throw new Error('Cannot send a ship request before the connection and ABI are ready');
        }

        this.ws.send(serializeEosioType('request', request, this.shipAbi));
    }

    onConnect(): void {
        this.connected = true;
        this.connecting = false;
        this.reconnectDelay = StateHistoryConnection.INITIAL_RECONNECT_DELAY_MS;

        this.startHeartbeat();
    }

    getQueueSize(): number {
        return this.blocksQueue.size;
    }

    /**
     * Consecutive blocks the node served without the block/trace/delta payload
     * the request asked for. Non-zero means this connection is retrying rather
     * than reading; it resets as soon as a block processes end to end.
     */
    getMissingDataFailures(): number {
        return this.missingDataFailures;
    }

    /**
     * A block arrived without a payload the request asked for and the consumer
     * did not opt into empty data. Recover by reconnecting, never by pausing:
     * nothing outside startProcessing() restarts blocksQueue, so a pause here
     * silences the reader for the whole life of the process, and the idle
     * watchdog cannot rescue it either because the peer keeps answering pings
     * on a socket that is delivering nothing.
     *
     * The usual cause is a start block below the node's state-history
     * retention floor, which repeats on every attempt, so the delay escalates
     * off the failure count rather than off the socket lifecycle: the
     * handshake keeps succeeding and onConnect() resets reconnectDelay each
     * time, which would otherwise pin the retry at the base delay forever.
     */
    private handleMissingBlockData(kind: 'block' | 'trace' | 'delta', blockNum: number): void {
        this.missingDataFailures += 1;
        this.connectionGeneration += 1;

        this.reconnectDelay = Math.min(
            StateHistoryConnection.INITIAL_RECONNECT_DELAY_MS * 2 ** (this.missingDataFailures - 1),
            StateHistoryConnection.MAX_RECONNECT_DELAY_MS
        );

        this.emit(
            'error',
            new ShipError(
                oneLine`Block #${blockNum} does not contain ${kind} data,
                    reconnecting in ${this.reconnectDelay / 1000}s
                    (consecutive missing-data failures: ${this.missingDataFailures}).
                    A start block below the ship node's state-history retention floor is the usual cause.`
            )
        );

        // clear() only drops queued-but-unstarted blocks; a task already
        // mid-await survives it and is what the ack-send guard in onMessage()
        // below is for. onClose() clears the queue again and reconnect()
        // schedules the retry with the delay set above.
        this.blocksQueue.clear();

        // terminate() fires 'close', which routes through onClose() -> reconnect().
        // A missing socket means onClose() already ran and already scheduled one.
        this.ws?.terminate();
    }

    async onMessage(data: any): Promise<void> {
        try {
            if (!this.shipAbi) {
                this.emit('info', 'Receiving ABI from ship...');
                const abiJson = JSON.parse(data);
                this.shipAbi = ABI.from(abiJson);

                await this.deserializer.init(abiJson);

                if (!this.stopped) {
                    this.requestBlocks();
                }
            } else {
                const [type, response] = deserializeEosioType('result', data, this.shipAbi);

                if (['get_blocks_result_v0', 'get_blocks_result_v1', 'get_blocks_result_v2'].includes(type)) {
                    const respConfig: { [key: string]: { version: number } } = {
                        get_blocks_result_v0: { version: 0 },
                        get_blocks_result_v1: { version: 1 },
                        get_blocks_result_v2: { version: 2 },
                    };

                    // type was just checked against the same three literal keys above
                    // (get_blocks_result_v0 / v1 / v2), all of which respConfig defines.
                    const resultConfig = respConfig[type]!;

                    let blockDeserialize: Promise<any>;
                    let traces: any = [];
                    let deltas: any = [];

                    if (response.this_block) {
                        if (response.block) {
                            if (resultConfig.version === 2) {
                                blockDeserialize = this.deserialize('signed_block_variant', response.block).then(
                                    (res: any) => {
                                        if (res[0] === 'signed_block_v1') {
                                            return res[1];
                                        }

                                        throw new Error(`Unsupported table block type received ${res[0]}`);
                                    }
                                );
                            } else if (resultConfig.version === 1) {
                                if (response.block[0] === 'signed_block_v1') {
                                    blockDeserialize = Promise.resolve(response.block[1]);
                                } else {
                                    blockDeserialize = Promise.reject(
                                        new Error(`Unsupported table block type received ${response.block[0]}`)
                                    );
                                }
                            } else if (resultConfig.version === 0) {
                                blockDeserialize = this.deserialize('signed_block', response.block);
                            } else {
                                blockDeserialize = Promise.reject(
                                    new Error('Unsupported table result type received ' + type)
                                );
                            }
                        } else if (this.shipOptions.fetch_block) {
                            if (this.connectionOptions.allow_empty_blocks || response.this_block.block_num <= 1) {
                                this.emit(
                                    'warning',
                                    `Block #${response.this_block.block_num} does not contain block data`
                                );
                            } else {
                                return this.handleMissingBlockData('block', response.this_block.block_num);
                            }
                        }

                        if (response.traces) {
                            traces = this.deserialize('transaction_trace[]', response.traces);
                        } else if (this.shipOptions.fetch_traces) {
                            if (this.connectionOptions.allow_empty_traces || response.this_block.block_num <= 1) {
                                this.emit(
                                    'warning',
                                    `Block #${response.this_block.block_num} does not contain trace data`
                                );
                            } else {
                                return this.handleMissingBlockData('trace', response.this_block.block_num);
                            }
                        }

                        if (response.deltas) {
                            deltas = this.deserialize('table_delta[]', response.deltas).then((res) =>
                                this.deserializeDeltas(res)
                            );
                        } else if (this.shipOptions.fetch_deltas) {
                            if (this.connectionOptions.allow_empty_deltas || response.this_block.block_num <= 1) {
                                this.emit(
                                    'warning',
                                    `Block #${response.this_block.block_num} does not contain delta data`
                                );
                            } else {
                                return this.handleMissingBlockData('delta', response.this_block.block_num);
                            }
                        }
                    }

                    this.blocksQueue
                        .add(async () => {
                            const taskGeneration = this.connectionGeneration;

                            if (response.this_block) {
                                this.shipOptions.start_block_num = response.this_block.block_num + 1;
                            } else {
                                this.shipOptions.start_block_num += 1;
                            }

                            if (response.this_block && response.last_irreversible) {
                                this.shipOptions.have_positions = this.shipOptions.have_positions.filter(
                                    (row) =>
                                        row.block_num > response.last_irreversible.block_num &&
                                        row.block_num < response.this_block.block_num
                                );

                                if (response.this_block.block_num > response.last_irreversible.block_num) {
                                    this.shipOptions.have_positions.push(response.this_block);
                                }
                            }

                            let deserializedTraces = [];
                            let deserializedDeltas = [];
                            let deserializedBlock: unknown;
                            try {
                                deserializedBlock = await blockDeserialize;
                            } catch (e) {
                                this.emit(
                                    'error',
                                    new ShipError(
                                        'Failed to deserialize Block at block #' + response.this_block.block_num,
                                        e
                                    )
                                );

                                this.blocksQueue.clear();
                                this.blocksQueue.pause();

                                throw e;
                            }

                            try {
                                deserializedTraces = await traces;
                            } catch (error) {
                                this.emit(
                                    'error',
                                    new ShipError(
                                        'Failed to deserialize traces at block #' + response.this_block.block_num,
                                        error
                                    )
                                );

                                this.blocksQueue.clear();
                                this.blocksQueue.pause();

                                throw error;
                            }

                            try {
                                deserializedDeltas = await deltas;
                            } catch (error) {
                                this.emit(
                                    'error',
                                    new ShipError(
                                        'Failed to deserialize deltas at block #' + response.this_block.block_num,
                                        error
                                    )
                                );

                                this.blocksQueue.clear();
                                this.blocksQueue.pause();

                                throw error;
                            }

                            try {
                                await this.processBlock({
                                    this_block: response.this_block,
                                    head: response.head,
                                    last_irreversible: response.last_irreversible,
                                    prev_block: response.prev_block,
                                    block: Object.assign(
                                        { ...response.this_block },
                                        deserializedBlock,
                                        { last_irreversible: response.last_irreversible },
                                        { head: response.head }
                                    ),
                                    traces: deserializedTraces,
                                    deltas: deserializedDeltas,
                                });
                            } catch (error) {
                                this.emit(
                                    'error',
                                    new ShipError(
                                        `Ship blocks queue stopped due to an error at #${response.this_block.block_num}`,
                                        error
                                    )
                                );

                                this.blocksQueue.clear();
                                this.blocksQueue.pause();

                                throw error;
                            }

                            // A block that made it end to end proves the node is
                            // serving usable payloads again, so the missing-data
                            // escalation starts over from the base delay. Skip it
                            // when a teardown started after this task did: that
                            // block belongs to the dead connection, and resetting
                            // here would wipe the count the escalation runs on.
                            if (taskGeneration === this.connectionGeneration) {
                                this.missingDataFailures = 0;
                            }

                            this.unconfirmed += 1;

                            // SHIP sends past max_messages_in_flight only once an ack
                            // arrives, so withholding the ack is the strongest
                            // backpressure the client has on the node's send side.
                            // unconfirmed keeps accumulating while it is withheld and
                            // goes out in one ack once the queue drains.
                            const maxQueue = this.connectionOptions.max_blocks_queue;
                            const queueOverloaded = maxQueue > 0 && this.blocksQueue.size >= maxQueue;

                            if (
                                this.unconfirmed >= this.connectionOptions.min_block_confirmation &&
                                !queueOverloaded
                            ) {
                                // A handleMissingBlockData() teardown that started after this
                                // task began (clear() cannot reach an already-running task)
                                // leaves this task acking into a dead connection. send() would
                                // throw into this queued task's promise, which has no rejection
                                // handler, so skip the ack and let the pending reconnect take
                                // over. The socket is checked by readyState, not presence:
                                // terminate() moves it to CLOSING/CLOSED immediately while
                                // onClose() nulls the field only once the close event fires,
                                // so a non-null ws can still reject a send.
                                if (
                                    taskGeneration !== this.connectionGeneration ||
                                    !this.ws ||
                                    !this.shipAbi ||
                                    this.ws.readyState !== WebSocket.OPEN
                                ) {
                                    this.emit(
                                        'debug',
                                        `Skipping ack for block #${response.this_block.block_num}: connection torn down mid-task`
                                    );
                                } else {
                                    this.send(['get_blocks_ack_request_v0', { num_messages: this.unconfirmed }]);
                                    this.unconfirmed = 0;
                                }
                            }
                        })
                        .then();
                } else {
                    this.emit('warning', 'Not supported message received', {
                        type,
                        response,
                    });
                }
            }
        } catch (e) {
            this.emit('error', new ShipError('error while processing message', e));

            this.ws?.close();
        }
    }

    async onClose(): Promise<void> {
        this.emit('error', new ShipError('Ship Websocket disconnected'));

        this.stopHeartbeat();

        if (this.ws) {
            this.ws.terminate();
            this.ws = undefined;
        }

        this.shipAbi = undefined;
        this.connected = false;
        this.connecting = false;

        this.blocksQueue.clear();

        try {
            await this.deserializer?.terminate();
        } catch (e) {
            // A rejection here must never skip reconnect() below - it would leave
            // the reader silently stalled with no scheduled retry.
            this.emit('error', new ShipError('Failed to terminate deserializer', e));
        }

        this.reconnect();
    }

    requestBlocks(): void {
        this.unconfirmed = 0;

        this.emit('info', `Requesting ship blocks ${JSON.stringify(this.shipOptions)}`);

        this.send(['get_blocks_request_v0', this.shipOptions]);
    }

    async startProcessing(consumer: IShipConsumer): Promise<void> {
        this.emit('info', 'Starting ship connection...');

        const requestConfig = await consumer.getRequestBlockConfig();

        this.shipOptions = {
            ...StateHistoryConnection.createDefaultShipOptions(),
            ...requestConfig,
        };

        this.requiredDeltas = consumer.getRequiredDeltas();
        this.consumer = consumer;
        this.stopped = false;

        if (this.connected && this.shipAbi) {
            this.requestBlocks();
        }

        this.blocksQueue.start();

        this.connect();
    }

    stopProcessing(): void {
        this.stopped = true;

        this.stopHeartbeat();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }

        this.consumer = undefined;
        this.requiredDeltas = [];

        this.ws?.close();

        this.blocksQueue.clear();
        this.blocksQueue.pause();
    }

    async processBlock(block: ShipBlockResponse): Promise<void> {
        if (!this.consumer) {
            throw new Error('Received a ship block before startProcessing() was called');
        }

        if (!block.this_block) {
            if (this.shipOptions.start_block_num >= this.shipOptions.end_block_num) {
                this.emit(
                    'warning',
                    `Empty block #${this.shipOptions.start_block_num} received. Reader finished reading.`
                );
            } else if (this.shipOptions.start_block_num % 10000 === 0) {
                this.emit(
                    'warning',
                    oneLineTrim`Empty block #
                        ${this.shipOptions.start_block_num}
                        received.
                        Node was likely started with a snapshot and you tried to process a block range
                        before the snapshot. Catching up until init block.`
                );
            }

            return;
        }

        await this.consumer.consume(block);

        this.emit('debug', `Block ${block.block.block_num} processed`);
    }

    private async deserialize(type: string, data: Uint8Array): Promise<any> {
        const [result] = await this.deserializer.deserialize([{ type, data }]);

        // A single-element input always yields a single-element output.
        if (!result) {
            throw new Error(`No deserialization result returned for type ${type}`);
        }

        if (result.success) {
            return result.data;
        }

        throw new Error(result.message);
    }

    private async deserializeArray(rows: Array<{ type: string; data: Uint8Array }>): Promise<any> {
        const result = await this.deserializer.deserialize(rows);

        const dsError = result.find((row) => !row.success);

        if (dsError) {
            throw new Error(dsError.message);
        }

        return result.map((row) => row.data);
    }

    private async deserializeDeltas(deltas: any[]): Promise<any> {
        return await Promise.all(
            deltas.map(async (delta: any) => {
                if (delta[0] === 'table_delta_v0' || delta[0] === 'table_delta_v1') {
                    if (this.requiredDeltas.includes(delta[1].name)) {
                        const deserialized = await this.deserializeArray(
                            delta[1].rows.map((row: any) => ({
                                type: delta[1].name,
                                data: row.data,
                            }))
                        );

                        return [
                            delta[0],
                            {
                                ...delta[1],
                                rows: delta[1].rows.map((row: any, index: number) => ({
                                    present: !!row.present,
                                    data: deserialized[index],
                                })),
                            },
                        ];
                    }

                    return delta;
                }

                throw Error('Unsupported table delta type received ' + delta[0]);
            })
        );
    }
}
