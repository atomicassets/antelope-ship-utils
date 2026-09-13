import { ABI } from '@wharfkit/antelope';
import { expect } from 'chai';
import * as sinon from 'sinon';

import { StoredAbiProvider } from '../index';
import type { IAbiStore, IAbiStoreRow } from '../index';

function tableAbi(table: string): ABI {
    return ABI.from({
        version: 'eosio::abi/1.1',
        structs: [{ name: `${table}_s`, base: '', fields: [{ name: 'id', type: 'uint64' }] }],
        tables: [{ name: table, type: `${table}_s`, index_type: 'i64', key_names: [], key_types: [] }],
        actions: [],
    });
}

const abiA = tableAbi('alpha');
const abiB = tableAbi('bravo');
const abiC = tableAbi('charlie');

type FakeStore = IAbiStore & {
    rows: IAbiStoreRow[];
    loadLatestPerAccount: sinon.SinonStub;
    findAtOrBefore: sinon.SinonStub;
    findOlder: sinon.SinonStub;
    save: sinon.SinonStub;
};

// An array-backed store with the IAbiStore semantics: newest first, strictly below for findOlder.
function createStore(sandbox: sinon.SinonSandbox, initial: IAbiStoreRow[] = []): FakeStore {
    const rows = [...initial];
    const newestFirst = (account: string): IAbiStoreRow[] =>
        rows.filter((row) => row.account === account).sort((a, b) => b.block_num - a.block_num);

    return {
        rows,
        loadLatestPerAccount: sandbox
            .stub()
            .callsFake(async (accounts: string[]) =>
                accounts.map((account) => newestFirst(account)[0]).filter((row) => row !== undefined)
            ),
        findAtOrBefore: sandbox
            .stub()
            .callsFake(
                async (account: string, blockNum: number) =>
                    newestFirst(account).find((row) => row.block_num <= blockNum) ?? null
            ),
        findOlder: sandbox
            .stub()
            .callsFake(async (account: string, below: number, limit: number) =>
                newestFirst(account)
                    .filter((row) => row.block_num < below)
                    .slice(0, limit)
            ),
        save: sandbox.stub().callsFake(async (row: IAbiStoreRow) => {
            rows.push(row);
        }),
    };
}

// A fetch that answers get_abi with whatever ABI `chain.abi` holds at call time.
function createChain(sandbox: sinon.SinonSandbox, abi: ABI): { chain: { abi: ABI }; fetchApi: sinon.SinonStub } {
    const chain = { abi };
    const fetchApi = sandbox
        .stub()
        .callsFake(
            async () => new Response(JSON.stringify({ account_name: 'atomicassets', abi: chain.abi }), { status: 200 })
        );

    return { chain, fetchApi };
}

function createProvider(
    store: IAbiStore,
    fetchApi: sinon.SinonStub,
    accounts = ['atomicassets'],
    refreshIntervalBlocks?: number
): StoredAbiProvider {
    return new StoredAbiProvider({
        store,
        accounts,
        rpcEndpoint: 'http://chain.test',
        fetchApi: fetchApi as unknown as typeof globalThis.fetch,
        refreshIntervalBlocks,
    });
}

function row(block_num: number, abi: ABI, account = 'atomicassets'): IAbiStoreRow {
    return { account, block_num, abi };
}

function collectWarnings(provider: StoredAbiProvider): Array<{ message: string; error?: Error }> {
    const warnings: Array<{ message: string; error?: Error }> = [];
    provider.on('warn', (message: string, error?: Error) => warnings.push({ message, error }));

    return warnings;
}

