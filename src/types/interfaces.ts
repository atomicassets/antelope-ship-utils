import { ABI } from '@wharfkit/antelope';

import {
    FullShipBlock,
    IBlockRequest,
    IExtractedShipDelta,
    IExtractedShipTrace,
    ShipBlockResponse,
} from './ship';

export interface IAbiProvider {
    init(): Promise<any>;

    getAbi(contract: string, blockNum: number): Promise<ABI>;

    setAbi(contract: string, blockNum: number, abi: ABI): Promise<void>;

    getOlderAbis?(contract: string, blockNum: number): Promise<ABI[]>;
}

export interface IShipConsumer {
    consume(block: ShipBlockResponse): Promise<any>;

    getRequestBlockConfig(): Promise<IBlockRequest>;

    getRequiredDeltas(): string[];
}

export interface IProcessedBlockRepository {
    updateReversibleBlock(resp: ShipBlockResponse): Promise<void>;

    getLastProcessedBlock(): Promise<number>;

    getReversibleBlocks(): Promise<Array<{ block_num: number; block_id: string }>>;

    updateLastProcessedBlock(resp: ShipBlockResponse): Promise<void>;
}

export interface IBlockProcessor {
    onBlockStart(data: { block: FullShipBlock }): Promise<void>;

    processBlock(data: {
        block: FullShipBlock;
        traces: IExtractedShipTrace<Uint8Array>[];
        deltas: IExtractedShipDelta<Uint8Array>[];
    }): Promise<void>;

    onBlockFinished(data: { block: FullShipBlock }): Promise<void>;
}
