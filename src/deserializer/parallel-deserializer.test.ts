import { ABI, Serializer } from '@wharfkit/antelope';
import { expect } from 'chai';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import Piscina from 'piscina';
import * as sinon from 'sinon';

import type { ParallelDeserializer as ParallelDeserializerType } from './parallel-deserializer';
import type { EOSJsDeserializer as EOSJsDeserializerType } from './eos-js-deserializer';
import { SingleThreadDeserializer } from './singlethread-deserializer';
import type { IDeserializer } from '../types/ship';

// Exercise the shipped CommonJS worker and its compiled imports. pretest builds it.
const {
    ParallelDeserializer,
    EOSJsDeserializer,
}: {
    ParallelDeserializer: typeof ParallelDeserializerType;
    EOSJsDeserializer: typeof EOSJsDeserializerType;
} = require('../../dist');

const abiJson = {
    version: 'eosio::abi/1.1',
    structs: [
        {
            name: 'sample',
            base: '',
            fields: [
                { name: 'owner', type: 'name' },
                { name: 'weight', type: 'float64' },
                { name: 'wears', type: 'float32[]' },
                { name: 'serial', type: 'uint64' },
            ],
        },
    ],
};
const abi = ABI.from(abiJson);
const data = Serializer.encode({
    type: 'sample',
    abi,
    object: { owner: 'alice', weight: 92.13924923, wears: [0.6197762, 0.5], serial: '18446744073709551615' },
}).array;
const task = [{ type: 'sample', data }];
type Batch = Parameters<IDeserializer['deserialize']>[0];

async function rejection(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (error) {
        expect(error).to.be.instanceOf(Error);
        return error as Error;
    }
    throw new Error('Expected rejection');
}

