# @atomichub/antelope-ship-utils

[![npm version](https://img.shields.io/npm/v/@atomichub/antelope-ship-utils.svg)](https://www.npmjs.com/package/@atomichub/antelope-ship-utils)
[![CI](https://github.com/atomicassets/antelope-ship-utils/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/atomicassets/antelope-ship-utils/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@atomichub/antelope-ship-utils.svg)](https://github.com/atomicassets/antelope-ship-utils/blob/main/LICENSE)

A State History Plugin (SHIP) client for Antelope chains. It opens a
websocket to a node's SHIP endpoint, deserializes the blocks, traces, and
deltas the node streams back, and drives a consumer over the result.

The package exports `StateHistoryConnection`, the websocket client that
requests blocks from SHIP and reconnects when the connection drops;
`ShipConsumer`, which paces block delivery against an
`IProcessedBlockRepository` so a restart resumes where it left off;
`BlockProcessor`, which routes each block's traces and deltas to the trace
and delta listeners registered on it; `EOSJsDeserializer`, which turns raw
SHIP bytes into typed data and can run the deserialization in worker
threads; and `LocalAbiProvider`, an in-memory ABI cache backed by an
Antelope RPC endpoint.

## Install

```sh
pnpm add @atomichub/antelope-ship-utils
```

## Usage

The shapes below come straight from the constructors in `src/`. Treat this
as a sketch: a real consumer supplies its own repository, trace and delta
listeners, and error handling.

```ts
import {
    StateHistoryConnection,
    ShipConsumer,
    BlockProcessor,
    EOSJsDeserializer,
    LocalAbiProvider,
    LocalBlockRepository,
} from '@atomichub/antelope-ship-utils';

const deserializer = new EOSJsDeserializer({ threads: 4 });

const abiProvider = new LocalAbiProvider({
    rpcEndpoint: 'https://wax.greymass.com',
    fetchApi: fetch,
});

const processor = new BlockProcessor({
    deserializer,
    abiProvider,
    failOnDeserializationError: false,
    traceListeners: [
        {
            account: 'atomicassets',
            name: 'logmint',
            processor: async ({ trace, block }) => {
                // handle the deserialized trace
            },
        },
    ],
});

// A real repository persists the cursor; this one starts from a fixed block.
const repository = new LocalBlockRepository(300000000);

const consumer = new ShipConsumer({ repository, processor, blockDelay: 0 });

const connection = new StateHistoryConnection({
    endpoint: 'wss://wax.greymass.com/ship',
    deserializer,
});

connection.on('error', (err) => {
    // see "Error handling" below: the queue does not resume on its own
});

await connection.startProcessing(consumer);
```

## IShipConnectionOptions

Passed as `connectionOptions` to `StateHistoryConnection`. Every field is
optional; the defaults are the ones `StateHistoryConnection` applies.

| Option | Default | Meaning |
| --- | --- | --- |
| `min_block_confirmation` | `1` | Blocks to accumulate before the client acks them back to the node. |
| `allow_empty_traces` | `false` | Accept a block whose trace payload is empty instead of treating it as a stalled node and reconnecting. |
| `allow_empty_deltas` | `false` | Same, for an empty delta payload. |
| `allow_empty_blocks` | `false` | Same, for an empty block payload. |
| `heartbeat_interval_ms` | `30000` | Interval between websocket pings while connected. |
| `idle_timeout_ms` | `300000` | Terminate the socket, and reconnect, once this long passes with no message or pong, catching a half-open connection whose peer disappeared without a close frame. |
| `max_blocks_queue` | `0` | Ceiling on the block queue: while the queue holds at least this many blocks the ack is withheld, so the node stops at `max_messages_in_flight` until the queue drains and the accumulated count goes out in one ack. A withheld ack does not trip the idle timeout, because the heartbeat pong keeps refreshing the activity clock. Zero applies no ceiling. |

## Error handling

A consumer rejection or a deserialization failure emits `'error'` on the
`StateHistoryConnection` with a `ShipError`, then clears and pauses the
block queue and rejects the queued task that failed. The rejection is not
caught anywhere in the package, so it surfaces as an unhandled rejection in
the host process. Nothing in the package resumes the paused queue: a
consumer that wants to keep running past an error needs to call
`startProcessing()` again after handling the failure.

## Lineage

This package reworks [eosio-ship-utils](https://www.npmjs.com/package/eosio-ship-utils)
on npm, which is unmaintained, and carries the protocol's current name,
Antelope, in place of the EOSIO name the predecessor used. See `NOTICE` for
the attribution. Use this package instead for SHIP clients on Antelope chains.

## Development

```sh
pnpm install
pnpm run build
pnpm test
pnpm run lint
pnpm run check-types
```

## Releasing

See [RELEASING.md](./RELEASING.md).
