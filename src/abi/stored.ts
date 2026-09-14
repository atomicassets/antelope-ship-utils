import { EventEmitter } from 'events';

import { ABI, APIClient, FetchProvider } from '@wharfkit/antelope';

import { IAbiProvider, IAbiStore } from '../types/interfaces';

interface IMemoAbi {
    abi: ABI;
    // The block of the last chain fetch that produced or checked the entry; setAbi and rollback clear it.
    comparedAt?: number;
}

interface ICachedRow extends IMemoAbi {
    block_num: number;
    // The ABI the setabi published, restored when rollback discards the refresh that replaced it.
    published: ABI;
    // The block of the refresh that replaced `abi`.
    replacedAt?: number;
}

interface IFallbackAbi extends IMemoAbi {
    // The block of the fetch that produced `abi`, so rollback can drop a fallback from a discarded block.
    fetchedAt: number;
}

interface IStoredAbiProviderParams {
    store: IAbiStore;
    accounts: string[];
    rpcEndpoint: string;
    fetchApi: typeof globalThis.fetch;
    refreshIntervalBlocks?: number;
}

const MAX_CACHED_ROWS = 8;
const OLDER_ABI_LIMIT = 3;
const DEFAULT_REFRESH_INTERVAL_BLOCKS = 1200;

export class StoredAbiProvider extends EventEmitter implements IAbiProvider {
    private readonly client: APIClient;
    private readonly store: IAbiStore;
    private readonly accounts: string[];
    private readonly refreshIntervalBlocks: number;

    // Published rows per account, newest first, each under the block that published it.
    private readonly cachedRows = new Map<string, ICachedRow[]>();
    // The chain's current ABI for an account with no published row at or below the block asked.
    private readonly fallbacks = new Map<string, IFallbackAbi>();
    // The block of the published row getAbi last returned, or 'fallback' when the fallback answered.
    private readonly resolved = new Map<string, number | 'fallback'>();
    private readonly fallbackFetches = new Map<string, Promise<IFallbackAbi>>();
    private readonly refreshes = new Map<string, Promise<ABI | null>>();
    // Saves reach the store one at a time, in setAbi call order.
    private saveQueue: Promise<void> = Promise.resolve();

    constructor(params: IStoredAbiProviderParams) {
        super();
        this.store = params.store;
        this.accounts = [...params.accounts];
        this.refreshIntervalBlocks = params.refreshIntervalBlocks ?? DEFAULT_REFRESH_INTERVAL_BLOCKS;
        this.client = new APIClient(
            new FetchProvider(params.rpcEndpoint, { fetch: params.fetchApi })
        );
    }

    async init(): Promise<void> {
        const rows = await this.store.loadLatestPerAccount(this.accounts);

        for (const row of rows) {
            this.cacheRow(row.account, { block_num: row.block_num, abi: row.abi, published: row.abi }, false);
        }
    }

    async getAbi(account: string, blockNum: number): Promise<ABI> {
        const resolved = this.resolved.get(account);
        const cached = this.findCachedRow(account, blockNum);

        if (typeof resolved !== 'number') {
            if (cached) {
                return this.answerWithRow(account, cached);
            }

            const fallback = this.fallbacks.get(account);

            if (fallback) {
                this.resolved.set(account, 'fallback');
                return fallback.abi;
            }
        } else if (cached && blockNum >= resolved) {
            return this.answerWithRow(account, cached);
        }

        // Below the last returned row the cache can miss an older row, so the store answers.
        const stored = await this.store.findAtOrBefore(account, blockNum);
        // A setAbi can land while the store query runs, so read the cache again.
        const current = this.findCachedRow(account, blockNum);

        if (stored && (!current || stored.block_num > current.block_num)) {
            const row = this.cacheRow(
                account,
                { block_num: stored.block_num, abi: stored.abi, published: stored.abi },
                false
            );

            return this.answerWithRow(account, row);
        }

        if (current) {
            return this.answerWithRow(account, current);
        }

        const fallback = this.fallbacks.get(account) ?? (await this.fetchFallback(account, blockNum));
        this.resolved.set(account, 'fallback');

        return fallback.abi;
    }

    async setAbi(account: string, blockNum: number, abi: ABI): Promise<void> {
        // Memory takes the action before any await, so the last setabi of a block answers.
        this.cacheRow(account, { block_num: blockNum, abi, published: abi }, true);

        for (const row of this.cachedRows.get(account) ?? []) {
            row.comparedAt = undefined;
        }

        // Two setabi actions for one account in one block arrive together; the later one is the stored row.
        const save = this.saveQueue.then(() => this.saveRow(account, blockNum, abi));
        this.saveQueue = save.catch(() => undefined);

        return save;
    }

    async getOlderAbis(account: string, blockNum: number): Promise<ABI[]> {
        const resolved = this.resolved.get(account);
        // Rows strictly below the row that failed; after the fallback, every row at or below blockNum.
        const belowBlockNum = typeof resolved === 'number' ? resolved : blockNum + 1;
        const rows = await this.store.findOlder(account, belowBlockNum, OLDER_ABI_LIMIT);

        return rows.map((row) => row.abi);
    }

    refresh(account: string, blockNum: number): Promise<ABI | null> {
        const comparedAt = this.findAnsweringEntry(account, blockNum)?.comparedAt;

        // A compare answers for the interval after its block; a failure that persists past it fetches again.
        if (comparedAt !== undefined && blockNum >= comparedAt && blockNum - comparedAt < this.refreshIntervalBlocks) {
            return Promise.resolve(null);
        }

        let pending = this.refreshes.get(account);

        if (!pending) {
            pending = this.compareWithChain(account, blockNum).finally(() => this.refreshes.delete(account));
            this.refreshes.set(account, pending);
        }

        return pending;
    }

