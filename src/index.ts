import { ShipConsumer } from './consumer/consumer';
import { EOSJsDeserializer } from './deserializer/eos-js-deserializer';
import { ParallelDeserializer } from './deserializer/parallel-deserializer';
import ShipError from './error/ship';
import { BlockProcessor } from './processor/processor';
import { StateHistoryConnection } from './ship';
import { LocalAbiProvider } from './abi/local';
import { LocalBlockRepository } from './consumer/repositories/local';
import { objectifyNumericFloats } from './deserializer/objectify';
import {
    deserializeAbi,
    deserializeEosioType,
    extractShipDeltas,
    extractShipTraces,
    getActionAbiType,
    getTableAbiType,
    serializeEosioType,
} from './deserializer/serialization';

export {
    ShipConsumer,
    EOSJsDeserializer,
    ParallelDeserializer,
    ShipError,
    BlockProcessor,
    StateHistoryConnection,
    LocalAbiProvider,
    LocalBlockRepository,
    objectifyNumericFloats,
    deserializeAbi,
    deserializeEosioType,
    extractShipDeltas,
    extractShipTraces,
    getActionAbiType,
    getTableAbiType,
    serializeEosioType,
};

export type { IConsumerSettings } from './consumer/consumer';
export type { IDeserializeOptions } from './deserializer/serialization';
export type { IAbiProvider, IBlockProcessor, IProcessedBlockRepository, IShipConsumer } from './types/interfaces';
export type { ShipBlock, ShipBlockResponse, ShipTableDelta, ShipTransactionTrace } from './types/ship';

export * from './types/ship';
export * from './types/leap';
