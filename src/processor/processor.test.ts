import { ABI, Serializer } from '@wharfkit/antelope';
import { expect } from 'chai';
import * as sinon from 'sinon';

import { BlockProcessor } from './processor';
import type { IAbiProvider } from '../types/interfaces';
import type { IDeserializer, FullShipBlock, IExtractedShipDelta, IExtractedShipTrace } from '../types/ship';

// ABI that defines config table with FORMAT[] struct (the "new" ABI that fails)
const newConfigAbi = ABI.from({
    version: 'eosio::abi/1.1',
    structs: [
        { name: 'FORMAT', base: '', fields: [{ name: 'name', type: 'string' }, { name: 'type', type: 'string' }] },
        { name: 'config_s', base: '', fields: [{ name: 'collection_format', type: 'FORMAT[]' }] },
    ],
    tables: [{ name: 'config', type: 'config_s', index_type: 'i64', key_names: [], key_types: [] }],
    actions: [],
});

// ABI that defines config table with string[] (the "old" ABI that works)
const oldConfigAbi = ABI.from({
    version: 'eosio::abi/1.1',
    structs: [
        { name: 'config_s', base: '', fields: [{ name: 'collection_format', type: 'string[]' }] },
    ],
    tables: [{ name: 'config', type: 'config_s', index_type: 'i64', key_names: [], key_types: [] }],
    actions: [],
});

// ABI with a transfer action
const newTransferAbi = ABI.from({
    version: 'eosio::abi/1.1',
    structs: [
        { name: 'transfer_v2', base: '', fields: [{ name: 'from', type: 'name' }, { name: 'to', type: 'name' }, { name: 'extra', type: 'uint64' }] },
    ],
    tables: [],
    actions: [{ name: 'transfer', type: 'transfer_v2', ricardian_contract: '' }],
});

const oldTransferAbi = ABI.from({
    version: 'eosio::abi/1.1',
    structs: [
        { name: 'transfer', base: '', fields: [{ name: 'from', type: 'name' }, { name: 'to', type: 'name' }] },
    ],
    tables: [],
    actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }],
});

// Minimal eosio ABI with setabi action (needed for processABIUpdates)
const eosioAbi = ABI.from({
    version: 'eosio::abi/1.1',
    structs: [
        { name: 'setabi', base: '', fields: [{ name: 'account', type: 'name' }, { name: 'abi', type: 'bytes' }] },
    ],
    tables: [],
    actions: [{ name: 'setabi', type: 'setabi', ricardian_contract: '' }],
});

// A simple ABI serialized as bytes (for testing processABIUpdates -> deserializeAbi)
const simpleAbiDef = {
    version: 'eosio::abi/1.1',
    structs: [{ name: 'pair', base: '', fields: [{ name: 'id', type: 'uint64' }] }],
    tables: [{ name: 'pairs', type: 'pair', index_type: 'i64', key_names: [], key_types: [] }],
    actions: [],
};
const serializedSimpleAbi = Serializer.encode({ object: ABI.from(simpleAbiDef), type: ABI }).array;

// ABI that names both the config and the assets tables (the chain's current ABI in refresh tests)
const configAndAssetsAbi = ABI.from({
    version: 'eosio::abi/1.1',
    structs: [
        { name: 'config_s', base: '', fields: [{ name: 'collection_format', type: 'string[]' }] },
        { name: 'assets_s', base: '', fields: [{ name: 'asset_id', type: 'uint64' }] },
    ],
    tables: [
        { name: 'config', type: 'config_s', index_type: 'i64', key_names: [], key_types: [] },
        { name: 'assets', type: 'assets_s', index_type: 'i64', key_names: [], key_types: [] },
    ],
    actions: [],
});

// ABI that names both the transfer and the mint actions
const transferAndMintAbi = ABI.from({
    version: 'eosio::abi/1.1',
    structs: [
        { name: 'transfer', base: '', fields: [{ name: 'from', type: 'name' }, { name: 'to', type: 'name' }] },
        { name: 'mint', base: '', fields: [{ name: 'to', type: 'name' }] },
    ],
    tables: [],
    actions: [
        { name: 'transfer', type: 'transfer', ricardian_contract: '' },
        { name: 'mint', type: 'mint', ricardian_contract: '' },
    ],
});

// Succeeds only for items decoded with `abi`, so a test proves which ABI a retry used.
function decodesOnlyWith(abi: ABI): (callIndex: number, items: any[]) => any[] {
    return (_callIndex, items) =>
        items.map((item) =>
            item?.abi === abi
                ? { success: true, data: { deserialized: true } }
                : { success: false, data: null, message: 'Read past end of buffer' }
        );
}

function createMockAbiProvider(opts: {
    getOlderAbis?: boolean;
    refresh?: boolean;
    primaryAbi?: ABI;
    abiByContract?: Record<string, ABI>;
} = {}): IAbiProvider & { getOlderAbis?: sinon.SinonStub; refresh?: sinon.SinonStub; setAbi: sinon.SinonStub } {
    const abiByContract = opts.abiByContract;
    const defaultAbi = opts.primaryAbi ?? newConfigAbi;

    const provider: any = {
        init: sinon.stub().resolves(),
        getAbi: sinon.stub().callsFake(async (contract: string) => {
            if (abiByContract && abiByContract[contract]) {
                return abiByContract[contract];
            }
            return defaultAbi;
        }),
        setAbi: sinon.stub().resolves(),
    };
    if (opts.getOlderAbis) {
        provider.getOlderAbis = sinon.stub().resolves([]);
    }
    if (opts.refresh) {
        provider.refresh = sinon.stub().resolves(null);
    }
    return provider;
}

