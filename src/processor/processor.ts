import { IAbiProvider, IBlockProcessor } from '../types/interfaces';
import {
    FullShipBlock,
    IBlockListener,
    IDeltaListener,
    IDeltaListenerPayload,
    IDeserializer,
    IExtractedShipDelta,
    IExtractedShipTrace,
    ITraceListener,
    ITraceListenerPayload,
    ShipBlock,
} from '../types/ship';
import { deserializeAbi, getActionAbiType, getTableAbiType } from '../deserializer/serialization';
import { EventEmitter } from 'events';

interface IProcessorParams {
    deserializer: IDeserializer;
    abiProvider: IAbiProvider;

    failOnDeserializationError: boolean;

    traceListeners?: ITraceListener[];
    deltaListeners?: IDeltaListener[];
    blockListeners?: IBlockListener[];
    preBlockHook?: IBlockListener[];
    postBlockHook?: IBlockListener[];
}

export class BlockProcessor extends EventEmitter implements IBlockProcessor {
    private readonly traceListeners: ITraceListener[];
    private readonly deltaListeners: IDeltaListener[];
    private readonly blockListeners: IBlockListener[];
    private readonly preBlockHooks?: IBlockListener[];
    private readonly postBlockHooks?: IBlockListener[];
    private readonly deserializer: IDeserializer;
    private readonly abiProvider: IAbiProvider;
    private readonly failOnDeserializationError: boolean;

    constructor(params: IProcessorParams) {
        super();
        this.blockListeners = params.blockListeners ? [...params.blockListeners] : [];
        this.preBlockHooks = params.preBlockHook ? [...params.preBlockHook] : [];
        this.postBlockHooks = params.postBlockHook ? [...params.postBlockHook] : [];
        this.deltaListeners = params.deltaListeners ? [...params.deltaListeners] : [];
        this.traceListeners = params.traceListeners ? [...params.traceListeners] : [];
        this.deserializer = params.deserializer;
        this.abiProvider = params.abiProvider;
        this.failOnDeserializationError = params.failOnDeserializationError;
    }

    async onBlockStart(data: { block: FullShipBlock }): Promise<void> {
        for (const p of this.preBlockHooks) {
            await p(data.block);
        }
    }

    async onBlockFinished(data: { block: FullShipBlock }): Promise<void> {
        for (const p of this.postBlockHooks) {
            await p(data.block);
        }
    }

    async processBlock({
        block,
        traces,
        deltas,
    }: {
        block: FullShipBlock;
        traces: IExtractedShipTrace<Uint8Array>[];
        deltas: IExtractedShipDelta<Uint8Array>[];
    }): Promise<void> {
        const blockStart = Date.now();

        await this.processABIUpdates({ block: block.this_block, traces });

        const abiMs = Date.now() - blockStart;

        for (const p of this.blockListeners) {
            await p(block);
        }

        const deserStart = Date.now();

        const [tracesToProcess, deltasToProcess] = await Promise.all([
            this.findAndDeserializeTraces({
                block,
                traces,
            }),
            this.findAndDeserializeDeltas({ block, deltas }),
        ]);

        const deserMs = Date.now() - deserStart;
        const listenerStart = Date.now();
        const listenerTimings: Record<string, number> = {};

        for (let i = 0; i < tracesToProcess.length; i++) {
            await Promise.all(
                tracesToProcess[i].listeners.map(async (listener) => {
                    const t0 = Date.now();
                    await listener.processor(tracesToProcess[i].data);
                    const elapsed = Date.now() - t0;
                    const key = `trace:${listener.account}:${listener.name}`;
                    listenerTimings[key] = (listenerTimings[key] || 0) + elapsed;
                })
            );
        }

        for (let i = 0; i < deltasToProcess.length; i++) {
            await Promise.all(
                deltasToProcess[i].listeners.map(async (listener) => {
                    const t0 = Date.now();
                    await listener.processor(deltasToProcess[i].data);
                    const elapsed = Date.now() - t0;
                    const key = `delta:${listener.contract}:${listener.table}`;
                    listenerTimings[key] = (listenerTimings[key] || 0) + elapsed;
                })
            );
        }

        const listenerMs = Date.now() - listenerStart;
        const totalMs = Date.now() - blockStart;

        if (totalMs > 50) {
            this.emit('timing', {
                block_num: block.this_block.block_num,
                total_ms: totalMs,
                abi_ms: abiMs,
                deser_ms: deserMs,
                listener_ms: listenerMs,
                listener_breakdown: listenerTimings,
                traces: tracesToProcess.length,
                deltas: deltasToProcess.length,
            });
        }
    }

