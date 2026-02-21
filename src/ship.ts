import PQueue from 'p-queue';
import { Serialize } from 'eosjs';
import { Abi } from 'eosjs/dist/eosjs-rpc-interfaces';
import WebSocket from 'ws';
import { EventEmitter } from 'events';

import { IBlockRequest, IShipConnectionOptions, ShipBlockResponse } from './types/ship';
import { deserializeEosioType, serializeEosioType } from './deserializer/serialization';
import ShipError from './error/ship';
import { IShipConsumer } from './types/interfaces';
import { oneLineTrim } from 'common-tags';
import { EOSJsDeserializer } from './deserializer/eos-js-deserializer';

interface IStateHistoryConnectionParams {
    endpoint: string;
    connectionOptions?: IShipConnectionOptions;
    deserializer?: EOSJsDeserializer;
}

export class StateHistoryConnection extends EventEmitter {
    private readonly endpoint: string;
    private connectionOptions: IShipConnectionOptions;
    private shipOptions: IBlockRequest;

    private consumer: IShipConsumer;
    private requiredDeltas: string[];

    private abi?: Abi;
    private types?: Map<string, Serialize.Type>;

    private ws?: WebSocket;

    private connected: boolean;
    private connecting: boolean;
    private stopped: boolean;

    private blocksQueue: PQueue;
    private deserializer: EOSJsDeserializer;

    private unconfirmed: number;
    private reconnectDelay: number;

    constructor(params: IStateHistoryConnectionParams) {
        super();
        this.endpoint = params.endpoint;
        this.connectionOptions = {
            min_block_confirmation: 1,
            allow_empty_deltas: false,
            allow_empty_traces: false,
            allow_empty_blocks: false,
            ...(params.connectionOptions || {}),
        };

        this.deserializer = params.deserializer || new EOSJsDeserializer({ threads: 0 });

        this.connected = false;
        this.connecting = false;
        this.stopped = true;
        this.reconnectDelay = 5000;

        this.blocksQueue = new PQueue({ concurrency: 1, autoStart: true });

        this.requiredDeltas = [];
    }

    connect(): void {
        if (!this.connected && !this.connecting && !this.stopped) {
            this.emit('info', `Connecting to ship endpoint ${this.endpoint}`);

            this.connecting = true;

            this.ws = new WebSocket(this.endpoint, {
                maxPayload: 16 * 1024 * 1024 * 1024,
            });

            this.ws.on('open', () => this.onConnect());
            this.ws.on('message', (data: any) => this.onMessage(data));
            this.ws.on('close', () => this.onClose());
            this.ws.on('error', (e: Error) => {
                this.emit('error', new ShipError('Websocket Error', e));
            });
        }
    }

    reconnect(): void {
        if (this.stopped) {
            return;
        }

        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);

