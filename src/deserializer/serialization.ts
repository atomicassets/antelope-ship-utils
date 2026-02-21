import { Serialize } from 'eosjs';
import { Abi } from 'eosjs/dist/eosjs-rpc-interfaces';

import {
    IExtractedShipDelta,
    IExtractedShipTrace,
    ShipBlock,
    ShipTableDelta,
    ShipTransactionTrace,
} from '../types/ship';
import { EosioActionTrace, EosioTransaction } from '../types/leap';
import { createAbiTypes, getTypesFromAbi, SerialBuffer, supportedAbiVersion } from 'eosjs/dist/eosjs-serialize';

export function convertEosioTimestampToDate(timestamp: string): Date {
    return new Date(timestamp + '+0000');
}

export function deserializeEosioType(
    type: string,
    data: Uint8Array | string,
    types: Map<string, Serialize.Type>,
    checkLength: boolean = true
): any {
    let dataArray;
    if (typeof data === 'string') {
        dataArray = Uint8Array.from(Buffer.from(data, 'hex'));
    } else {
        dataArray = data;
    }

    const buffer = new Serialize.SerialBuffer({
        textEncoder: new TextEncoder(),
        textDecoder: new TextDecoder(),
        array: dataArray,
    });

    const result = Serialize.getType(types, type).deserialize(
        buffer,
        new Serialize.SerializerState({ bytesAsUint8Array: true })
    );

    if (buffer.readPos !== data.length && checkLength) {
        throw new Error('Deserialization error: ' + type);
    }

    return result;
}

export function serializeEosioType(type: string, value: any, types: Map<string, Serialize.Type>): Uint8Array {
    const buffer = new Serialize.SerialBuffer({ textEncoder: new TextEncoder(), textDecoder: new TextDecoder() });

    Serialize.getType(types, type).serialize(buffer, value);

    return buffer.asUint8Array();
}

export function extractShipTraces({
    traces: data,
}: {
    traces: ShipTransactionTrace[];
    block: ShipBlock;
}): IExtractedShipTrace[] {
    const transactions: EosioTransaction<Uint8Array>[] = [];

    for (const transaction of data) {
        if (transaction[0] === 'transaction_trace_v0') {
            if (transaction[1].status !== 0) {
                continue;
            }

            const traces = transaction[1].action_traces.reduce((acc, trace) => {
                if (trace[0] === 'action_trace_v0' || trace[0] === 'action_trace_v1') {
                    if (trace[1].receiver !== trace[1].act.account) {
                        return acc;
                    }

                    acc.push({
                        action_ordinal: trace[1].action_ordinal,
                        creator_action_ordinal: trace[1].creator_action_ordinal,
                        global_sequence: trace[1].receipt[1].global_sequence,
                        account_ram_deltas: trace[1].account_ram_deltas,
                        act: {
                            account: trace[1].act.account,
                            name: trace[1].act.name,
                            authorization: trace[1].act.authorization,
                            data: trace[1].act.data,
                        },
                    });
                    return acc;
                }

                throw new Error(`Invalid action trace type ${trace[0]}`);
            }, [] as EosioActionTrace<Uint8Array>[]);

            transactions.push({
                id: transaction[1].id,
                cpu_usage_us: transaction[1].cpu_usage_us,
                net_usage_words: transaction[1].net_usage_words,
                traces: traces.sort((a, b) => {
                    return parseInt(a.global_sequence, 10) - parseInt(b.global_sequence, 10);
                }),
            });
        } else {
            throw new Error(`Unsupported transaction response received: ${transaction[0]}`);
        }
    }

    const result: IExtractedShipTrace[] = [];
    for (const tx of transactions) {
        for (const trace of tx.traces) {
            result.push({ trace, tx });
        }
    }

    // TODO: Do we need this?
    result.sort((a, b) => {
        return parseInt(a.trace.global_sequence, 10) - parseInt(b.trace.global_sequence, 10);
    });

    return result;
}

export function extractShipDeltas({
    deltas,
    serializedDeltas = [],
}: {
    deltas: ShipTableDelta<Uint8Array>[];
    serializedDeltas?: string[];
    block: ShipBlock;
}): IExtractedShipDelta<Uint8Array>[] {
    const result: IExtractedShipDelta[] = [];

    for (const [deltaType, deltaData] of deltas) {
        if (deltaType === 'table_delta_v0' || deltaType === 'table_delta_v1') {
            if (serializedDeltas.includes(deltaData.name)) {
                if (deltaData.name === 'contract_row') {
                    for (const row of deltaData.rows) {
                        if (row.data[0] === 'contract_row_v0') {
                            result.push({ delta: { ...row.data[1], present: !!row.present } });
                        } else {
                            throw new Error(`Unsupported contract row received: ${row.data[0]}`);
                        }
                    }
                }
            }
        } else {
            throw new Error(`Unsupported table delta response received: ${deltaType}`);
        }
    }

    return result;
}

export function getTableAbiType(abi: Abi, contract: string, table: string): string {
    for (const row of abi.tables) {
        if (row.name === table) {
            return row.type;
        }
    }

    throw new Error(`Type for table not found ${contract}:${table}`);
}

export function getActionAbiType(abi: Abi, contract: string, action: string): string {
    for (const row of abi.actions) {
        if (row.name === action) {
            return row.type;
        }
    }

    throw new Error(`Type for action not found ${contract}:${action}`);
}

export function deserializeAbi(serializedAbi: Uint8Array): Abi {
    const buffer = new SerialBuffer({
        textEncoder: new TextEncoder(),
        textDecoder: new TextDecoder(),
        array: serializedAbi,
    });

    if (!supportedAbiVersion(buffer.getString())) {
        throw new Error('Unsupported abi version');
    }
    buffer.restartRead();
    const abiTypes = getTypesFromAbi(createAbiTypes());
    return abiTypes.get('abi_def').deserialize(buffer);
}