    /**
     * Drops every cached row above `blockNum`, restores the published ABI of a row that a
     * refresh above `blockNum` replaced, drops a fallback fetched above `blockNum`, and clears
     * every compared mark, so a replay after a fork never reads state from a discarded block.
     * The store is not touched.
     */
    rollback(blockNum: number): void {
        for (const [account, rows] of this.cachedRows) {
            const kept = rows.filter((row) => row.block_num <= blockNum);

            for (const row of kept) {
                if (row.replacedAt !== undefined && row.replacedAt > blockNum) {
                    row.abi = row.published;
                    row.replacedAt = undefined;
                }

                row.comparedAt = undefined;
            }

            this.cachedRows.set(account, kept);
        }

        const droppedFallbacks = new Set<string>();

        for (const [account, fallback] of this.fallbacks) {
            if (fallback.fetchedAt > blockNum) {
                this.fallbacks.delete(account);
                droppedFallbacks.add(account);
            } else {
                fallback.comparedAt = undefined;
            }
        }

        for (const [account, resolved] of this.resolved) {
            if (resolved === 'fallback' ? droppedFallbacks.has(account) : resolved > blockNum) {
                this.resolved.delete(account);
            }
        }
    }

    private async saveRow(account: string, blockNum: number, abi: ABI): Promise<void> {
        try {
            await this.store.save({ account, block_num: blockNum, abi });
        } catch (e) {
            // The cached row keeps answering, so processing continues on the published ABI.
            this.emit(
                'warn',
                `Error saving ABI ${account} at block ${blockNum}, the cached ABI stays and the stored row is missing`,
                e instanceof Error ? e : new Error(String(e))
            );
        }
    }

    private async compareWithChain(account: string, blockNum: number): Promise<ABI | null> {
        const fetched = await this.fetchChainAbi(account);
        const row = this.findCachedRow(account, blockNum);
        const fallback = row ? undefined : this.fallbacks.get(account);
        const entry = row ?? fallback;

        if (!entry) {
            this.fallbacks.set(account, { abi: fetched, fetchedAt: blockNum, comparedAt: blockNum });
            this.emit('warn', `Refreshed ABI ${account} at block ${blockNum} with no cached ABI, using the chain ABI without saving it`);

            return fetched;
        }

        entry.comparedAt = blockNum;

        if (entry.abi.equals(fetched)) {
            return null;
        }

        // The store row keeps the published history; only memory reads the chain ABI.
        entry.abi = fetched;

        if (row) {
            row.replacedAt = blockNum;
        } else if (fallback) {
            fallback.fetchedAt = blockNum;
        }

        this.emit('warn', `Refreshed ABI ${account} at block ${blockNum}, the cached ABI differs from the chain ABI`);

        return fetched;
    }

    private fetchFallback(account: string, blockNum: number): Promise<IFallbackAbi> {
        let pending = this.fallbackFetches.get(account);

        if (!pending) {
            pending = this.fetchChainAbi(account)
                .then((abi) => {
                    // The entry is the chain ABI itself, so a refresh within the interval has nothing new to fetch.
                    const fallback = { abi, fetchedAt: blockNum, comparedAt: blockNum };
                    this.fallbacks.set(account, fallback);
                    this.emit('warn', `No stored ABI ${account} at or below block ${blockNum}, using the chain ABI without saving it`);

                    return fallback;
                })
                .finally(() => this.fallbackFetches.delete(account));
            this.fallbackFetches.set(account, pending);
        }

        return pending;
    }

    private async fetchChainAbi(account: string): Promise<ABI> {
        const result = await this.client.v1.chain.get_abi(account);

        if (!result.abi) {
            throw new Error(`No Abi found for ${account}`);
        }

        return ABI.from(result.abi);
    }

    private findCachedRow(account: string, blockNum: number): ICachedRow | undefined {
        return this.cachedRows.get(account)?.find((row) => row.block_num <= blockNum);
    }

    private findAnsweringEntry(account: string, blockNum: number): IMemoAbi | undefined {
        return this.findCachedRow(account, blockNum) ?? this.fallbacks.get(account);
    }

    private answerWithRow(account: string, row: ICachedRow): ABI {
        this.resolved.set(account, row.block_num);

        return row.abi;
    }

    /**
     * Inserts a published row and returns the row cached at its block. A published row
     * replaces the account's fallback. Beyond the bound the oldest row drops, except the row
     * this call caches: a store row older than every cached row would otherwise leave at once
     * and cost a store query per block.
     */
    private cacheRow(account: string, row: ICachedRow, replace: boolean): ICachedRow {
        const rows = this.cachedRows.get(account) ?? [];
        const index = rows.findIndex((cached) => cached.block_num === row.block_num);
        let entry = row;

        if (index < 0) {
            rows.push(row);
            rows.sort((a, b) => b.block_num - a.block_num);
        } else if (replace) {
            rows[index] = row;
        } else {
            entry = rows[index]!;
        }

        while (rows.length > MAX_CACHED_ROWS) {
            rows.splice(rows[rows.length - 1] === entry ? rows.length - 2 : rows.length - 1, 1);
        }

        this.cachedRows.set(account, rows);
        this.fallbacks.delete(account);

        return entry;
    }
}
