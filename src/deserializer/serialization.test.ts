import { ABI, Serializer } from '@wharfkit/antelope';
import { expect } from 'chai';

import {
    convertEosioTimestampToDate,
    deserializeEosioType,
    serializeEosioType,
    extractShipTraces,
    extractShipDeltas,
    getTableAbiType,
    getActionAbiType,
    deserializeAbi,
} from './serialization';

// Minimal ABI with a struct, table, and action for testing
const testAbiDef = {
    version: 'eosio::abi/1.1',
    types: [],
    structs: [
        {
            name: 'transfer',
            base: '',
            fields: [
                { name: 'from', type: 'name' },
                { name: 'to', type: 'name' },
                { name: 'quantity', type: 'asset' },
                { name: 'memo', type: 'string' },
            ],
        },
        {
            name: 'account',
            base: '',
            fields: [
                { name: 'balance', type: 'asset' },
            ],
        },
        {
            name: 'pair',
            base: '',
            fields: [
                { name: 'id', type: 'uint64' },
                { name: 'active', type: 'bool' },
            ],
        },
    ],
    actions: [
        { name: 'transfer', type: 'transfer', ricardian_contract: '' },
    ],
    tables: [
        { name: 'accounts', type: 'account', index_type: 'i64', key_names: [], key_types: [] },
        { name: 'pairs', type: 'pair', index_type: 'i64', key_names: [], key_types: [] },
    ],
    ricardian_clauses: [],
    error_messages: [],
    abi_extensions: [],
    variants: [],
};

const testAbi = ABI.from(testAbiDef);

