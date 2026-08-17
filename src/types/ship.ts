import { EosioActionTrace, EosioContractRow, EosioTransaction } from './leap';

export interface ITraceListenerPayload<T> {
    trace: EosioActionTrace<T>;
    tx: EosioTransaction<Uint8Array>;
    block: FullShipBlock;
}

export interface IDeltaListenerPayload<T> {
    delta: EosioContractRow<T>;
    block: FullShipBlock;
}
export interface ITraceListener<T = unknown> {
    account: string;
    name: string;
    processor: (trace: ITraceListenerPayload<T>) => Promise<unknown>;
}

export interface IDeltaListener<T = unknown> {
    contract: string;
    table: string;
    processor: (delta: IDeltaListenerPayload<T>) => Promise<unknown>;
}

export type IBlockListener = (block: FullShipBlock) => Promise<unknown>;

export interface IExtractedShipTrace<T = Uint8Array> {
    trace: EosioActionTrace<T>;
    tx: EosioTransaction<Uint8Array>;
}

export interface IExtractedShipDelta<T = Uint8Array> {
    delta: EosioContractRow<T>;
}

export interface IExtractedBlockResponse {
    traces: IExtractedShipTrace[];
    block: ShipBlock;
    deltas: Array<EosioContractRow<Uint8Array>>;
}

export interface IShipConnectionOptions {
    min_block_confirmation?: number;
    allow_empty_traces?: boolean;
    allow_empty_deltas?: boolean;
    allow_empty_blocks?: boolean;
    /** Interval between websocket pings while connected (ms). */
    heartbeat_interval_ms?: number;
    /**
     * Terminate the socket when no message or pong arrives for this long (ms).
     * A half-open TCP connection (peer gone without FIN, e.g. a load-balancer
     * endpoint swap) never emits 'close', so without this the client hangs
     * forever instead of reconnecting.
     */
    idle_timeout_ms?: number;
    /**
     * Soft ceiling on the block queue. While the queue holds at least this many
     * blocks, the client withholds the ack, which is the only lever it has on the
     * node's send side: SHIP sends past max_messages_in_flight only after an ack.
     * The accumulated count goes out in one ack once the queue drains under the
     * ceiling. Zero, the default, keeps the plain min_block_confirmation cadence.
     */
    max_blocks_queue?: number;
}

export interface IBlockRequest {
    start_block_num?: number;
    end_block_num?: number;
    max_messages_in_flight?: number;
    have_positions?: any[];
    irreversible_only?: boolean;
    fetch_block?: boolean;
    fetch_traces?: boolean;
    fetch_deltas?: boolean;
}

export type ShipBlockResponse = {
    head: { block_num: number; block_id: string };
    last_irreversible: { block_num: number; block_id: string };
    this_block: { block_num: number; block_id: string };
    prev_block: { block_num: number; block_id: string };
    block: ShipBlock;
    traces: ShipTransactionTrace[];
    deltas: ShipTableDelta[];
};

export type FullShipBlock = {
    head: { block_num: number; block_id: string };
    last_irreversible: { block_num: number; block_id: string };
    this_block: ShipBlock;
    prev_block: { block_num: number; block_id: string };
};

export type ShipBlock = {
    block_num: number;
    block_id: string;
    head: { block_num: number; block_id: string };
    last_irreversible: { block_num: number; block_id: string };
    timestamp?: string;
    producer?: string;
    confirmed?: number;
    previous?: string;
    transaction_mroot?: string;
    action_mroot?: string;
    schedule_version?: number;
    new_producers?: any | null;
    header_extensions?: any[];
    producer_signature?: string;
    transactions?: any[];
    block_extensions?: any[];
};

export type ShipTransactionTrace = [
    'transaction_trace_v0',
    {
        id: string;
        status: number;
        cpu_usage_us: number;
        net_usage_words: number;
        elapsed: string;
        net_usage: string;
        scheduled: boolean;
        action_traces: ShipActionTrace[];
        account_ram_delta: Array<{ account: string; delta: number }> | null;
        except: any | null;
        error_code: any | null;
        failed_dtrx_trace: any | null;
        partial: ShipPartialTransaction;
    }
];

export type ShipActionTrace<T = Uint8Array> = [
    'action_trace_v0',
    {
        action_ordinal: number;
        creator_action_ordinal: number;
        receipt: ShipActionReceipt;
        receiver: string;
        act: {
            account: string;
            name: string;
            authorization: Array<{ actor: string; permission: string }>;
            data: T;
        };
        context_free: boolean;
        elapsed: string;
        console: string;
        account_ram_deltas: Array<{ account: string; delta: number }>;
        except: any | null;
        error_code: any | null;
    }
];

export type ShipActionReceipt = [
    'action_receipt_v0',
    {
        receiver: string;
        act_digest: string;
        global_sequence: string;
        recv_sequence: string;
        auth_sequence: Array<{ account: string; sequence: string }>;
        code_sequence: number;
        abi_sequence: number;
    }
];

export type ShipPartialTransaction = [
    'partial_transaction_v0',
    {
        expiration: string;
        ref_block_num: number;
        ref_block_prefix: number;
        max_net_usage_words: number;
        max_cpu_usage_ms: number;
        delay_sec: number;
        transaction_extensions: any[];
        signatures: string[];
        context_free_data: any[];
    }
];

export type ShipTableDelta<T = Uint8Array> = [
    'table_delta_v0',
    {
        name: string;
        rows: Array<{ present: boolean; data: [string, EosioContractRow<T>] }>;
    }
];

export type ShipContractRow<T = Uint8Array> = [
    'contract_row_v0',
    {
        code: string;
        scope: string;
        table: string;
        primary_key: string;
        payer: string;
        value: T;
    }
];

export interface IDeserializer {
    waiting: number;

    deserialize(param: Array<{ type: string; data: Uint8Array | string; abi?: any } | undefined>): Promise<
        Array<{
            success: boolean;
            data: unknown;
            message?: string;
        }>
    >;

    terminate(): Promise<void>;
}