    private findDeltaProcessors(data: IExtractedShipDelta<Uint8Array>): IDeltaListener[] {
        return this.deltaListeners.filter((dL) => {
            if (dL.contract === '*' || dL.contract === data.delta.code) {
                return dL.table === '*' || dL.table === data.delta.table;
            }
            return false;
        });
    }

    private async findAndDeserializeDeltas({
        deltas,
        block,
    }: {
        block: FullShipBlock;
        deltas: IExtractedShipDelta<Uint8Array>[];
    }): Promise<{ data: IDeltaListenerPayload<unknown>; listeners: IDeltaListener[] }[]> {
        const deltasToProcess = deltas.reduce((toProcess, d) => {
            const listeners = this.findDeltaProcessors(d);
            if (listeners.length > 0) toProcess.push({ data: d, listeners });
            return toProcess;
        }, [] as { data: IExtractedShipDelta; listeners: IDeltaListener[] }[]);

        const uniqueAccounts = [...new Set(deltas.map((t) => t.delta.code))];

        await Promise.all(
            uniqueAccounts.map((account) =>
                this.abiProvider.getAbi(account, block.this_block.block_num).catch(() => null)
            )
        );

        const deserializedDeltas = await Promise.all(
            deltasToProcess.map(async (d) => {
                try {
                    const abi = await this.abiProvider.getAbi(d.data.delta.code, block.this_block.block_num);

                    return {
                        data: d.data.delta.value,
                        abi,
                        type: getTableAbiType(abi, d.data.delta.code, d.data.delta.table),
                    };
                } catch (error) {
                    if (this.failOnDeserializationError) {
                        throw new Error(
                            `Failed to get abi for ${d.data.delta.code} at #${block.this_block.block_num} ${error}`
                        );
                    }

                    return undefined;
                }
            })
        ).then((t) => this.deserializer.deserialize(t));

        if (this.failOnDeserializationError) {
            const failedIndices = deserializedDeltas
                .map((row, i) => (!row.success ? i : -1))
                .filter((i) => i >= 0);

            if (failedIndices.length > 0 && this.abiProvider.getOlderAbis) {
                for (const idx of failedIndices) {
                    const dp = deltasToProcess[idx];
                    const olderAbis = await this.abiProvider.getOlderAbis(
                        dp.data.delta.code,
                        block.this_block.block_num,
                    );

                    for (const olderAbi of olderAbis) {
                        try {
                            const type = getTableAbiType(olderAbi, dp.data.delta.code, dp.data.delta.table);
                            const [result] = await this.deserializer.deserialize([
                                { data: dp.data.delta.value, abi: olderAbi, type },
                            ]);

                            if (result.success) {
                                deserializedDeltas[idx] = result;
                                break;
                            }
                        } catch {
                            // try next older ABI
                        }
                    }
                }
            }

            const stillFailed = deserializedDeltas
                .map((row, i) => (!row.success ? i : -1))
                .filter((i) => i >= 0);

            if (stillFailed.length > 0) {
                if (this.abiProvider.getOlderAbis) {
                    for (const idx of stillFailed) {
                        this.emit(
                            'warn',
                            `Skipping undeserializable delta (all ABI versions exhausted): ${JSON.stringify({
                                message: deserializedDeltas[idx].message,
                                code: deltasToProcess[idx].data.delta.code,
                                delta: deltasToProcess[idx].data.delta.table,
                                block_num: block.this_block.block_num,
                            })}`,
                        );
                    }
                } else {
                    throw new Error(
                        `Failed to deserialize deltas. ${JSON.stringify({
                            message: deserializedDeltas[stillFailed[0]].message,
                            code: deltasToProcess[stillFailed[0]].data.delta.code,
                            delta: deltasToProcess[stillFailed[0]].data.delta.table,
                            data: deltasToProcess[stillFailed[0]].data.delta.value,
                        })}`
                    );
                }
            }
        }

        return deltasToProcess
            .map((dp, i) => ({
                data: {
                    delta: {
                        ...dp.data.delta,
                        value: deserializedDeltas[i].data,
                    },
                    block,
                },
                listeners: dp.listeners,
                _success: deserializedDeltas[i].success,
            }))
            .filter((entry) => entry._success)
            .map(({ _success, ...entry }) => entry);
    }

