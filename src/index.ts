import { ShipConsumer } from './consumer/consumer';
import { EOSJsDeserializer } from './deserializer/eos-js-deserializer';
import { ParallelDeserializer } from './deserializer/parallel-deserializer';
import ShipError from './error/ship';
import { BlockProcessor } from './processor/processor';
import { StateHistoryConnection } from './ship';
import { LocalAbiProvider } from './abi/local';
import { LocalBlockRepository } from './consumer/repositories/local';

export {
    ShipConsumer,
    EOSJsDeserializer,
    ParallelDeserializer,
    ShipError,
    BlockProcessor,
    StateHistoryConnection,
    LocalAbiProvider,
    LocalBlockRepository,
};

export type { IConsumerSettings } from './consumer/consumer';
export type { IAbiProvider, IBlockProcessor, IProcessedBlockRepository, IShipConsumer } from './types/interfaces';
export type { ShipBlock, ShipBlockResponse, ShipTableDelta, ShipTransactionTrace } from './types/ship';

export * from './types/ship';
export * from './types/leap';
