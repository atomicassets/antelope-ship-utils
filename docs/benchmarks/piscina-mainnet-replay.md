# WAX mainnet deserializer replays

Measured on 2026-10-24 using the real `atomicassets-api` filler, live SHIP/RPC
access to a full-history WAX node, and fresh isolated PostgreSQL databases.
The API source was pinned to `81a9fe22d1a8771e57076c0d08e57e29b96173d9`
([API PR #250](https://github.com/atomicassets/atomicassets-api/pull/250)). Its
catalog replay fix was needed because an initial run on API main stopped at
block 64,107,699 on a duplicate AtomicMarket token key. That failed attempt is
excluded from the results.

Both variants used identical API code and locked dependencies. The library
baseline was `6e63cdf003b770f18acea06126e9b1ac8a3daacd` with
`node-worker-threads-pool` 1.5.1; the candidate was
`35c5bf2455d18be4997df7d0e686c6b7518b85cf` with Piscina 5.3.2. Full compiled
library builds were overlaid into separate images of the same API application.
The baseline's original pool, worker and wrapper were reconstructed from their
committed sources. No consumer source changes were needed for the pool switch.

## Conditions for the 10,000-block replays

- Node 24.18.0, Docker Desktop Linux, AMD Ryzen 7 9800X3D; 16 logical CPUs
  available, ten explicitly configured deserialization workers per run.
- PostgreSQL 16 Alpine and Valkey 8 in dedicated benchmark containers on their
  own Docker network, with no database ports exposed to the host. Each run
  used a separate fresh database; the benchmark's Valkey was cleared between
  runs. Other worktrees' services and databases were not used or modified.
- Blocks **64,104,000 through 64,113,999**, inclusive; the SHIP request's
  exclusive end was 64,114,000. This starts just before the initial
  AtomicAssets deployment in the configured historical sync range.
- All four configured handlers: AtomicAssets, DelphiOracle, AtomicMarket and
  AtomicTools. `db_group_blocks=100`, `ship_prefetch_blocks=500`,
  `ship_ds_queue_size=20`; the other reader settings were the same in both
  variants. The same immutable block range was requested for every run.
- The API's normal schema initialization, migrations and filler binary were
  used. Read-only timing hooks in the worker measured the interval from the
  first receiver `consume()` call through completion of the final block's
  processing and commit. Image builds, schema setup and handler startup were
  outside this interval. Hooks and dependency overlays were identical across
  variants, except for the selected library build.

## 10,000-block results

Run order was old, Piscina, Piscina, old, then old, Piscina, Piscina, old, to
counterbalance ordering and source cache effects. The additional four runs
recreated the isolated services after cleanup and used the same pinned code,
runtime versions, configuration and block range. Each of the eight runs committed all
10,000 contiguous blocks without task or processing errors:

- Old pool, first run: **5.67488 s**, **1,762.15 blocks/s**.
- Piscina, first run: **4.77807 s**, **2,092.90 blocks/s**.
- Piscina, reverse-order run: **4.91647 s**, **2,033.98 blocks/s**.
- Old pool, reverse-order run: **5.11123 s**, **1,956.48 blocks/s**.
- Old pool, third run: **5.19489 s**, **1,924.97 blocks/s**.
- Piscina, third run: **4.89397 s**, **2,043.33 blocks/s**.
- Piscina, fourth run (reverse order): **4.84343 s**, **2,064.65 blocks/s**.
- Old pool, fourth run (reverse order): **5.23692 s**, **1,909.52 blocks/s**.

Across four runs per variant, mean elapsed time was **5.30448 s old / 4.85799 s
Piscina**, and median elapsed time was **5.21591 / 4.86870 s**. Throughput
computed from the mean elapsed times was **1,885.20 / 2,058.47 blocks/s**:
Piscina had **9.19% higher throughput**, or **8.42% lower elapsed time**, in this
sample. The individual pairs imply gains of about 4% to 19%, so the mean is
preliminary rather than a precise deployment forecast.

Mean worker-process CPU time (including its deserialization threads) was
18.538 s old / 18.288 s Piscina. Mean peak process RSS was 824.96 MiB old /
937.51 MiB Piscina. The candidate used more memory with ten warm workers.

Every run submitted 40,000 deserialization tasks containing 173,868 task rows.
The indexed range included 100 assets, one collection, one schema and one
template. Nineteen tables were populated. Checksums matched across **55 tables**
after these explicit normalizations:

- `contract_readers.updated` is a wall-clock liveness value and was omitted.
- `atomicassets_asset_counts` was compared by summing assets, burned and owned
  for each contract/collection/schema/template. The asynchronous aggregation
  job left one run's 100 dirty counter rows uncombined while other runs had
  one aggregated row; the logical totals were identical.
- `dbinfo` was excluded because migration/autovacuum timestamps differ between
  fresh databases. Its schema-version value was identical.

The additional four runs' normalized checksums also matched the first
validated old-pool run. The first four runs' equivalence checks were retained
with their results before removing their original benchmark database volume.

Every in-memory `lastCommittedBlock` reached 64,113,999. The durable reader
checkpoint was identically 64,113,699 in all runs: the existing periodic
checkpoint policy can lag the last committed batch. That policy was unchanged.

## One-million-block comparison

A further comparison used WAX blocks **64,104,000 through 65,103,999**,
inclusive (exclusive end **65,104,000**), with one run per pool. The pinned API
and library builds, Node 24.18.0, all four handlers, ten workers, 100-block DB
batches and 500-block prefetch were unchanged. Each variant started with a fresh
isolated database; the old pool ran first, then Piscina. Timing again excluded
schema setup, handler startup and the initial block's deserialization before
the first receiver `consume()` call.

| Measurement | StaticPool 1.5.1 | Piscina 5.3.2 |
| --- | ---: | ---: |
| Committed blocks | 1,000,000 | 1,000,000 |
| Elapsed time | 485.631 s (8m 5.63s) | 461.227 s (7m 41.23s) |
| Throughput | 2,059.18 blocks/s | 2,168.13 blocks/s |
| Worker-process CPU time, including its threads | 1,550.376 s | 1,577.837 s |
| Peak process RSS | 1,905.52 MiB | 2,260.93 MiB |
| Deserialization tasks | 4,000,000 | 4,000,000 |
| Task rows | 19,761,689 | 19,761,689 |
| Task or processing errors | 0 | 0 |
| Warnings | 4 | 4 |

Piscina finished **24.404 seconds sooner**, with **5.29% higher throughput** and
**5.03% lower elapsed time** in this pair. It used **355.41 MiB more peak RSS**
and slightly more worker-process CPU time. This is one comparison, not a
general speed or memory forecast.

Both runs committed every block consecutively, and their durable checkpoints
reached **65,103,999**. Each indexed 3,299 assets, 144 collections, 223 schemas,
146 templates, 1,242 market sales, 1,524 transfers and 405 links. Checksums
matched across 55 tables with the short-run normalizations above and one
additional operational normalization: `atomicmarket_sales_filters_updates.seq`
was excluded. This generated scheduling ordinal differed between runs; all
5,836 pending-work keys and their priorities were identical. No other pending
work fields or indexed contract data were omitted from that comparison.

The four warning messages were identical: an `eosio` ABI cache fetch, the
historical removal of the WAX supported-token row and USD:WAX symbol pair, and
a malformed ABI for `dopestickers`. The API logged and skipped that unrelated
account's invalid ABI update in both runs; no sync, task or indexing error
resulted. This comparison does not claim to repair that ABI handling.

## Interpretation and limits

The filler uses a 500-block prefetch window, ten workers, four task kinds
and overlapping deserialization/database work. It favored Piscina in this
replay. The comparison does not isolate a single internal scheduler optimization
as the cause.

Limitations: four short runs per variant and one million-block run per variant,
one host and node, warm source caches, no CPU isolation, startup excluded, and
asynchronous maintenance/GC can vary. The short range has only 100 indexed
assets; the million-block range has 3,299. Both cover early contract activity,
not a busy modern mint/drop window. The longer comparison was not repeated or
counterbalanced, so cache/order effects remain possible. These results depend on the
API replay fix in PR #250 and do not constitute its full test suite or replace
this library PR's required CI checks. No package was published or deployed.