    private findTraceProcessors(data: IExtractedShipTrace<Uint8Array>): ITraceListener[] {
        return this.traceListeners.filter((tL) => {
            if (data.trace.act.account === 'eosio' && data.trace.act.name === 'onblock') {
                return false;
            }

            if (data.trace.act.account === 'eosio.null') {
                return false;
            }

            if (tL.account === '*' || tL.account === data.trace.act.account) {
                return tL.name === '*' || tL.name === data.trace.act.name;
            }

            return false;
        });
    }

    private async findAndDeserializeTraces({
        block,
        traces,
    }: {
        block: FullShipBlock;
        traces: IExtractedShipTrace<Uint8Array>[];
    }): Promise<{ data: ITraceListenerPayload<unknown>; listeners: ITraceListener[] }[]> {
        const tracesToProcess = traces.reduce((toProcess, t) => {
            const listeners = this.findTraceProcessors(t);
            if (listeners.length > 0) toProcess.push({ data: t, listeners });
            return toProcess;
        }, [] as { data: IExtractedShipTrace; listeners: ITraceListener[] }[]);

        const uniqueAccounts = [...new Set(tracesToProcess.map((t) => t.data.trace.act.account))];

        await Promise.all(
            uniqueAccounts.map((account) =>
                this.abiProvider.getAbi(account, block.this_block.block_num).catch(() => null)
            )
        );

        const deserializedTraces = await Promise.all(
            tracesToProcess.map(async (t) => {
                try {
                    const abi = await this.abiProvider.getAbi(t.data.trace.act.account, block.this_block.block_num);

                    return {
                        data: t.data.trace.act.data,
                        abi,
                        type: getActionAbiType(abi, t.data.trace.act.account, t.data.trace.act.name),
                    };
                } catch (error) {
                    if (this.failOnDeserializationError) {
                        throw new Error(
                            `Failed to get abi for ${t.data.trace.act.account} at #${block.this_block.block_num} ${error}`
                        );
                    }

                    return undefined;
                }
            })
        ).then((t) => this.deserializer.deserialize(t));

        if (this.failOnDeserializationError) {
            const failedIndices = deserializedTraces
                .map((row, i) => (!row.success ? i : -1))
                .filter((i) => i >= 0);

            if (failedIndices.length > 0 && this.abiProvider.getOlderAbis) {
                for (const idx of failedIndices) {
                    const tp = tracesToProcess[idx];
                    const olderAbis = await this.abiProvider.getOlderAbis(
                        tp.data.trace.act.account,
                        block.this_block.block_num,
                    );

                    for (const olderAbi of olderAbis) {
                        try {
                            const type = getActionAbiType(olderAbi, tp.data.trace.act.account, tp.data.trace.act.name);
                            const [result] = await this.deserializer.deserialize([
                                { data: tp.data.trace.act.data, abi: olderAbi, type },
                            ]);

                            if (result.success) {
                                deserializedTraces[idx] = result;
                                break;
                            }
                        } catch {
                            // try next older ABI
                        }
                    }
                }
            }

            const stillFailed = deserializedTraces
                .map((row, i) => (!row.success ? i : -1))
                .filter((i) => i >= 0);

            if (stillFailed.length > 0) {
                if (this.abiProvider.getOlderAbis) {
                    for (const idx of stillFailed) {
                        this.emit(
                            'warn',
                            `Skipping undeserializable trace (all ABI versions exhausted): ${JSON.stringify({
                                message: deserializedTraces[idx].message,
                                account: tracesToProcess[idx].data.trace.act.account,
                                name: tracesToProcess[idx].data.trace.act.name,
                                block_num: block.this_block.block_num,
                            })}`,
                        );
                    }
                } else {
                    throw new Error(
                        `Failed to deserialize traces. ${JSON.stringify({
                            message: deserializedTraces[stillFailed[0]].message,
                            account: tracesToProcess[stillFailed[0]].data.trace.act.account,
                            name: tracesToProcess[stillFailed[0]].data.trace.act.name,
                            data: tracesToProcess[stillFailed[0]].data.trace.act.data,
                        })}`
                    );
                }
            }
        }

        return tracesToProcess
            .map((tp, i) => {
                if (!deserializedTraces[i].success) return null;

                const txTrace = tp.data.tx.traces.find(
                    (trace) => trace.global_sequence === tp.data.trace.global_sequence,
                );

                if (txTrace) {
                    txTrace.act.data = deserializedTraces[i].data as any;
                }

                return {
                    data: {
                        trace: {
                            ...tp.data.trace,
                            act: {
                                ...tp.data.trace.act,
                                data: deserializedTraces[i].data,
                            },
                        },
                        block,
                        tx: tp.data.tx,
                    },
                    listeners: tp.listeners,
                };
            })
            .filter((entry) => entry !== null);
    }