// Creates a deserializer that returns success for all items by default.
// Pass `failNonEmpty` to make the first N non-empty calls fail, then succeed.
// Pass `resultOverride` to provide custom per-call results.
function createMockDeserializer(opts: {
    failNonEmpty?: number;
    failMessage?: string;
    resultOverride?: (callIndex: number, items: any[]) => any[];
} = {}): IDeserializer {
    let nonEmptyCallCount = 0;
    const failCount = opts.failNonEmpty ?? 0;
    const failMsg = opts.failMessage ?? 'Read past end of buffer';

    return {
        waiting: 0,
        deserialize: sinon.stub().callsFake(async (items: any[]) => {
            if (items.length === 0) return [];
            nonEmptyCallCount++;
            if (opts.resultOverride) {
                return opts.resultOverride(nonEmptyCallCount, items);
            }
            if (nonEmptyCallCount <= failCount) {
                return items.map(() => ({ success: false, data: null, message: failMsg }));
            }
            return items.map(() => ({ success: true, data: { deserialized: true } }));
        }),
        terminate: sinon.stub().resolves(),
    };
}

function createBlock(blockNum: number): FullShipBlock {
    return {
        this_block: { block_num: blockNum, block_id: 'abc' },
        head: { block_num: blockNum, block_id: 'abc' },
        last_irreversible: { block_num: blockNum - 1, block_id: 'abc' },
        block_num: blockNum,
        block_id: 'abc',
    } as any;
}

function createDelta(code: string, table: string): IExtractedShipDelta<Uint8Array> {
    return {
        delta: {
            code,
            scope: code,
            table,
            primary_key: '1',
            payer: 'test',
            present: true,
            value: new Uint8Array([1, 2, 3]),
        },
    } as any;
}

function createTrace(account: string, name: string): IExtractedShipTrace<Uint8Array> {
    return {
        trace: {
            act: {
                account,
                name,
                authorization: [],
                data: new Uint8Array([4, 5, 6]),
            },
            global_sequence: '100',
        },
        tx: {
            id: 'tx1',
            traces: [
                {
                    global_sequence: '100',
                    act: { account, name, authorization: [], data: new Uint8Array([4, 5, 6]) },
                },
            ],
        },
    } as any;
}

function createSetAbiTrace(_account: string): IExtractedShipTrace<Uint8Array> {
    return {
        trace: {
            act: {
                account: 'eosio',
                name: 'setabi',
                authorization: [],
                data: new Uint8Array([7, 8, 9]),
            },
            global_sequence: '50',
        },
        tx: {
            id: 'tx_abi',
            traces: [
                {
                    global_sequence: '50',
                    act: { account: 'eosio', name: 'setabi', authorization: [], data: new Uint8Array([7, 8, 9]) },
                },
            ],
        },
    } as any;
}