describe('StoredAbiProvider', () => {
    const sandbox = sinon.createSandbox();

    afterEach(() => sandbox.restore());

    describe('getAbi', () => {
        it('answers from the cached row loaded at init without a store query', async () => {
            const store = createStore(sandbox, [row(700, abiA), row(1000, abiB)]);
            const { fetchApi } = createChain(sandbox, abiC);
            const provider = createProvider(store, fetchApi);

            await provider.init();

            expect(store.loadLatestPerAccount.firstCall.args).to.deep.equal([['atomicassets']]);
            expect(await provider.getAbi('atomicassets', 1500)).to.equal(abiB);
            expect(store.findAtOrBefore.called).to.equal(false);
            expect(fetchApi.called).to.equal(false);
        });

        it('caches a store hit under the block that published it, not the block that asked', async () => {
            const store = createStore(sandbox, [row(600, abiA), row(700, abiB), row(1000, abiC)]);
            const { fetchApi } = createChain(sandbox, abiC);
            const provider = createProvider(store, fetchApi);

            await provider.init();

            expect(await provider.getAbi('atomicassets', 900)).to.equal(abiB);
            expect(store.findAtOrBefore.callCount).to.equal(1);

            // Cached under 700, so 800 is a cache hit; a row cached under 900 would miss here.
            expect(await provider.getAbi('atomicassets', 800)).to.equal(abiB);
            expect(store.findAtOrBefore.callCount).to.equal(1);

            expect(await provider.getAbi('atomicassets', 650)).to.equal(abiA);
            expect(store.findAtOrBefore.callCount).to.equal(2);
        });

        it('keeps at most eight published rows per account and reads the dropped history from the store', async () => {
            const store = createStore(sandbox);
            const { fetchApi } = createChain(sandbox, abiC);
            const provider = createProvider(store, fetchApi);
            const abis = Array.from({ length: 10 }, (_, i) => tableAbi(`table${i + 1}`));

            await provider.init();

            for (const [i, abi] of abis.entries()) {
                await provider.setAbi('atomicassets', (i + 1) * 100, abi);
            }

            // Rows 300 to 1000 stay cached; ascending blocks keep every answer in memory.
            expect(await provider.getAbi('atomicassets', 350)).to.equal(abis[2]);
            expect(await provider.getAbi('atomicassets', 1000)).to.equal(abis[9]);
            expect(store.findAtOrBefore.called).to.equal(false);

            // Row 200 dropped from memory, so the store serves it.
            expect(await provider.getAbi('atomicassets', 250)).to.equal(abis[1]);
            expect(store.findAtOrBefore.callCount).to.equal(1);
            expect(store.findAtOrBefore.firstCall.args).to.deep.equal(['atomicassets', 250]);
        });

        it('keeps a store hit older than eight cached rows and answers later blocks from memory', async () => {
            const store = createStore(sandbox, [row(200, abiA)]);
            const { fetchApi } = createChain(sandbox, abiC);
            const provider = createProvider(store, fetchApi);

            await provider.init();

            for (let blockNum = 300; blockNum <= 1000; blockNum += 100) {
                await provider.setAbi('atomicassets', blockNum, abiB);
            }

            expect(await provider.getAbi('atomicassets', 250)).to.equal(abiA);
            expect(store.findAtOrBefore.callCount).to.equal(1);

            expect(await provider.getAbi('atomicassets', 260)).to.equal(abiA);
            expect(await provider.getAbi('atomicassets', 299)).to.equal(abiA);
            expect(store.findAtOrBefore.callCount).to.equal(1);
        });

        it('caches one chain fallback per account, never saves it, and warns once', async () => {
            const store = createStore(sandbox);
            const { fetchApi } = createChain(sandbox, abiA);
            const provider = createProvider(store, fetchApi);
            const warnings = collectWarnings(provider);

            await provider.init();

            const concurrent = await Promise.all([
                provider.getAbi('atomicassets', 500),
                provider.getAbi('atomicassets', 500),
            ]);
            const replayed = [
                await provider.getAbi('atomicassets', 100),
                await provider.getAbi('atomicassets', 900),
            ];

            for (const abi of [...concurrent, ...replayed]) {
                expect(abi.equals(abiA)).to.equal(true);
            }

            expect(fetchApi.callCount).to.equal(1);
            expect(store.save.called).to.equal(false);
            expect(warnings).to.have.length(1);
            expect(warnings[0]!.message).to.include('atomicassets');
            expect(warnings[0]!.message).to.include('without saving');
        });

        it('drops the fallback once a published row arrives through setAbi', async () => {
            const store = createStore(sandbox);
            const { fetchApi } = createChain(sandbox, abiA);
            const provider = createProvider(store, fetchApi);

            await provider.init();
            await provider.getAbi('atomicassets', 500);
            await provider.setAbi('atomicassets', 600, abiB);

            expect(await provider.getAbi('atomicassets', 700)).to.equal(abiB);
            expect(fetchApi.callCount).to.equal(1);
        });

        it('queries the store for a block below the row it last returned (backward replay)', async () => {
            const store = createStore(sandbox, [row(700, abiA), row(1000, abiB)]);
            const { fetchApi } = createChain(sandbox, abiC);
            const provider = createProvider(store, fetchApi);

            await provider.init();

            expect(await provider.getAbi('atomicassets', 800)).to.equal(abiA);
            expect(await provider.getAbi('atomicassets', 1200)).to.equal(abiB);
            expect(store.findAtOrBefore.callCount).to.equal(1);

            // Another writer stores a row the cache never saw.
            store.rows.push(row(740, abiC));

            // 750 has the cached row 700 at or below it, but sits below the row last returned (1000).
            expect(await provider.getAbi('atomicassets', 750)).to.equal(abiC);
            expect(store.findAtOrBefore.callCount).to.equal(2);
            expect(store.findAtOrBefore.secondCall.args).to.deep.equal(['atomicassets', 750]);
        });

        it('answers with a cached row whose save failed over an older store row', async () => {
            const store = createStore(sandbox, [row(500, abiA), row(2000, abiC)]);
            store.save.rejects(new Error('statement failed'));
            const { fetchApi } = createChain(sandbox, abiC);
            const provider = createProvider(store, fetchApi);

            await provider.init();
            await provider.setAbi('atomicassets', 1000, abiB);

            expect(await provider.getAbi('atomicassets', 2500)).to.equal(abiC);

            // 1500 sits below the row last returned (2000), so the store is asked and offers only 500.
            expect(await provider.getAbi('atomicassets', 1500)).to.equal(abiB);
            expect(store.findAtOrBefore.callCount).to.equal(1);
            expect(store.findAtOrBefore.firstCall.args).to.deep.equal(['atomicassets', 1500]);
        });

        it('throws when the chain RPC fails on a fallback, and fetches again on the next call', async () => {
            const store = createStore(sandbox);
            const { fetchApi } = createChain(sandbox, abiA);
            fetchApi.onFirstCall().resolves(new Response('{"error":{"code":500}}', { status: 500 }));
            const provider = createProvider(store, fetchApi);

            await provider.init();

            const error = await provider.getAbi('atomicassets', 500).then(
                () => expect.fail('should have thrown'),
                (e: Error) => e
            );

            expect(error).to.be.instanceOf(Error);
            expect((await provider.getAbi('atomicassets', 500)).equals(abiA)).to.equal(true);
            expect(fetchApi.callCount).to.equal(2);
        });
    });

    describe('init', () => {
        it('throws when the store is unavailable', async () => {
            const store = createStore(sandbox);
            store.loadLatestPerAccount.rejects(new Error('store down'));
            const { fetchApi } = createChain(sandbox, abiA);
            const provider = createProvider(store, fetchApi);

            const error = await provider.init().then(
                () => expect.fail('should have thrown'),
                (e: Error) => e
            );

            expect(error.message).to.equal('store down');
        });
    });

    describe('setAbi', () => {
        it('saves the published row through the store', async () => {
            const store = createStore(sandbox);
            const { fetchApi } = createChain(sandbox, abiC);
            const provider = createProvider(store, fetchApi);

            await provider.init();
            await provider.setAbi('atomicassets', 1000, abiA);

            expect(store.save.firstCall.args).to.deep.equal([row(1000, abiA)]);
            expect(await provider.getAbi('atomicassets', 1000)).to.equal(abiA);
        });

        it('warns and keeps the cached row when a save fails', async () => {
            const store = createStore(sandbox);
            store.save.rejects(new Error('statement failed'));
            const { fetchApi } = createChain(sandbox, abiC);
            const provider = createProvider(store, fetchApi);
            const warnings = collectWarnings(provider);

            await provider.init();
            await provider.setAbi('atomicassets', 1000, abiA);

            expect(warnings).to.have.length(1);
            expect(warnings[0]!.message).to.include('atomicassets');
            expect(warnings[0]!.message).to.include('1000');
            expect(warnings[0]!.error?.message).to.equal('statement failed');
            expect(await provider.getAbi('atomicassets', 1200)).to.equal(abiA);
            expect(fetchApi.called).to.equal(false);
        });

        it('saves concurrent setAbi calls one at a time in call order', async () => {
            const store = createStore(sandbox);
            let releaseFirst: () => void = () => undefined;
            store.save.onFirstCall().callsFake(
                () =>
                    new Promise<void>((resolve) => {
                        releaseFirst = resolve;
                    })
            );
            const { fetchApi } = createChain(sandbox, abiC);
            const provider = createProvider(store, fetchApi);

            await provider.init();

            const first = provider.setAbi('atomicassets', 1000, abiA);
            const second = provider.setAbi('atomicassets', 1000, abiB);

            // Memory holds the last action before any save settles.
            expect(await provider.getAbi('atomicassets', 1000)).to.equal(abiB);

            await new Promise((resolve) => setImmediate(resolve));
            expect(store.save.callCount).to.equal(1);

            releaseFirst();
            await Promise.all([first, second]);

            expect(store.save.callCount).to.equal(2);
            expect(store.save.firstCall.args[0]).to.deep.equal(row(1000, abiA));
            expect(store.save.secondCall.args[0]).to.deep.equal(row(1000, abiB));
            expect(await provider.getAbi('atomicassets', 1000)).to.equal(abiB);
        });

        it('starts the next save after a failed save', async () => {
            const store = createStore(sandbox);
            store.save.onFirstCall().rejects(new Error('statement failed'));
            const { fetchApi } = createChain(sandbox, abiC);
            const provider = createProvider(store, fetchApi);
            const warnings = collectWarnings(provider);

            await provider.init();
            await Promise.all([
                provider.setAbi('atomicassets', 1000, abiA),
                provider.setAbi('atomicassets', 1000, abiB),
            ]);

            expect(store.save.callCount).to.equal(2);
            expect(store.save.secondCall.args[0]).to.deep.equal(row(1000, abiB));
            expect(store.rows).to.deep.equal([row(1000, abiB)]);
            expect(warnings).to.have.length(1);
            expect(warnings[0]!.error?.message).to.equal('statement failed');
        });
    });

    describe('getOlderAbis', () => {
        it('returns up to three rows strictly below the row getAbi resolved', async () => {
            const store = createStore(sandbox, [
                row(400, tableAbi('oldest')),
                row(500, abiA),
                row(600, abiB),
                row(700, abiC),
                row(1000, tableAbi('failing')),
            ]);
            const { fetchApi } = createChain(sandbox, abiC);
            const provider = createProvider(store, fetchApi);

            await provider.init();
            await provider.getAbi('atomicassets', 1500);

            expect(await provider.getOlderAbis('atomicassets', 1500)).to.deep.equal([abiC, abiB, abiA]);
            expect(store.findOlder.firstCall.args).to.deep.equal(['atomicassets', 1000, 3]);
        });

        it('offers every published row at or below the block when the fallback answered', async () => {
            const store = createStore(sandbox, [row(1000, abiB)]);
            const { fetchApi } = createChain(sandbox, abiA);
            const provider = createProvider(store, fetchApi);

            await provider.init();
            await provider.getAbi('atomicassets', 50);

            await provider.getOlderAbis('atomicassets', 50);

            expect(store.findOlder.firstCall.args).to.deep.equal(['atomicassets', 51, 3]);
        });
    });

    describe('refresh', () => {
        it('returns null when the chain ABI equals the cached ABI', async () => {
            const store = createStore(sandbox, [row(1000, abiA)]);
            const { fetchApi } = createChain(sandbox, abiA);
            const provider = createProvider(store, fetchApi);
            const warnings = collectWarnings(provider);

            await provider.init();

            expect(await provider.refresh('atomicassets', 1200)).to.equal(null);
            expect(fetchApi.callCount).to.equal(1);
            expect(warnings).to.have.length(0);
        });

        it('returns the chain ABI and warns when it differs from the cached ABI', async () => {
            const store = createStore(sandbox, [row(1000, abiA)]);
            const { fetchApi } = createChain(sandbox, abiB);
            const provider = createProvider(store, fetchApi);
            const warnings = collectWarnings(provider);

            await provider.init();

            const refreshed = await provider.refresh('atomicassets', 1200);

            expect(refreshed?.equals(abiB)).to.equal(true);
            expect(warnings).to.have.length(1);
            expect(warnings[0]!.message).to.include('atomicassets');
            expect(warnings[0]!.message).to.include('differs');
        });

        it('overrides a stale published entry in memory and leaves the store row alone', async () => {
            const store = createStore(sandbox, [row(1000, abiA)]);
            const { fetchApi } = createChain(sandbox, abiB);
            const provider = createProvider(store, fetchApi);

            await provider.init();
            await provider.refresh('atomicassets', 1200);

            expect((await provider.getAbi('atomicassets', 1300)).equals(abiB)).to.equal(true);
            expect((await provider.getAbi('atomicassets', 1000)).equals(abiB)).to.equal(true);
            expect(store.save.called).to.equal(false);
            expect(store.rows).to.deep.equal([row(1000, abiA)]);
        });

        it('caches the chain ABI as the fallback when no cached entry answers the block', async () => {
            const store = createStore(sandbox);
            const { fetchApi } = createChain(sandbox, abiA);
            const provider = createProvider(store, fetchApi);
            const warnings = collectWarnings(provider);

            await provider.init();

            expect((await provider.refresh('atomicassets', 500))?.equals(abiA)).to.equal(true);
            expect((await provider.getAbi('atomicassets', 600)).equals(abiA)).to.equal(true);
            expect(await provider.refresh('atomicassets', 700)).to.equal(null);
            expect(fetchApi.callCount).to.equal(1);
            expect(store.save.called).to.equal(false);
            expect(warnings).to.have.length(1);
        });

        it('makes no second fetch for a fallback getAbi fetched and returns null', async () => {
            const store = createStore(sandbox);
            const { fetchApi } = createChain(sandbox, abiA);
            const provider = createProvider(store, fetchApi);

            await provider.init();
            await provider.getAbi('atomicassets', 500);

            expect(await provider.refresh('atomicassets', 600)).to.equal(null);
            expect(fetchApi.callCount).to.equal(1);
        });

        it('keeps the compared mark until setAbi clears it', async () => {
            const store = createStore(sandbox, [row(1000, abiA)]);
            const { fetchApi } = createChain(sandbox, abiA);
            const provider = createProvider(store, fetchApi);

            await provider.init();

            expect(await provider.refresh('atomicassets', 1200)).to.equal(null);
            expect(await provider.refresh('atomicassets', 1300)).to.equal(null);
            await provider.getAbi('atomicassets', 1400);
            await provider.getOlderAbis('atomicassets', 1400);
            expect(await provider.refresh('atomicassets', 1500)).to.equal(null);
            expect(fetchApi.callCount).to.equal(1);

            await provider.setAbi('atomicassets', 2000, abiA);

            // The row at 1000 still answers block 1200, and its mark is gone.
            expect(await provider.refresh('atomicassets', 1200)).to.equal(null);
            expect(fetchApi.callCount).to.equal(2);
        });

        it('skips the fetch for the interval after a compare and fetches once the interval passes', async () => {
            const store = createStore(sandbox, [row(1000, abiA)]);
            const { fetchApi } = createChain(sandbox, abiA);
            const provider = createProvider(store, fetchApi);

            await provider.init();

            expect(await provider.refresh('atomicassets', 2000)).to.equal(null);
            expect(fetchApi.callCount).to.equal(1);

            expect(await provider.refresh('atomicassets', 3199)).to.equal(null);
            expect(fetchApi.callCount).to.equal(1);

            expect(await provider.refresh('atomicassets', 3200)).to.equal(null);
            expect(fetchApi.callCount).to.equal(2);

            // A block below the mark sits outside the interval too.
            expect(await provider.refresh('atomicassets', 3100)).to.equal(null);
            expect(fetchApi.callCount).to.equal(3);
        });

        it('takes the interval from refreshIntervalBlocks', async () => {
            const store = createStore(sandbox, [row(1000, abiA)]);
            const { fetchApi } = createChain(sandbox, abiA);
            const provider = createProvider(store, fetchApi, ['atomicassets'], 10);

            await provider.init();
            await provider.refresh('atomicassets', 2000);
            await provider.refresh('atomicassets', 2009);

            expect(fetchApi.callCount).to.equal(1);

            await provider.refresh('atomicassets', 2010);

            expect(fetchApi.callCount).to.equal(2);
        });

        it('marks a fallback getAbi fetched at the block of the fetch', async () => {
            const store = createStore(sandbox);
            const { fetchApi } = createChain(sandbox, abiA);
            const provider = createProvider(store, fetchApi);

            await provider.init();
            await provider.getAbi('atomicassets', 500);

            expect(await provider.refresh('atomicassets', 1699)).to.equal(null);
            expect(fetchApi.callCount).to.equal(1);

            expect(await provider.refresh('atomicassets', 1700)).to.equal(null);
            expect(fetchApi.callCount).to.equal(2);
        });

        it('shares one in-flight fetch per account and clears it on rejection', async () => {
            const store = createStore(sandbox, [row(1000, abiA)]);
            const { fetchApi } = createChain(sandbox, abiA);
            let rejectFetch: (error: Error) => void = () => undefined;
            fetchApi.onFirstCall().returns(
                new Promise<Response>((_, reject) => {
                    rejectFetch = reject;
                })
            );
            const provider = createProvider(store, fetchApi);

            await provider.init();

            const first = provider.refresh('atomicassets', 1200);
            const second = provider.refresh('atomicassets', 1300);

            expect(second).to.equal(first);

            await new Promise((resolve) => setImmediate(resolve));
            rejectFetch(new Error('rpc down'));

            const errors = await Promise.all(
                [first, second].map((pending) =>
                    pending.then(
                        () => expect.fail('should have thrown'),
                        (e: Error) => e
                    )
                )
            );

            expect(errors.map((e) => e.message)).to.deep.equal(['rpc down', 'rpc down']);
            expect(fetchApi.callCount).to.equal(1);

            // The rejection left no in-flight entry and no compared mark.
            expect(await provider.refresh('atomicassets', 1200)).to.equal(null);
            expect(fetchApi.callCount).to.equal(2);
        });
    });

    describe('rollback', () => {
        it('restores the published ABI when rollback goes below the refresh that replaced it', async () => {
            const store = createStore(sandbox, [row(1000, abiA)]);
            const { fetchApi } = createChain(sandbox, abiB);
            const provider = createProvider(store, fetchApi);

            await provider.init();

            expect((await provider.refresh('atomicassets', 1500))?.equals(abiB)).to.equal(true);

            provider.rollback(1499);

            expect(await provider.getAbi('atomicassets', 1450)).to.equal(abiA);
        });

        for (const rollbackBlock of [1500, 1700]) {
            it(`keeps the refresh replacement when rollback goes to ${rollbackBlock}, at or above its block`, async () => {
                const store = createStore(sandbox, [row(1000, abiA)]);
                const { fetchApi } = createChain(sandbox, abiB);
                const provider = createProvider(store, fetchApi);

                await provider.init();
                await provider.refresh('atomicassets', 1500);

                provider.rollback(rollbackBlock);

                expect((await provider.getAbi('atomicassets', 1800)).equals(abiB)).to.equal(true);
            });
        }

        for (const creator of ['getAbi', 'refresh'] as const) {
            it(`drops a fallback ${creator} fetched above the rollback block, and the next getAbi fetches again with a warn`, async () => {
                const store = createStore(sandbox);
                const { fetchApi } = createChain(sandbox, abiA);
                const provider = createProvider(store, fetchApi);
                const warnings = collectWarnings(provider);

                await provider.init();

                if (creator === 'getAbi') {
                    await provider.getAbi('atomicassets', 500);
                } else {
                    await provider.refresh('atomicassets', 500);
                }

                provider.rollback(499);

                expect((await provider.getAbi('atomicassets', 450)).equals(abiA)).to.equal(true);
                expect(fetchApi.callCount).to.equal(2);
                expect(warnings).to.have.length(2);
                expect(warnings[1]!.message).to.include('without saving');
            });
        }

        for (const rollbackBlock of [500, 600]) {
            it(`keeps a fallback fetched at or below the rollback block (${rollbackBlock})`, async () => {
                const store = createStore(sandbox);
                const { fetchApi } = createChain(sandbox, abiA);
                const provider = createProvider(store, fetchApi);

                await provider.init();
                await provider.getAbi('atomicassets', 500);

                provider.rollback(rollbackBlock);

                expect((await provider.getAbi('atomicassets', 450)).equals(abiA)).to.equal(true);
                expect(fetchApi.callCount).to.equal(1);
            });
        }

        it('forgets the row getAbi resolved above the rollback block', async () => {
            const store = createStore(sandbox, [row(700, abiA), row(1000, abiB)]);
            const { fetchApi } = createChain(sandbox, abiC);
            const provider = createProvider(store, fetchApi);

            await provider.init();
            await provider.getAbi('atomicassets', 1500);

            provider.rollback(900);
            await provider.getOlderAbis('atomicassets', 950);

            expect(store.findOlder.firstCall.args).to.deep.equal(['atomicassets', 951, 3]);
        });

        it('drops cached rows above the block and clears every compared mark', async () => {
            const store = createStore(sandbox);
            const { fetchApi } = createChain(sandbox, abiA);
            const provider = createProvider(store, fetchApi);

            await provider.init();
            await provider.setAbi('atomicassets', 1000, abiA);
            await provider.setAbi('atomicassets', 2000, abiB);

            expect(await provider.refresh('atomicassets', 1500)).to.equal(null);
            expect(fetchApi.callCount).to.equal(1);

            provider.rollback(1500);

            expect(await provider.getAbi('atomicassets', 2500)).to.equal(abiA);
            expect(await provider.refresh('atomicassets', 1500)).to.equal(null);
            expect(fetchApi.callCount).to.equal(2);
        });
    });
});