    addDeltaListener(listener: IDeltaListener): () => void {
        this.deltaListeners.push(listener);

        return () => {
            const index = this.deltaListeners.indexOf(listener);

            if (index >= 0) {
                this.deltaListeners.splice(index, 1);
            }
        };
    }

    addTraceListener(listener: ITraceListener): () => void {
        this.traceListeners.push(listener);

        return () => {
            const index = this.traceListeners.indexOf(listener);

            if (index >= 0) {
                this.traceListeners.splice(index, 1);
            }
        };
    }

    addBlockListener(listener: IBlockListener): () => void {
        this.blockListeners.push(listener);

        return () => {
            const index = this.blockListeners.indexOf(listener);

            if (index >= 0) {
                this.blockListeners.splice(index, 1);
            }
        };
    }

    addPreBlockHook(listener: IBlockListener): () => void {
        this.preBlockHooks.push(listener);

        return () => {
            const index = this.preBlockHooks.indexOf(listener);

            if (index >= 0) {
                this.preBlockHooks.splice(index, 1);
            }
        };
    }

    addPostBlockHook(listener: IBlockListener): () => void {
        this.postBlockHooks.push(listener);

        return () => {
            const index = this.postBlockHooks.indexOf(listener);

            if (index >= 0) {
                this.postBlockHooks.splice(index, 1);
            }
        };
    }

    private async processABIUpdates({
        traces,
        block,
    }: {
        traces: IExtractedShipTrace<Uint8Array>[];
        block: ShipBlock;
    }): Promise<void> {
        const abiTraces = traces.filter((t) => t.trace.act.name === 'setabi' && t.trace.act.account === 'eosio');

        if (abiTraces.length === 0) return Promise.resolve();
        const abi = await this.abiProvider.getAbi('eosio', block.block_num);
        const type = getActionAbiType(abi, 'eosio', 'setabi');

        const deserializedAbiTraces = await this.deserializer.deserialize(
            abiTraces.map((t) => ({
                abi,
                type,
                data: t.trace.act.data,
            }))
        );

        const neededAbis = deserializedAbiTraces.filter(
            (deserializedTrace: { success: boolean; data: { account: string; abi: Uint8Array } }) => {
                if (!deserializedTrace.success) {
                    return false;
                }

                const isEOSAbi = deserializedTrace.data.account === 'eosio';
                const isRequiredInDeltas = this.deltaListeners.some(
                    (dl) => dl.contract === '*' || dl.contract === deserializedTrace.data.account
                );
                const isRequiredInTraces = this.traceListeners.some(
                    (tl) => tl.account === '*' || tl.account === deserializedTrace.data.account
                );

                return isEOSAbi || isRequiredInDeltas || isRequiredInTraces;
            }
        );

        await Promise.all(
            neededAbis.map(async (trace: { success: boolean; data: { account: string; abi: Uint8Array } }) => {
                try {
                    return this.abiProvider.setAbi(trace.data.account, block.block_num, deserializeAbi(trace.data.abi));
                } catch (e) {
                    // Never crash on a malformed ABI — chains regularly publish garbage ABIs
                    // that can't be deserialized. Log and skip; the account will use its previous ABI.
                    this.emit('warn', `Error deserializing ABI ${trace.data.account} at block ${block.block_num}`, e);
                }
            })
        );
    }
}