describe('BlockProcessor ABI fallback', () => {
    describe('findAndDeserializeDeltas', () => {
        it('should fall back to older ABI when deserialization fails', async () => {
            const abiProvider = createMockAbiProvider({ getOlderAbis: true, primaryAbi: newConfigAbi });
            // First non-empty call fails (primary ABI), second succeeds (older ABI)
            const deserializer = createMockDeserializer({ failNonEmpty: 1 });

            (abiProvider.getOlderAbis as sinon.SinonStub).resolves([oldConfigAbi]);

            const processor = new BlockProcessor({
                deserializer,
                abiProvider,
                failOnDeserializationError: true,
                deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: sinon.stub() }],
            });

            const block = createBlock(8631733);
            const delta = createDelta('atomicassets', 'config');

            // Should not throw: the fallback should succeed
            await processor.processBlock({ block, traces: [], deltas: [delta] });

            expect((abiProvider.getOlderAbis as sinon.SinonStub).calledOnce).to.be.true;
            expect((abiProvider.getOlderAbis as sinon.SinonStub).firstCall.args).to.deep.equal(['atomicassets', 8631733]);
        });

        it('should warn and skip when no older ABI works for deltas (with getOlderAbis)', async () => {
            const abiProvider = createMockAbiProvider({ getOlderAbis: true, primaryAbi: newConfigAbi });
            // All calls fail
            const deserializer = createMockDeserializer({ failNonEmpty: 999 });

            (abiProvider.getOlderAbis as sinon.SinonStub).resolves([oldConfigAbi]);

            const listenerStub = sinon.stub();
            const processor = new BlockProcessor({
                deserializer,
                abiProvider,
                failOnDeserializationError: true,
                deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: listenerStub }],
            });

            const warnings: string[] = [];
            processor.on('warn', (msg: string) => warnings.push(msg));

            const block = createBlock(8631733);
            const delta = createDelta('atomicassets', 'config');

            // Should NOT throw: should warn and skip
            await processor.processBlock({ block, traces: [], deltas: [delta] });

            expect(warnings).to.have.length(1);
            expect(warnings[0]).to.include('Skipping undeserializable delta');
            expect(warnings[0]).to.include('atomicassets');
            // Listener should NOT be called for the skipped delta
            expect(listenerStub.called).to.be.false;
        });

        it('should not attempt fallback when getOlderAbis is not available', async () => {
            const abiProvider = createMockAbiProvider({ getOlderAbis: false, primaryAbi: newConfigAbi });
            const deserializer = createMockDeserializer({ failNonEmpty: 999 });

            const processor = new BlockProcessor({
                deserializer,
                abiProvider,
                failOnDeserializationError: true,
                deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: sinon.stub() }],
            });

            const block = createBlock(100);
            const delta = createDelta('atomicassets', 'config');

            try {
                await processor.processBlock({ block, traces: [], deltas: [delta] });
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).to.include('Failed to deserialize deltas');
            }
        });

        it('should not attempt fallback when failOnDeserializationError is false', async () => {
            const abiProvider = createMockAbiProvider({ getOlderAbis: true, primaryAbi: newConfigAbi });
            const deserializer = createMockDeserializer({ failNonEmpty: 999 });

            const processor = new BlockProcessor({
                deserializer,
                abiProvider,
                failOnDeserializationError: false,
                deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: sinon.stub() }],
            });

            const block = createBlock(100);
            const delta = createDelta('atomicassets', 'config');

            // Should not throw even though deserialization failed
            await processor.processBlock({ block, traces: [], deltas: [delta] });
            expect((abiProvider.getOlderAbis as sinon.SinonStub).called).to.be.false;
        });
    });

    describe('findAndDeserializeTraces', () => {
        it('should fall back to older ABI when trace deserialization fails', async () => {
            const abiProvider = createMockAbiProvider({ getOlderAbis: true, primaryAbi: newTransferAbi });
            // First non-empty call fails, second succeeds
            const deserializer = createMockDeserializer({ failNonEmpty: 1 });

            (abiProvider.getOlderAbis as sinon.SinonStub).resolves([oldTransferAbi]);

            const processor = new BlockProcessor({
                deserializer,
                abiProvider,
                failOnDeserializationError: true,
                traceListeners: [{ account: 'eosio.token', name: 'transfer', processor: sinon.stub() }],
            });

            const block = createBlock(8631733);
            const trace = createTrace('eosio.token', 'transfer');

            await processor.processBlock({ block, traces: [trace], deltas: [] });

            expect((abiProvider.getOlderAbis as sinon.SinonStub).calledOnce).to.be.true;
            expect((abiProvider.getOlderAbis as sinon.SinonStub).firstCall.args).to.deep.equal(['eosio.token', 8631733]);
        });

        it('should warn and skip when no older ABI works for traces (with getOlderAbis)', async () => {
            const abiProvider = createMockAbiProvider({ getOlderAbis: true, primaryAbi: newTransferAbi });
            const deserializer = createMockDeserializer({ failNonEmpty: 999, failMessage: 'Decoding error' });

            (abiProvider.getOlderAbis as sinon.SinonStub).resolves([oldTransferAbi]);

            const listenerStub = sinon.stub();
            const processor = new BlockProcessor({
                deserializer,
                abiProvider,
                failOnDeserializationError: true,
                traceListeners: [{ account: 'eosio.token', name: 'transfer', processor: listenerStub }],
            });

            const warnings: string[] = [];
            processor.on('warn', (msg: string) => warnings.push(msg));

            const block = createBlock(100);
            const trace = createTrace('eosio.token', 'transfer');

            // Should NOT throw: should warn and skip
            await processor.processBlock({ block, traces: [trace], deltas: [] });

            expect(warnings).to.have.length(1);
            expect(warnings[0]).to.include('Skipping undeserializable trace');
            expect(warnings[0]).to.include('eosio.token');
            // Listener should NOT be called for the skipped trace
            expect(listenerStub.called).to.be.false;
        });

        it('should still throw without getOlderAbis when trace deserialization fails', async () => {
            const abiProvider = createMockAbiProvider({ getOlderAbis: false, primaryAbi: newTransferAbi });
            const deserializer = createMockDeserializer({ failNonEmpty: 999, failMessage: 'Decoding error' });

            const processor = new BlockProcessor({
                deserializer,
                abiProvider,
                failOnDeserializationError: true,
                traceListeners: [{ account: 'eosio.token', name: 'transfer', processor: sinon.stub() }],
            });

            const block = createBlock(100);
            const trace = createTrace('eosio.token', 'transfer');

            try {
                await processor.processBlock({ block, traces: [trace], deltas: [] });
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.message).to.include('Failed to deserialize traces');
            }
        });
    });
});

async function expectRejection(promise: Promise<unknown>): Promise<Error> {
    return promise.then(
        () => expect.fail('Should have thrown'),
        (err: Error) => err
    );
}