        setTimeout(() => {
            this.emit('info', `Reconnecting to Ship in ${delay / 1000}s...`);

            this.connect();
        }, delay);
    }

    send(request: [string, any]): void {
        this.ws.send(serializeEosioType('request', request, this.types));
    }

    onConnect(): void {
        this.connected = true;
        this.connecting = false;
        this.reconnectDelay = 5000;
    }

    getQueueSize(): number {
        return this.blocksQueue.size;
    }

    async onMessage(data: any): Promise<void> {
        try {
            if (!this.abi) {
                this.emit('info', 'Receiving ABI from ship...');
                this.abi = JSON.parse(data);
                this.types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), this.abi);

                await this.deserializer.init(this.abi);

                if (!this.stopped) {
                    this.requestBlocks();
                }
            } else {
                const [type, response] = deserializeEosioType('result', data, this.types);

                if (['get_blocks_result_v0', 'get_blocks_result_v1'].includes(type)) {
                    const respConfig: { [key: string]: { version: number } } = {
                        get_blocks_result_v0: { version: 0 },
                        get_blocks_result_v1: { version: 1 },
                        get_blocks_result_v2: { version: 2 },
                    };

                    let blockDeserialize: Promise<any>;
                    let traces: any = [];
                    let deltas: any = [];

                    if (response.this_block) {
                        if (response.block) {
                            if (respConfig[type].version === 2) {
                                blockDeserialize = this.deserialize('signed_block_variant', response.block).then(
                                    (res: any) => {
                                        if (res[0] === 'signed_block_v1') {
                                            return res[1];
                                        }

                                        throw new Error(`Unsupported table block type received ${res[0]}`);
                                    }
                                );
                            } else if (respConfig[type].version === 1) {
                                if (response.block[0] === 'signed_block_v1') {
                                    blockDeserialize = Promise.resolve(response.block[1]);
                                } else {
                                    blockDeserialize = Promise.reject(
                                        new Error(`Unsupported table block type received ${response.block[0]}`)
                                    );
                                }
                            } else if (respConfig[type].version === 0) {
                                blockDeserialize = this.deserialize('signed_block', response.block);
                            } else {
                                blockDeserialize = Promise.reject(
                                    new Error('Unsupported table result type received ' + type)
                                );
                            }
                        } else if (this.shipOptions.fetch_block) {
                            if (this.connectionOptions.allow_empty_blocks) {
                                this.emit(
                                    'warning',
                                    `Block #${response.this_block.block_num} does not contain block data`
                                );
                            } else {
                                this.emit(
                                    'error',
                                    new ShipError(`Block #${response.this_block.block_num} does not contain block data`)
                                );

                                return this.blocksQueue.pause();
                            }
                        }

                        if (response.traces) {
                            traces = this.deserialize('transaction_trace[]', response.traces);
                        } else if (this.shipOptions.fetch_traces) {
                            if (this.connectionOptions.allow_empty_traces) {
                                this.emit(
                                    'warning',
                                    `Block #${response.this_block.block_num} does not contain trace data`
                                );
                            } else {
                                this.emit(
                                    'error',
                                    new ShipError(`Block #${response.this_block.block_num} does not contain trace data`)
                                );

                                return this.blocksQueue.pause();
                            }
                        }

                        if (response.deltas) {
                            deltas = this.deserialize('table_delta[]', response.deltas).then((res) =>
                                this.deserializeDeltas(res)
                            );
                        } else if (this.shipOptions.fetch_deltas) {
                            if (this.connectionOptions.allow_empty_deltas) {
                                this.emit(
                                    'warning',
                                    `Block #${response.this_block.block_num} does not contain delta data`
                                );
                            } else {
                                this.emit(
                                    'error',
                                    new ShipError(`Block #${response.this_block.block_num} does not contain delta data`)
                                );

                                return this.blocksQueue.pause();
                            }
                        }
                    }

                    this.blocksQueue
                        .add(async () => {
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

                            this.unconfirmed += 1;

                            if (this.unconfirmed >= this.connectionOptions.min_block_confirmation) {
                                this.send(['get_blocks_ack_request_v0', { num_messages: this.unconfirmed }]);
                                this.unconfirmed = 0;
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

            this.ws.close();
        }
    }

    async onClose(): Promise<void> {
        this.emit('error', new ShipError('Ship Websocket disconnected'));

        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }

        this.abi = null;
        this.types = null;
        this.connected = false;
        this.connecting = false;

        this.blocksQueue.clear();
        await this.deserializer?.terminate();
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
            start_block_num: 0,
            end_block_num: 0xffffffff,
            max_messages_in_flight: 1,
            have_positions: [],
            irreversible_only: false,
            fetch_block: false,
            fetch_traces: false,
            fetch_deltas: false,
            ...requestConfig,
        };

        this.requiredDeltas = consumer.getRequiredDeltas();
        this.consumer = consumer;
        this.stopped = false;

        if (this.connected && this.abi) {
            this.requestBlocks();
        }

        this.blocksQueue.start();

        this.connect();
    }

    stopProcessing(): void {
        this.stopped = true;

        this.consumer = undefined;
        this.requiredDeltas = [];

        this.ws.close();

        this.blocksQueue.clear();
        this.blocksQueue.pause();
    }

    async processBlock(block: ShipBlockResponse): Promise<void> {
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
        const result = await this.deserializer.deserialize([{ type, data }]);
        if (result[0].success) {
            return result[0].data;
        }

        throw new Error(result[0].message);
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