describe('Piscina deserializer', () => {
    const pools: IDeserializer[] = [];

    function parallel(threads = 1): ParallelDeserializerType {
        const pool = new ParallelDeserializer(abiJson, threads);
        pools.push(pool);
        return pool;
    }

    afterEach(async () => {
        sinon.restore();
        await Promise.all(pools.splice(0).map((pool) => pool.terminate()));
    });

    it('matches single-thread results, ABI overrides, errors and ordering across concurrent batches', async () => {
        const pool = parallel(2);
        const override = {
            version: 'eosio::abi/1.1',
            structs: [
                {
                    name: 'sample',
                    base: '',
                    fields: [{ name: 'value', type: 'uint8' }],
                },
            ],
        };
        const batch: Batch = [
            task[0],
            { type: 'sample', data: Buffer.from(data).toString('hex') },
            { type: 'sample', data: new Uint8Array([7]), abi: override },
            // ABI instances are supplied by BlockProcessor as well as JSON ABIs.
            { type: 'sample', data: new Uint8Array([9]), abi: ABI.from(override) },
            undefined,
            { type: 'sample', data: '' },
            { type: 'sample', data: new Uint8Array() },
            { type: 'missing', data },
            { type: 'sample', data: new Uint8Array([1]) },
            { type: 'sample', data: null } as unknown as Batch[number],
            task[0],
            { type: 'name', data: '0000000000855c34' },
        ];
        const expected = await new SingleThreadDeserializer(abiJson).deserialize(batch);
        const results = await Promise.all(Array.from({ length: 6 }, () => pool.deserialize(batch)));
        for (const result of results) expect(result).to.deep.equal(expected);
        expect(expected[0]).to.deep.equal({
            success: true,
            data: {
                owner: 'alice',
                weight: 92.13924923,
                wears: [0.61977618932724, 0.5],
                serial: '18446744073709551615',
            },
        });
        expect(expected[2]).to.deep.equal({ success: true, data: { value: 7 } });
        expect(expected[4]).to.deep.equal({
            success: false,
            data: null,
            message: 'Error: Empty data received on deserialize worker',
        });
        expect(expected.at(-1)).to.deep.equal({ success: true, data: 'alice' });
        // Structured cloning must not detach caller-owned buffers.
        expect(data.byteLength).to.be.greaterThan(0);
        expect(await pool.deserialize([])).to.deep.equal([]);
        expect(pool.waiting).to.equal(0);
    });

    it('counts queued and running batches until each promise completes', async () => {
        const pool = parallel();
        let unfinished = 5;
        const pending = Array.from({ length: unfinished }, () =>
            pool.deserialize(task).then((result) => {
                expect(pool.waiting).to.equal(--unfinished);
                return result;
            }),
        );
        expect(pool.waiting).to.equal(5);
        await Promise.all(pending);
        expect(pool.waiting).to.equal(0);
    });

    it('rejects malformed batches and uncloneable tasks, restores accounting and keeps the worker usable', async () => {
        const pool = parallel();
        for (const batch of [null, {}, () => undefined]) {
            const pending = pool.deserialize(batch as unknown as Batch);
            await rejection(pending);
            expect(pool.waiting).to.equal(0);
        }
        expect(await pool.deserialize(task)).to.deep.equal(
            await new SingleThreadDeserializer(abiJson).deserialize(task),
        );
    });

    it('rejects active/queued work on termination, stays closed and terminates idempotently', async () => {
        const pool = parallel();
        // Submit before worker bootstrap completes so no task can finish first.
        const pending = Array.from({ length: 4 }, () => rejection(pool.deserialize(task)));
        expect(pool.waiting).to.equal(4);
        const stopping = pool.terminate();
        expect(pool.terminate()).to.equal(stopping);
        await Promise.all([stopping, ...pending]);
        expect(pool.waiting).to.equal(0);
        await rejection(pool.deserialize(task));
        expect(pool.waiting).to.equal(0);
    });

    it('surfaces worker ABI bootstrap errors through promises without stranding the queue', async () => {
        const pool = new ParallelDeserializer(null);
        pools.push(pool);
        const pending = Array.from({ length: 3 }, () => rejection(pool.deserialize(task)));
        await Promise.all(pending);
        expect(pool.waiting).to.equal(0);
        await rejection(pool.deserialize(task));
    });

    it('aborts a running batch and queued batches in a warm pool', async () => {
        const pool = parallel();
        await pool.deserialize(task);
        // The first batch is dispatched to the ready worker, the rest queue.
        const largeBatch = Array.from({ length: 10000 }, () => task[0]);
        const active = rejection(pool.deserialize(largeBatch));
        const queued = Array.from({ length: 3 }, () => rejection(pool.deserialize(task)));
        await pool.terminate();
        await Promise.all([active, ...queued]);
        expect(pool.waiting).to.equal(0);
    });

    it('retains explicit fixed worker counts and rejects invalid sizes before spawning', async () => {
        const pool = parallel(2);
        await pool.deserialize(task);
        const workers: Piscina = (pool as any).deserializeWorkers;
        expect(workers.minThreads).to.equal(2);
        expect(workers.maxThreads).to.equal(2);
        expect(workers.threads).to.have.length(2);
        await pool.deserialize(task);
        expect(workers.threads).to.have.length(2);
        for (const threads of [0, -1, NaN, Infinity, 1.5]) {
            expect(() => new ParallelDeserializer(abiJson, threads)).to.throw(RangeError);
        }
    });

    for (const threads of [undefined, 0, -1, 1]) {
        it(`preserves strategy selection and reconnect ABI initialization (threads=${threads})`, async () => {
            const decoder = new EOSJsDeserializer({ threads });
            pools.push(decoder);
            await decoder.terminate();
            expect(() => decoder.deserialize(task)).to.throw('called before init()');
            expect(decoder.waiting).to.equal(0);
            await decoder.init(abiJson);
            const result = decoder.deserialize(task);
            expect(decoder.waiting).to.equal(1);
            expect(await result).to.deep.equal(await new SingleThreadDeserializer(abiJson).deserialize(task));
            expect(decoder.waiting).to.equal(0);
            await decoder.terminate();
            const nextAbi = {
                version: 'eosio::abi/1.1',
                structs: [
                    {
                        name: 'sample',
                        base: '',
                        fields: [{ name: 'new_value', type: 'uint8' }],
                    },
                ],
            };
            await decoder.init(nextAbi);
            expect(await decoder.deserialize([{ type: 'sample', data: new Uint8Array([12]) }])).to.deep.equal([
                { success: true, data: { new_value: 12 } },
            ]);
        });
    }

    it('holds wrapper waiting until both success and failure settle, including synchronous throws', async () => {
        const decoder = new EOSJsDeserializer({ threads: 1 });
        pools.push(decoder);
        await decoder.init(abiJson);
        const run = sinon.stub(Piscina.prototype, 'run');
        let complete!: (result: unknown) => void;
        let fail!: (error: Error) => void;
        run.onFirstCall().returns(
            new Promise((resolve) => {
                complete = resolve;
            }),
        );
        run.onSecondCall().returns(
            new Promise((_, reject) => {
                fail = reject;
            }),
        );
        const success = decoder.deserialize(task);
        const failure = rejection(decoder.deserialize(task));
        expect(decoder.waiting).to.equal(2);
        complete([]);
        await success;
        expect(decoder.waiting).to.equal(1);
        fail(new Error('worker failed'));
        expect((await failure).message).to.equal('worker failed');
        expect(decoder.waiting).to.equal(0);
        run.throws(new Error('submission failed'));
        expect((await rejection(decoder.deserialize(task))).message).to.equal('submission failed');
        expect(decoder.waiting).to.equal(0);
    });

    it('propagates wrapper cancellation and releases workers so a CommonJS consumer exits naturally', async () => {
        const decoder = new EOSJsDeserializer({ threads: 1 });
        pools.push(decoder);
        await decoder.init(abiJson);
        const pending = rejection(decoder.deserialize(task));
        await decoder.terminate();
        await pending;
        expect(decoder.waiting).to.equal(0);

        const entry = resolve(__dirname, '../../dist');
        const script = `
            const { EOSJsDeserializer } = require(${JSON.stringify(entry)});
            (async () => {
                const decoder = new EOSJsDeserializer({ threads: 2 });
                await decoder.init(${JSON.stringify(abiJson)});
                const result = await decoder.deserialize([{ type: 'uint8', data: new Uint8Array([42]) }]);
                if (result[0].data !== 42) throw new Error('Unexpected decode');
                await decoder.terminate();
            })().catch((error) => { console.error(error); process.exitCode = 1; });
        `;
        // No forced process.exit/Mocha --exit: leaked workers would hit timeout.
        await promisify(execFile)(process.execPath, ['-e', script], { cwd: tmpdir(), timeout: 5000 });
    });
});