describe('BlockProcessor ABI refresh', () => {
    describe('prewarm', () => {
        for (const failOnDeserializationError of [true, false]) {
            it(`prewarms only the accounts of deltas a listener takes (failOnDeserializationError ${failOnDeserializationError})`, async () => {
                const abiProvider = createMockAbiProvider({ primaryAbi: newConfigAbi });
                const processor = new BlockProcessor({
                    deserializer: createMockDeserializer(),
                    abiProvider,
                    failOnDeserializationError,
                    deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: sinon.stub() }],
                });

                await processor.processBlock({
                    block: createBlock(100),
                    traces: [],
                    deltas: [createDelta('atomicassets', 'config'), createDelta('unlistened', 'rows')],
                });

                const accounts = (abiProvider.getAbi as sinon.SinonStub).getCalls().map((call) => call.args[0]);
                expect(accounts).to.include('atomicassets');
                expect(accounts).to.not.include('unlistened');
            });
        }
    });

    describe('missing type on deltas', () => {
        it('refreshes once per account and retries the type lookup and decode with the returned ABI', async () => {
            const abiProvider = createMockAbiProvider({ refresh: true, primaryAbi: newConfigAbi });
            abiProvider.refresh!.resolves(configAndAssetsAbi);
            const deserializer = createMockDeserializer({ resultOverride: decodesOnlyWith(configAndAssetsAbi) });
            const listener = sinon.stub();

            const processor = new BlockProcessor({
                deserializer,
                abiProvider,
                failOnDeserializationError: true,
                deltaListeners: [{ contract: 'atomicassets', table: 'assets', processor: listener }],
            });

            await processor.processBlock({
                block: createBlock(100),
                traces: [],
                deltas: [createDelta('atomicassets', 'assets'), createDelta('atomicassets', 'assets')],
            });

            expect(abiProvider.refresh!.calledOnce).to.be.true;
            expect(abiProvider.refresh!.firstCall.args).to.deep.equal(['atomicassets', 100]);
            expect(listener.callCount).to.equal(2);
        });

        it('rethrows a getAbi rejection unchanged without a refresh', async () => {
            const abiProvider = createMockAbiProvider({ refresh: true });
            (abiProvider.getAbi as sinon.SinonStub).rejects(new Error('store down'));

            const processor = new BlockProcessor({
                deserializer: createMockDeserializer(),
                abiProvider,
                failOnDeserializationError: true,
                deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: sinon.stub() }],
            });

            const err = await expectRejection(
                processor.processBlock({ block: createBlock(100), traces: [], deltas: [createDelta('atomicassets', 'config')] })
            );

            expect(err.message).to.equal('Failed to get abi for atomicassets at #100 Error: store down');
            expect(abiProvider.refresh!.called).to.be.false;
        });

        // The last element is the error message of the refresh warning the ending emits, if any.
        const endings: Array<[string, (refresh: sinon.SinonStub) => void, string | null]> = [
            ['refresh returns null', (refresh) => refresh.resolves(null), null],
            ['refresh rejects', (refresh) => refresh.rejects(new Error('rpc down')), 'rpc down'],
            ['the refreshed ABI still lacks the table', (refresh) => refresh.resolves(oldConfigAbi), null],
        ];

        for (const [name, arrange, refreshError] of endings) {
            it(`ends in the unchanged throw when ${name}`, async () => {
                const abiProvider = createMockAbiProvider({ refresh: true, primaryAbi: newConfigAbi });
                arrange(abiProvider.refresh!);

                const processor = new BlockProcessor({
                    deserializer: createMockDeserializer(),
                    abiProvider,
                    failOnDeserializationError: true,
                    deltaListeners: [{ contract: 'atomicassets', table: 'assets', processor: sinon.stub() }],
                });

                const warnings: Array<{ message: string; error?: Error }> = [];
                processor.on('warn', (message: string, error?: Error) => warnings.push({ message, error }));

                const err = await expectRejection(
                    processor.processBlock({ block: createBlock(100), traces: [], deltas: [createDelta('atomicassets', 'assets')] })
                );

                expect(err.message).to.equal(
                    'Failed to get abi for atomicassets at #100 Error: Type for table not found atomicassets:assets'
                );
                expect(abiProvider.refresh!.calledOnce).to.be.true;

                if (refreshError) {
                    expect(warnings).to.have.length(1);
                    expect(warnings[0]!.message).to.equal('Refresh of ABI atomicassets at block 100 failed');
                    expect(warnings[0]!.error?.message).to.equal(refreshError);
                } else {
                    expect(warnings).to.have.length(0);
                }
            });
        }

        it('throws on a missing table for a provider without refresh', async () => {
            const abiProvider = createMockAbiProvider({ getOlderAbis: true, primaryAbi: newConfigAbi });

            const processor = new BlockProcessor({
                deserializer: createMockDeserializer(),
                abiProvider,
                failOnDeserializationError: true,
                deltaListeners: [{ contract: 'atomicassets', table: 'assets', processor: sinon.stub() }],
            });

            const err = await expectRejection(
                processor.processBlock({ block: createBlock(100), traces: [], deltas: [createDelta('atomicassets', 'assets')] })
            );

            expect(err.message).to.include('Failed to get abi for atomicassets');
        });

        it('does not refresh when failOnDeserializationError is false', async () => {
            const abiProvider = createMockAbiProvider({ refresh: true, getOlderAbis: true, primaryAbi: newConfigAbi });
            abiProvider.refresh!.resolves(configAndAssetsAbi);
            const listener = sinon.stub();

            const processor = new BlockProcessor({
                deserializer: createMockDeserializer({ failNonEmpty: 999 }),
                abiProvider,
                failOnDeserializationError: false,
                deltaListeners: [{ contract: 'atomicassets', table: '*', processor: listener }],
            });

            await processor.processBlock({
                block: createBlock(100),
                traces: [],
                deltas: [createDelta('atomicassets', 'assets'), createDelta('atomicassets', 'config')],
            });

            expect(abiProvider.refresh!.called).to.be.false;
            expect(listener.called).to.be.false;
        });
    });

    describe('undecodable deltas', () => {
        it('refreshes once per account after the older ABIs are exhausted and retries each row once', async () => {
            const refreshedAbi = ABI.from(oldConfigAbi.toJSON());
            const abiProvider = createMockAbiProvider({ refresh: true, getOlderAbis: true, primaryAbi: newConfigAbi });
            abiProvider.getOlderAbis!.resolves([oldConfigAbi]);
            abiProvider.refresh!.resolves(refreshedAbi);
            const listener = sinon.stub();

            const processor = new BlockProcessor({
                deserializer: createMockDeserializer({ resultOverride: decodesOnlyWith(refreshedAbi) }),
                abiProvider,
                failOnDeserializationError: true,
                deltaListeners: [{ contract: '*', table: 'config', processor: listener }],
            });

            const warnings: string[] = [];
            processor.on('warn', (msg: string) => warnings.push(msg));

            await processor.processBlock({
                block: createBlock(100),
                traces: [],
                deltas: [
                    createDelta('atomicassets', 'config'),
                    createDelta('atomicassets', 'config'),
                    createDelta('pink.gg', 'config'),
                ],
            });

            expect(abiProvider.getOlderAbis!.callCount).to.equal(3);
            expect(abiProvider.refresh!.callCount).to.equal(2);
            expect(abiProvider.refresh!.getCalls().map((call) => call.args)).to.have.deep.members([
                ['atomicassets', 100],
                ['pink.gg', 100],
            ]);
            expect(listener.callCount).to.equal(3);
            expect(warnings).to.have.length(0);
        });

        it('runs the refresh step directly for a provider with refresh but no getOlderAbis', async () => {
            const refreshedAbi = ABI.from(oldConfigAbi.toJSON());
            const abiProvider = createMockAbiProvider({ refresh: true, primaryAbi: newConfigAbi });
            abiProvider.refresh!.resolves(refreshedAbi);
            const listener = sinon.stub();

            const processor = new BlockProcessor({
                deserializer: createMockDeserializer({ resultOverride: decodesOnlyWith(refreshedAbi) }),
                abiProvider,
                failOnDeserializationError: true,
                deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: listener }],
            });

            await processor.processBlock({ block: createBlock(100), traces: [], deltas: [createDelta('atomicassets', 'config')] });

            expect(abiProvider.refresh!.calledOnce).to.be.true;
            expect(listener.calledOnce).to.be.true;
        });

        it('warns and drops the row when refresh returns null (with getOlderAbis)', async () => {
            const abiProvider = createMockAbiProvider({ refresh: true, getOlderAbis: true, primaryAbi: newConfigAbi });
            abiProvider.getOlderAbis!.resolves([oldConfigAbi]);
            const listener = sinon.stub();

            const processor = new BlockProcessor({
                deserializer: createMockDeserializer({ failNonEmpty: 999 }),
                abiProvider,
                failOnDeserializationError: true,
                deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: listener }],
            });

            const warnings: string[] = [];
            processor.on('warn', (msg: string) => warnings.push(msg));

            await processor.processBlock({ block: createBlock(100), traces: [], deltas: [createDelta('atomicassets', 'config')] });

            expect(abiProvider.refresh!.calledOnce).to.be.true;
            expect(warnings).to.have.length(1);
            expect(warnings[0]).to.include('Skipping undeserializable delta');
            expect(warnings[0]).to.include('"code":"atomicassets"');
            expect(warnings[0]).to.include('"delta":"config"');
            expect(warnings[0]).to.include('"block_num":100');
            expect(listener.called).to.be.false;
        });

        it('throws when the refreshed ABI does not decode either (without getOlderAbis)', async () => {
            const abiProvider = createMockAbiProvider({ refresh: true, primaryAbi: newConfigAbi });
            abiProvider.refresh!.resolves(ABI.from(oldConfigAbi.toJSON()));

            const processor = new BlockProcessor({
                deserializer: createMockDeserializer({ failNonEmpty: 999 }),
                abiProvider,
                failOnDeserializationError: true,
                deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: sinon.stub() }],
            });

            const err = await expectRejection(
                processor.processBlock({ block: createBlock(100), traces: [], deltas: [createDelta('atomicassets', 'config')] })
            );

            expect(err.message).to.include('Failed to deserialize deltas');
            expect(abiProvider.refresh!.calledOnce).to.be.true;
        });
    });

    describe('traces', () => {
        it('refreshes and retries when the cached ABI lacks the action', async () => {
            const abiProvider = createMockAbiProvider({ refresh: true, primaryAbi: newTransferAbi });
            abiProvider.refresh!.resolves(transferAndMintAbi);
            const listener = sinon.stub();

            const processor = new BlockProcessor({
                deserializer: createMockDeserializer({ resultOverride: decodesOnlyWith(transferAndMintAbi) }),
                abiProvider,
                failOnDeserializationError: true,
                traceListeners: [{ account: 'eosio.token', name: 'mint', processor: listener }],
            });

            await processor.processBlock({ block: createBlock(100), traces: [createTrace('eosio.token', 'mint')], deltas: [] });

            expect(abiProvider.refresh!.calledOnce).to.be.true;
            expect(listener.calledOnce).to.be.true;
        });

        it('ends in the unchanged throw when refresh returns null for a missing action', async () => {
            const abiProvider = createMockAbiProvider({ refresh: true, primaryAbi: newTransferAbi });

            const processor = new BlockProcessor({
                deserializer: createMockDeserializer(),
                abiProvider,
                failOnDeserializationError: true,
                traceListeners: [{ account: 'eosio.token', name: 'mint', processor: sinon.stub() }],
            });

            const err = await expectRejection(
                processor.processBlock({ block: createBlock(100), traces: [createTrace('eosio.token', 'mint')], deltas: [] })
            );

            expect(err.message).to.equal(
                'Failed to get abi for eosio.token at #100 Error: Type for action not found eosio.token:mint'
            );
        });

        it('refreshes once per account after the older ABIs are exhausted and retries each trace once', async () => {
            const refreshedAbi = ABI.from(oldTransferAbi.toJSON());
            const abiProvider = createMockAbiProvider({ refresh: true, getOlderAbis: true, primaryAbi: newTransferAbi });
            abiProvider.getOlderAbis!.resolves([oldTransferAbi]);
            abiProvider.refresh!.resolves(refreshedAbi);
            const listener = sinon.stub();

            const processor = new BlockProcessor({
                deserializer: createMockDeserializer({ resultOverride: decodesOnlyWith(refreshedAbi) }),
                abiProvider,
                failOnDeserializationError: true,
                traceListeners: [{ account: '*', name: 'transfer', processor: listener }],
            });

            await processor.processBlock({
                block: createBlock(100),
                traces: [
                    createTrace('eosio.token', 'transfer'),
                    createTrace('eosio.token', 'transfer'),
                    createTrace('wax.token', 'transfer'),
                ],
                deltas: [],
            });

            expect(abiProvider.refresh!.callCount).to.equal(2);
            expect(listener.callCount).to.equal(3);
        });

        it('warns and drops the trace when refresh returns null (with getOlderAbis)', async () => {
            const abiProvider = createMockAbiProvider({ refresh: true, getOlderAbis: true, primaryAbi: newTransferAbi });
            const listener = sinon.stub();

            const processor = new BlockProcessor({
                deserializer: createMockDeserializer({ failNonEmpty: 999 }),
                abiProvider,
                failOnDeserializationError: true,
                traceListeners: [{ account: 'eosio.token', name: 'transfer', processor: listener }],
            });

            const warnings: string[] = [];
            processor.on('warn', (msg: string) => warnings.push(msg));

            await processor.processBlock({ block: createBlock(100), traces: [createTrace('eosio.token', 'transfer')], deltas: [] });

            expect(abiProvider.refresh!.calledOnce).to.be.true;
            expect(warnings).to.have.length(1);
            expect(warnings[0]).to.include('"account":"eosio.token"');
            expect(warnings[0]).to.include('"name":"transfer"');
            expect(warnings[0]).to.include('"block_num":100');
            expect(listener.called).to.be.false;
        });
    });

    it('shares one refresh per account between the trace and delta paths of a block', async () => {
        const abiProvider = createMockAbiProvider({
            refresh: true,
            abiByContract: { atomicassets: newTransferAbi },
        });
        const combinedAbi = ABI.from({
            version: 'eosio::abi/1.1',
            structs: [
                { name: 'assets_s', base: '', fields: [{ name: 'asset_id', type: 'uint64' }] },
                { name: 'mint', base: '', fields: [{ name: 'to', type: 'name' }] },
            ],
            tables: [{ name: 'assets', type: 'assets_s', index_type: 'i64', key_names: [], key_types: [] }],
            actions: [{ name: 'mint', type: 'mint', ricardian_contract: '' }],
        });
        abiProvider.refresh!.callsFake(async () => {
            await new Promise((resolve) => setImmediate(resolve));
            return combinedAbi;
        });
        const traceListener = sinon.stub();
        const deltaListener = sinon.stub();

        const processor = new BlockProcessor({
            deserializer: createMockDeserializer({ resultOverride: decodesOnlyWith(combinedAbi) }),
            abiProvider,
            failOnDeserializationError: true,
            traceListeners: [{ account: 'atomicassets', name: 'mint', processor: traceListener }],
            deltaListeners: [{ contract: 'atomicassets', table: 'assets', processor: deltaListener }],
        });

        await processor.processBlock({
            block: createBlock(100),
            traces: [createTrace('atomicassets', 'mint')],
            deltas: [createDelta('atomicassets', 'assets')],
        });

        expect(abiProvider.refresh!.calledOnce).to.be.true;
        expect(traceListener.calledOnce).to.be.true;
        expect(deltaListener.calledOnce).to.be.true;
    });
});