describe('serialization', () => {
    describe('convertEosioTimestampToDate', () => {
        it('should convert EOSIO timestamp to Date in UTC', () => {
            const date = convertEosioTimestampToDate('2023-01-15T12:30:45.000');
            expect(date).to.be.instanceOf(Date);
            expect(date.toISOString()).to.equal('2023-01-15T12:30:45.000Z');
        });

        it('should handle timestamp without milliseconds', () => {
            const date = convertEosioTimestampToDate('2024-06-01T00:00:00');
            expect(date.toISOString()).to.equal('2024-06-01T00:00:00.000Z');
        });

        it('should handle epoch-ish timestamps', () => {
            const date = convertEosioTimestampToDate('2000-01-01T00:00:00.000');
            expect(date.toISOString()).to.equal('2000-01-01T00:00:00.000Z');
        });
    });

    describe('deserializeEosioType', () => {
        it('should deserialize binary data using ABI type', () => {
            // Encode a known value, then verify deserialization round-trips
            const transferData = {
                from: 'alice',
                to: 'bob',
                quantity: '1.00000000 WAX',
                memo: 'test payment',
            };
            const encoded = Serializer.encode({ object: transferData, type: 'transfer', abi: testAbi });

            const result = deserializeEosioType('transfer', encoded.array, testAbi);
            expect(result.from).to.equal('alice');
            expect(result.to).to.equal('bob');
            expect(result.quantity).to.equal('1.00000000 WAX');
            expect(result.memo).to.equal('test payment');
        });

        it('should accept hex string input', () => {
            const pairData = { id: 42, active: true };
            const encoded = Serializer.encode({ object: pairData, type: 'pair', abi: testAbi });
            const hex = Buffer.from(encoded.array).toString('hex');

            const result = deserializeEosioType('pair', hex, testAbi);
            expect(result.id).to.equal(42); // uint64 comes back as number via objectify
            expect(result.active).to.equal(true); // bool stays bool
        });

        it('should accept Uint8Array input', () => {
            const accountData = { balance: '100.0000 EOS' };
            const encoded = Serializer.encode({ object: accountData, type: 'account', abi: testAbi });

            const result = deserializeEosioType('account', encoded.array, testAbi);
            expect(result.balance).to.equal('100.0000 EOS');
        });

        it('should return objectified plain JS values', () => {
            // Verify that Name types come back as strings, not Name objects
            const transferData = {
                from: 'alice',
                to: 'bob',
                quantity: '0.00000001 WAX',
                memo: '',
            };
            const encoded = Serializer.encode({ object: transferData, type: 'transfer', abi: testAbi });

            const result = deserializeEosioType('transfer', encoded.array, testAbi);
            expect(typeof result.from).to.equal('string');
            expect(typeof result.to).to.equal('string');
            expect(typeof result.memo).to.equal('string');
        });
    });

    describe('serializeEosioType', () => {
        it('should serialize a struct to Uint8Array', () => {
            const pairData = { id: 1, active: false };
            const result = serializeEosioType('pair', pairData, testAbi);
            expect(result).to.be.instanceOf(Uint8Array);
            expect(result.length).to.be.greaterThan(0);
        });

        it('should round-trip with deserializeEosioType', () => {
            const original = {
                from: 'eosio',
                to: 'testaccount1',
                quantity: '50.00000000 WAX',
                memo: 'round trip test',
            };

            const serialized = serializeEosioType('transfer', original, testAbi);
            const deserialized = deserializeEosioType('transfer', serialized, testAbi);

            expect(deserialized.from).to.equal('eosio');
            expect(deserialized.to).to.equal('testaccount1');
            expect(deserialized.quantity).to.equal('50.00000000 WAX');
            expect(deserialized.memo).to.equal('round trip test');
        });

        it('should produce deterministic output', () => {
            const data = { id: 999, active: true };
            const result1 = serializeEosioType('pair', data, testAbi);
            const result2 = serializeEosioType('pair', data, testAbi);
            expect(Buffer.from(result1).toString('hex')).to.equal(Buffer.from(result2).toString('hex'));
        });
    });

    describe('getTableAbiType', () => {
        it('should return the type for a known table', () => {
            expect(getTableAbiType(testAbi, 'eosio.token', 'accounts')).to.equal('account');
        });

        it('should return the type for another known table', () => {
            expect(getTableAbiType(testAbi, 'mycontract', 'pairs')).to.equal('pair');
        });

        it('should throw for unknown table', () => {
            expect(() => getTableAbiType(testAbi, 'mycontract', 'nonexistent'))
                .to.throw('Type for table not found mycontract:nonexistent');
        });
    });

    describe('getActionAbiType', () => {
        it('should return the type for a known action', () => {
            expect(getActionAbiType(testAbi, 'eosio.token', 'transfer')).to.equal('transfer');
        });

        it('should throw for unknown action', () => {
            expect(() => getActionAbiType(testAbi, 'eosio.token', 'nonexistent'))
                .to.throw('Type for action not found eosio.token:nonexistent');
        });
    });

    describe('deserializeAbi', () => {
        it('should deserialize a serialized ABI back into an ABI object', () => {
            // Serialize the test ABI, then deserialize it
            const serialized = Serializer.encode({ object: ABI.from(testAbiDef), type: ABI });
            const result = deserializeAbi(serialized.array);

            expect(result).to.be.instanceOf(ABI);
            // Verify the round-tripped ABI has the same tables and actions
            expect(result.tables.length).to.equal(testAbiDef.tables.length);
            expect(result.actions.length).to.equal(testAbiDef.actions.length);
            expect(result.structs.length).to.equal(testAbiDef.structs.length);
        });

        it('should produce a usable ABI for deserialization', () => {
            const serialized = Serializer.encode({ object: ABI.from(testAbiDef), type: ABI });
            const abi = deserializeAbi(serialized.array);

            // Use the round-tripped ABI to decode data
            const pairData = { id: 7, active: true };
            const encoded = Serializer.encode({ object: pairData, type: 'pair', abi });
            const decoded = deserializeEosioType('pair', encoded.array, abi);
            expect(decoded.id).to.equal(7);
            expect(decoded.active).to.equal(true);
        });
    });

    describe('extractShipTraces', () => {
        const dummyBlock = {
            block_num: 100,
            block_id: 'abc123',
            head: { block_num: 100, block_id: 'abc123' },
            last_irreversible: { block_num: 99, block_id: 'abc122' },
        };

        function makeTrace(
            id: string,
            status: number,
            actions: Array<{
                account: string;
                name: string;
                receiver: string;
                global_sequence: string;
                action_ordinal: number;
                creator_action_ordinal: number;
            }>
        ) {
            return [
                'transaction_trace_v0',
                {
                    id,
                    status,
                    cpu_usage_us: 100,
                    net_usage_words: 10,
                    elapsed: '100',
                    net_usage: '80',
                    scheduled: false,
                    action_traces: actions.map((a) => [
                        'action_trace_v0',
                        {
                            action_ordinal: a.action_ordinal,
                            creator_action_ordinal: a.creator_action_ordinal,
                            receipt: [
                                'action_receipt_v0',
                                {
                                    receiver: a.receiver,
                                    act_digest: 'digest',
                                    global_sequence: a.global_sequence,
                                    recv_sequence: '1',
                                    auth_sequence: [],
                                    code_sequence: 1,
                                    abi_sequence: 1,
                                },
                            ],
                            receiver: a.receiver,
                            act: {
                                account: a.account,
                                name: a.name,
                                authorization: [{ actor: 'alice', permission: 'active' }],
                                data: new Uint8Array([1, 2, 3]),
                            },
                            context_free: false,
                            elapsed: '50',
                            console: '',
                            account_ram_deltas: [],
                            except: null,
                            error_code: null,
                        },
                    ]),
                    account_ram_delta: null,
                    except: null,
                    error_code: null,
                    failed_dtrx_trace: null,
                    partial: [
                        'partial_transaction_v0',
                        {
                            expiration: '2023-01-01T00:00:00',
                            ref_block_num: 0,
                            ref_block_prefix: 0,
                            max_net_usage_words: 0,
                            max_cpu_usage_ms: 0,
                            delay_sec: 0,
                            transaction_extensions: [],
                            signatures: [],
                            context_free_data: [],
                        },
                    ],
                },
            ] as any;
        }

        it('should extract traces from successful transactions', () => {
            const traces = [
                makeTrace('tx1', 0, [
                    {
                        account: 'atomicassets',
                        name: 'transfer',
                        receiver: 'atomicassets',
                        global_sequence: '100',
                        action_ordinal: 1,
                        creator_action_ordinal: 0,
                    },
                ]),
            ];

            const result = extractShipTraces({ traces, block: dummyBlock });
            expect(result).to.have.length(1);
            expect(result[0]!.trace.act.account).to.equal('atomicassets');
            expect(result[0]!.trace.act.name).to.equal('transfer');
            expect(result[0]!.tx.id).to.equal('tx1');
        });

        it('should skip transactions with non-zero status (failed)', () => {
            const traces = [
                makeTrace('tx_failed', 1, [
                    {
                        account: 'eosio.token',
                        name: 'transfer',
                        receiver: 'eosio.token',
                        global_sequence: '200',
                        action_ordinal: 1,
                        creator_action_ordinal: 0,
                    },
                ]),
            ];

            const result = extractShipTraces({ traces, block: dummyBlock });
            expect(result).to.have.length(0);
        });

        it('should filter out notification traces (receiver != account)', () => {
            const traces = [
                makeTrace('tx2', 0, [
                    {
                        account: 'eosio.token',
                        name: 'transfer',
                        receiver: 'eosio.token', // primary — keep
                        global_sequence: '300',
                        action_ordinal: 1,
                        creator_action_ordinal: 0,
                    },
                    {
                        account: 'eosio.token',
                        name: 'transfer',
                        receiver: 'alice', // notification — discard
                        global_sequence: '301',
                        action_ordinal: 2,
                        creator_action_ordinal: 1,
                    },
                ]),
            ];

            const result = extractShipTraces({ traces, block: dummyBlock });
            expect(result).to.have.length(1);
            expect(result[0]!.trace.act.account).to.equal('eosio.token');
            expect(result[0]!.trace.global_sequence).to.equal('300');
        });

        it('should sort traces by global_sequence', () => {
            const traces = [
                makeTrace('tx3', 0, [
                    {
                        account: 'atomicassets',
                        name: 'logmint',
                        receiver: 'atomicassets',
                        global_sequence: '500',
                        action_ordinal: 1,
                        creator_action_ordinal: 0,
                    },
                    {
                        account: 'atomicassets',
                        name: 'logtransfer',
                        receiver: 'atomicassets',
                        global_sequence: '400',
                        action_ordinal: 2,
                        creator_action_ordinal: 0,
                    },
                ]),
            ];

            const result = extractShipTraces({ traces, block: dummyBlock });
            expect(result).to.have.length(2);
            expect(result[0]!.trace.global_sequence).to.equal('400');
            expect(result[1]!.trace.global_sequence).to.equal('500');
        });

        it('should handle multiple transactions', () => {
            const traces = [
                makeTrace('tx_a', 0, [
                    {
                        account: 'a',
                        name: 'act',
                        receiver: 'a',
                        global_sequence: '10',
                        action_ordinal: 1,
                        creator_action_ordinal: 0,
                    },
                ]),
                makeTrace('tx_b', 0, [
                    {
                        account: 'b',
                        name: 'act',
                        receiver: 'b',
                        global_sequence: '5',
                        action_ordinal: 1,
                        creator_action_ordinal: 0,
                    },
                ]),
            ];

            const result = extractShipTraces({ traces, block: dummyBlock });
            expect(result).to.have.length(2);
            // Sorted by global_sequence across all transactions
            expect(result[0]!.trace.global_sequence).to.equal('5');
            expect(result[1]!.trace.global_sequence).to.equal('10');
        });

        it('should handle action_trace_v1 traces', () => {
            const trace: any = [
                'transaction_trace_v0',
                {
                    id: 'tx_v1',
                    status: 0,
                    cpu_usage_us: 100,
                    net_usage_words: 10,
                    elapsed: '100',
                    net_usage: '80',
                    scheduled: false,
                    action_traces: [
                        [
                            'action_trace_v1',
                            {
                                action_ordinal: 1,
                                creator_action_ordinal: 0,
                                receipt: [
                                    'action_receipt_v0',
                                    {
                                        receiver: 'mycontract',
                                        act_digest: 'digest',
                                        global_sequence: '700',
                                        recv_sequence: '1',
                                        auth_sequence: [],
                                        code_sequence: 1,
                                        abi_sequence: 1,
                                    },
                                ],
                                receiver: 'mycontract',
                                act: {
                                    account: 'mycontract',
                                    name: 'dosomething',
                                    authorization: [],
                                    data: new Uint8Array([]),
                                },
                                context_free: false,
                                elapsed: '50',
                                console: '',
                                account_ram_deltas: [],
                                except: null,
                                error_code: null,
                            },
                        ],
                    ],
                    account_ram_delta: null,
                    except: null,
                    error_code: null,
                    failed_dtrx_trace: null,
                    partial: ['partial_transaction_v0', {}],
                },
            ];

            const result = extractShipTraces({ traces: [trace], block: dummyBlock });
            expect(result).to.have.length(1);
            expect(result[0]!.trace.act.name).to.equal('dosomething');
        });

        it('should throw for unsupported transaction type', () => {
            const badTrace = ['unknown_type_v99', {}] as any;
            expect(() => extractShipTraces({ traces: [badTrace], block: dummyBlock }))
                .to.throw('Unsupported transaction response received: unknown_type_v99');
        });

        it('should throw for unsupported action trace type', () => {
            const trace: any = [
                'transaction_trace_v0',
                {
                    id: 'tx_bad_action',
                    status: 0,
                    cpu_usage_us: 0,
                    net_usage_words: 0,
                    elapsed: '0',
                    net_usage: '0',
                    scheduled: false,
                    action_traces: [['action_trace_v99', {}]],
                    account_ram_delta: null,
                    except: null,
                    error_code: null,
                    failed_dtrx_trace: null,
                    partial: ['partial_transaction_v0', {}],
                },
            ];
            expect(() => extractShipTraces({ traces: [trace], block: dummyBlock }))
                .to.throw('Invalid action trace type action_trace_v99');
        });

        it('should return empty array for empty traces', () => {
            const result = extractShipTraces({ traces: [], block: dummyBlock });
            expect(result).to.deep.equal([]);
        });
    });

    describe('extractShipDeltas', () => {
        const dummyBlock = {
            block_num: 100,
            block_id: 'abc123',
            head: { block_num: 100, block_id: 'abc123' },
            last_irreversible: { block_num: 99, block_id: 'abc122' },
        };

        function makeContractRowDelta(
            tableName: string,
            rows: Array<{ present: boolean; code: string; scope: string; table: string; primary_key: string; payer: string; value: Uint8Array }>
        ): any {
            return [
                'table_delta_v0',
                {
                    name: tableName,
                    rows: rows.map((r) => ({
                        present: r.present,
                        data: [
                            'contract_row_v0',
                            {
                                code: r.code,
                                scope: r.scope,
                                table: r.table,
                                primary_key: r.primary_key,
                                payer: r.payer,
                                value: r.value,
                            },
                        ],
                    })),
                },
            ];
        }

        it('should extract contract_row deltas when serializedDeltas includes table name', () => {
            const delta = makeContractRowDelta('contract_row', [
                {
                    present: true,
                    code: 'atomicassets',
                    scope: 'atomicassets',
                    table: 'assets',
                    primary_key: '1099511627776',
                    payer: 'alice',
                    value: new Uint8Array([10, 20, 30]),
                },
            ]);

            const result = extractShipDeltas({
                deltas: [delta],
                serializedDeltas: ['contract_row'],
                block: dummyBlock,
            });

            expect(result).to.have.length(1);
            expect(result[0]!.delta.code).to.equal('atomicassets');
            expect(result[0]!.delta.table).to.equal('assets');
            expect(result[0]!.delta.present).to.equal(true);
        });

        it('should set present=false for removed rows', () => {
            const delta = makeContractRowDelta('contract_row', [
                {
                    present: false,
                    code: 'eosio.token',
                    scope: 'alice',
                    table: 'accounts',
                    primary_key: '0',
                    payer: 'alice',
                    value: new Uint8Array([]),
                },
            ]);

            const result = extractShipDeltas({
                deltas: [delta],
                serializedDeltas: ['contract_row'],
                block: dummyBlock,
            });

            expect(result).to.have.length(1);
            expect(result[0]!.delta.present).to.equal(false);
        });

        it('should skip deltas not in serializedDeltas list', () => {
            const delta = makeContractRowDelta('contract_row', [
                {
                    present: true,
                    code: 'eosio',
                    scope: 'eosio',
                    table: 'global',
                    primary_key: '0',
                    payer: 'eosio',
                    value: new Uint8Array([1]),
                },
            ]);

            // Not including 'contract_row' in serializedDeltas
            const result = extractShipDeltas({
                deltas: [delta],
                serializedDeltas: [],
                block: dummyBlock,
            });

            expect(result).to.have.length(0);
        });

        it('should skip non-contract_row delta names even if in serializedDeltas', () => {
            const delta: any = [
                'table_delta_v0',
                {
                    name: 'account_metadata',
                    rows: [],
                },
            ];

            const result = extractShipDeltas({
                deltas: [delta],
                serializedDeltas: ['account_metadata'],
                block: dummyBlock,
            });

            expect(result).to.have.length(0);
        });

        it('should handle table_delta_v1', () => {
            const delta: any = [
                'table_delta_v1',
                {
                    name: 'contract_row',
                    rows: [
                        {
                            present: true,
                            data: [
                                'contract_row_v0',
                                {
                                    code: 'test',
                                    scope: 'test',
                                    table: 'data',
                                    primary_key: '1',
                                    payer: 'test',
                                    value: new Uint8Array([]),
                                },
                            ],
                        },
                    ],
                },
            ];

            const result = extractShipDeltas({
                deltas: [delta],
                serializedDeltas: ['contract_row'],
                block: dummyBlock,
            });

            expect(result).to.have.length(1);
            expect(result[0]!.delta.code).to.equal('test');
        });

        it('should throw for unsupported delta type', () => {
            const badDelta = ['table_delta_v99', { name: 'test', rows: [] }] as any;
            expect(() => extractShipDeltas({
                deltas: [badDelta],
                serializedDeltas: ['test'],
                block: dummyBlock,
            })).to.throw('Unsupported table delta response received: table_delta_v99');
        });

        it('should throw for unsupported contract row type', () => {
            const delta: any = [
                'table_delta_v0',
                {
                    name: 'contract_row',
                    rows: [
                        {
                            present: true,
                            data: ['contract_row_v99', {}],
                        },
                    ],
                },
            ];

            expect(() => extractShipDeltas({
                deltas: [delta],
                serializedDeltas: ['contract_row'],
                block: dummyBlock,
            })).to.throw('Unsupported contract row received: contract_row_v99');
        });

        it('should handle empty deltas array', () => {
            const result = extractShipDeltas({
                deltas: [],
                block: dummyBlock,
            });
            expect(result).to.deep.equal([]);
        });

        it('should handle multiple rows in a single delta', () => {
            const delta = makeContractRowDelta('contract_row', [
                {
                    present: true,
                    code: 'atomicassets',
                    scope: 'atomicassets',
                    table: 'assets',
                    primary_key: '1',
                    payer: 'alice',
                    value: new Uint8Array([1]),
                },
                {
                    present: true,
                    code: 'atomicassets',
                    scope: 'atomicassets',
                    table: 'assets',
                    primary_key: '2',
                    payer: 'bob',
                    value: new Uint8Array([2]),
                },
            ]);

            const result = extractShipDeltas({
                deltas: [delta],
                serializedDeltas: ['contract_row'],
                block: dummyBlock,
            });

            expect(result).to.have.length(2);
            expect(result[0]!.delta.payer).to.equal('alice');
            expect(result[1]!.delta.payer).to.equal('bob');
        });
    });
});