describe('BlockProcessor processABIUpdates', () => {
    it('should call setAbi when a setabi trace matches a delta listener', async () => {
        const abiProvider = createMockAbiProvider({ abiByContract: { eosio: eosioAbi } });
        const deserializer = createMockDeserializer({
            resultOverride: (_callIndex, items) =>
                items.map(() => ({
                    success: true,
                    data: { account: 'atomicassets', abi: serializedSimpleAbi },
                })),
        });

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: sinon.stub() }],
        });

        const block = createBlock(500);
        const setAbiTrace = createSetAbiTrace('atomicassets');

        await processor.processBlock({ block, traces: [setAbiTrace], deltas: [] });

        expect(abiProvider.setAbi.calledOnce).to.be.true;
        const [account, blockNum, abi] = abiProvider.setAbi.firstCall.args;
        expect(account).to.equal('atomicassets');
        expect(blockNum).to.equal(500);
        expect(abi).to.be.instanceOf(ABI);
    });

    it('should call setAbi when the decoded abi field is a hex string', async () => {
        // deserializeEosioType renders a `bytes` field as a hex string, so this is the shape
        // the real deserializers hand to processABIUpdates.
        const abiProvider = createMockAbiProvider({ abiByContract: { eosio: eosioAbi } });
        const deserializer = createMockDeserializer({
            resultOverride: (_callIndex, items) =>
                items.map(() => ({
                    success: true,
                    data: { account: 'atomicassets', abi: Buffer.from(serializedSimpleAbi).toString('hex') },
                })),
        });

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: sinon.stub() }],
        });

        await processor.processBlock({ block: createBlock(501), traces: [createSetAbiTrace('atomicassets')], deltas: [] });

        expect(abiProvider.setAbi.calledOnce).to.be.true;
        const [account, blockNum, abi] = abiProvider.setAbi.firstCall.args;
        expect(account).to.equal('atomicassets');
        expect(blockNum).to.equal(501);
        expect(abi).to.be.instanceOf(ABI);
        expect(String(abi.tables[0].name)).to.equal('pairs');
    });

    it('should call setAbi for eosio account ABI even without matching listeners', async () => {
        const abiProvider = createMockAbiProvider({ abiByContract: { eosio: eosioAbi } });
        const deserializer = createMockDeserializer({
            resultOverride: (_callIndex, items) =>
                items.map(() => ({
                    success: true,
                    data: { account: 'eosio', abi: serializedSimpleAbi },
                })),
        });

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            // No listeners for 'eosio', but eosio ABIs should always be stored
        });

        const block = createBlock(100);

        await processor.processBlock({ block, traces: [createSetAbiTrace('eosio')], deltas: [] });

        expect(abiProvider.setAbi.calledOnce).to.be.true;
        expect(abiProvider.setAbi.firstCall.args[0]).to.equal('eosio');
    });

    it('should skip setabi when contract is not needed by any listener', async () => {
        const abiProvider = createMockAbiProvider({ abiByContract: { eosio: eosioAbi } });
        const deserializer = createMockDeserializer({
            resultOverride: (_callIndex, items) =>
                items.map(() => ({
                    success: true,
                    data: { account: 'unrelated.contract', abi: serializedSimpleAbi },
                })),
        });

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: sinon.stub() }],
        });

        const block = createBlock(100);

        await processor.processBlock({ block, traces: [createSetAbiTrace('unrelated.contract')], deltas: [] });

        expect(abiProvider.setAbi.called).to.be.false;
    });

    it('should skip setabi traces that fail deserialization', async () => {
        const abiProvider = createMockAbiProvider({ abiByContract: { eosio: eosioAbi } });
        const deserializer = createMockDeserializer({
            resultOverride: (_callIndex, items) =>
                items.map(() => ({ success: false, data: null, message: 'bad data' })),
        });

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: sinon.stub() }],
        });

        const block = createBlock(100);

        await processor.processBlock({ block, traces: [createSetAbiTrace('atomicassets')], deltas: [] });

        expect(abiProvider.setAbi.called).to.be.false;
    });

    it('should not crash when deserializeAbi fails on malformed ABI', async () => {
        const abiProvider = createMockAbiProvider({ abiByContract: { eosio: eosioAbi } });
        const deserializer = createMockDeserializer({
            resultOverride: (_callIndex, items) =>
                items.map(() => ({
                    success: true,
                    // Garbage bytes that will fail deserializeAbi
                    data: { account: 'atomicassets', abi: new Uint8Array([0xff, 0xfe]) },
                })),
        });

        const warnSpy = sinon.stub();
        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: sinon.stub() }],
        });
        processor.on('warn', warnSpy);

        const block = createBlock(100);

        // Should not throw: malformed ABIs are caught and emitted as warnings
        await processor.processBlock({ block, traces: [createSetAbiTrace('atomicassets')], deltas: [] });

        expect(abiProvider.setAbi.called).to.be.false;
        expect(warnSpy.calledOnce).to.be.true;
        expect(warnSpy.firstCall.args[0]).to.include('Error deserializing ABI atomicassets');
    });

    it('should not process non-setabi traces', async () => {
        const abiProvider = createMockAbiProvider({ abiByContract: { eosio: eosioAbi } });
        const deserializer = createMockDeserializer();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
        });

        const block = createBlock(100);
        const regularTrace = createTrace('eosio.token', 'transfer');

        await processor.processBlock({ block, traces: [regularTrace], deltas: [] });

        // getAbi should not be called for 'eosio' because there are no setabi traces
        // (it would be called during trace deserialization, but no trace listeners match)
        expect(abiProvider.setAbi.called).to.be.false;
    });

    it('should call setAbi for wildcard delta listener', async () => {
        const abiProvider = createMockAbiProvider({ abiByContract: { eosio: eosioAbi } });
        const deserializer = createMockDeserializer({
            resultOverride: (_callIndex, items) =>
                items.map(() => ({
                    success: true,
                    data: { account: 'anycontract', abi: serializedSimpleAbi },
                })),
        });

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            deltaListeners: [{ contract: '*', table: '*', processor: sinon.stub() }],
        });

        const block = createBlock(100);

        await processor.processBlock({ block, traces: [createSetAbiTrace('anycontract')], deltas: [] });

        expect(abiProvider.setAbi.calledOnce).to.be.true;
        expect(abiProvider.setAbi.firstCall.args[0]).to.equal('anycontract');
    });
});

describe('BlockProcessor listener dispatch', () => {
    it('should call delta listener processor with deserialized data', async () => {
        const abiProvider = createMockAbiProvider({ primaryAbi: newConfigAbi });
        const deserializer = createMockDeserializer();
        const listenerProcessor = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: listenerProcessor }],
        });

        const block = createBlock(100);
        const delta = createDelta('atomicassets', 'config');

        await processor.processBlock({ block, traces: [], deltas: [delta] });

        expect(listenerProcessor.calledOnce).to.be.true;
        const payload = listenerProcessor.firstCall.args[0];
        expect(payload.delta.code).to.equal('atomicassets');
        expect(payload.delta.table).to.equal('config');
        expect(payload.block).to.equal(block);
    });

    it('should call trace listener processor with deserialized data', async () => {
        const abiProvider = createMockAbiProvider({ primaryAbi: newTransferAbi });
        const deserializer = createMockDeserializer();
        const listenerProcessor = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            traceListeners: [{ account: 'eosio.token', name: 'transfer', processor: listenerProcessor }],
        });

        const block = createBlock(100);
        const trace = createTrace('eosio.token', 'transfer');

        await processor.processBlock({ block, traces: [trace], deltas: [] });

        expect(listenerProcessor.calledOnce).to.be.true;
        const payload = listenerProcessor.firstCall.args[0];
        expect(payload.trace.act.account).to.equal('eosio.token');
        expect(payload.trace.act.name).to.equal('transfer');
        expect(payload.block).to.equal(block);
    });

    it('should call block listeners with the block', async () => {
        const abiProvider = createMockAbiProvider();
        const deserializer = createMockDeserializer();
        const blockListener = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            blockListeners: [blockListener],
        });

        const block = createBlock(100);

        await processor.processBlock({ block, traces: [], deltas: [] });

        expect(blockListener.calledOnce).to.be.true;
        expect(blockListener.firstCall.args[0]).to.equal(block);
    });

    it('should skip deltas with no matching listeners', async () => {
        const abiProvider = createMockAbiProvider({ primaryAbi: newConfigAbi });
        const deserializer = createMockDeserializer();
        const listenerProcessor = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            deltaListeners: [{ contract: 'atomicassets', table: 'config', processor: listenerProcessor }],
        });

        const block = createBlock(100);
        // Delta for a different table: no listener matches
        const delta = createDelta('atomicassets', 'assets');

        await processor.processBlock({ block, traces: [], deltas: [delta] });

        expect(listenerProcessor.called).to.be.false;
    });

    it('should match wildcard contract and table in delta listeners', async () => {
        const abiProvider = createMockAbiProvider({ primaryAbi: newConfigAbi });
        const deserializer = createMockDeserializer();
        const listenerProcessor = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            deltaListeners: [{ contract: '*', table: '*', processor: listenerProcessor }],
        });

        const block = createBlock(100);
        // Use a table that exists in newConfigAbi so getTableAbiType succeeds
        const delta = createDelta('somecontract', 'config');

        await processor.processBlock({ block, traces: [], deltas: [delta] });

        expect(listenerProcessor.calledOnce).to.be.true;
    });
});

describe('BlockProcessor trace filtering', () => {
    it('should exclude eosio:onblock traces', async () => {
        const abiProvider = createMockAbiProvider({ primaryAbi: eosioAbi });
        const deserializer = createMockDeserializer();
        const listenerProcessor = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            traceListeners: [{ account: '*', name: '*', processor: listenerProcessor }],
        });

        const block = createBlock(100);
        const onblockTrace = createTrace('eosio', 'onblock');

        await processor.processBlock({ block, traces: [onblockTrace], deltas: [] });

        expect(listenerProcessor.called).to.be.false;
    });

    it('should exclude eosio.null traces', async () => {
        const abiProvider = createMockAbiProvider({ primaryAbi: eosioAbi });
        const deserializer = createMockDeserializer();
        const listenerProcessor = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            traceListeners: [{ account: '*', name: '*', processor: listenerProcessor }],
        });

        const block = createBlock(100);
        const nullTrace = createTrace('eosio.null', 'nonce');

        await processor.processBlock({ block, traces: [nullTrace], deltas: [] });

        expect(listenerProcessor.called).to.be.false;
    });

    it('should match wildcard account and name in trace listeners', async () => {
        const abiProvider = createMockAbiProvider({ primaryAbi: newTransferAbi });
        const deserializer = createMockDeserializer();
        const listenerProcessor = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            traceListeners: [{ account: '*', name: '*', processor: listenerProcessor }],
        });

        const block = createBlock(100);
        const trace = createTrace('eosio.token', 'transfer');

        await processor.processBlock({ block, traces: [trace], deltas: [] });

        expect(listenerProcessor.calledOnce).to.be.true;
    });

    it('should not match trace when account does not match listener', async () => {
        const abiProvider = createMockAbiProvider({ primaryAbi: newTransferAbi });
        const deserializer = createMockDeserializer();
        const listenerProcessor = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            traceListeners: [{ account: 'atomicassets', name: 'transfer', processor: listenerProcessor }],
        });

        const block = createBlock(100);
        const trace = createTrace('eosio.token', 'transfer');

        await processor.processBlock({ block, traces: [trace], deltas: [] });

        expect(listenerProcessor.called).to.be.false;
    });
});

describe('BlockProcessor hooks and dynamic listeners', () => {
    it('should call pre-block hooks on onBlockStart', async () => {
        const abiProvider = createMockAbiProvider();
        const deserializer = createMockDeserializer();
        const hook = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            preBlockHook: [hook],
        });

        const block = createBlock(100);
        await processor.onBlockStart({ block });

        expect(hook.calledOnce).to.be.true;
        expect(hook.firstCall.args[0]).to.equal(block);
    });

    it('should call post-block hooks on onBlockFinished', async () => {
        const abiProvider = createMockAbiProvider();
        const deserializer = createMockDeserializer();
        const hook = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
            postBlockHook: [hook],
        });

        const block = createBlock(100);
        await processor.onBlockFinished({ block });

        expect(hook.calledOnce).to.be.true;
        expect(hook.firstCall.args[0]).to.equal(block);
    });

    it('should add and remove delta listeners dynamically', async () => {
        const abiProvider = createMockAbiProvider({ primaryAbi: newConfigAbi });
        const deserializer = createMockDeserializer();
        const listenerProcessor = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
        });

        const remove = processor.addDeltaListener({ contract: 'atomicassets', table: 'config', processor: listenerProcessor });

        const block = createBlock(100);
        const delta = createDelta('atomicassets', 'config');

        await processor.processBlock({ block, traces: [], deltas: [delta] });
        expect(listenerProcessor.calledOnce).to.be.true;

        // Remove listener and process again
        remove();
        listenerProcessor.reset();

        await processor.processBlock({ block, traces: [], deltas: [delta] });
        expect(listenerProcessor.called).to.be.false;
    });

    it('should add and remove trace listeners dynamically', async () => {
        const abiProvider = createMockAbiProvider({ primaryAbi: newTransferAbi });
        const deserializer = createMockDeserializer();
        const listenerProcessor = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
        });

        const remove = processor.addTraceListener({ account: 'eosio.token', name: 'transfer', processor: listenerProcessor });

        const block = createBlock(100);
        const trace = createTrace('eosio.token', 'transfer');

        await processor.processBlock({ block, traces: [trace], deltas: [] });
        expect(listenerProcessor.calledOnce).to.be.true;

        remove();
        listenerProcessor.reset();

        await processor.processBlock({ block, traces: [trace], deltas: [] });
        expect(listenerProcessor.called).to.be.false;
    });

    it('should add and remove block listeners dynamically', async () => {
        const abiProvider = createMockAbiProvider();
        const deserializer = createMockDeserializer();
        const blockListener = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
        });

        const remove = processor.addBlockListener(blockListener);

        const block = createBlock(100);
        await processor.processBlock({ block, traces: [], deltas: [] });
        expect(blockListener.calledOnce).to.be.true;

        remove();
        blockListener.reset();

        await processor.processBlock({ block, traces: [], deltas: [] });
        expect(blockListener.called).to.be.false;
    });

    it('should add and remove pre-block hooks dynamically', async () => {
        const abiProvider = createMockAbiProvider();
        const deserializer = createMockDeserializer();
        const hook = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
        });

        const remove = processor.addPreBlockHook(hook);

        const block = createBlock(100);
        await processor.onBlockStart({ block });
        expect(hook.calledOnce).to.be.true;

        remove();
        hook.reset();

        await processor.onBlockStart({ block });
        expect(hook.called).to.be.false;
    });

    it('should add and remove post-block hooks dynamically', async () => {
        const abiProvider = createMockAbiProvider();
        const deserializer = createMockDeserializer();
        const hook = sinon.stub();

        const processor = new BlockProcessor({
            deserializer,
            abiProvider,
            failOnDeserializationError: true,
        });

        const remove = processor.addPostBlockHook(hook);

        const block = createBlock(100);
        await processor.onBlockFinished({ block });
        expect(hook.calledOnce).to.be.true;

        remove();
        hook.reset();

        await processor.onBlockFinished({ block });
        expect(hook.called).to.be.false;
    });
});
