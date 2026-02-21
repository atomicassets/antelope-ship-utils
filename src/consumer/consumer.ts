import { IBlockProcessor, IProcessedBlockRepository, IShipConsumer } from '../types/interfaces';
import {
    FullShipBlock,
    IBlockRequest,
    IExtractedShipDelta,
    IExtractedShipTrace,
    ShipBlockResponse,
} from '../types/ship';
import { extractShipDeltas, extractShipTraces } from '../deserializer/serialization';

export interface IConsumerSettings {
    delta_types: string[];
    end_block: number;
    fetch_deltas: boolean;
    fetch_traces: boolean;
    irreversible_only: boolean;
    max_messages_in_flight: number;
    min_block_confirmations: number;
}

interface IShipConsumerParams {
    consumerOptions?: Partial<IConsumerSettings>;
    repository: IProcessedBlockRepository;
    processor: IBlockProcessor;
    blockDelay: number;
}

export class ShipConsumer implements IShipConsumer {
    private readonly consumerOptions: IConsumerSettings;
    private readonly repository: IProcessedBlockRepository;
    private readonly processor: IBlockProcessor;
    private readonly blockDelay: number;

    private delayedBlocks: ShipBlockResponse[];

    constructor(params: IShipConsumerParams) {
        this.repository = params.repository;
        this.processor = params.processor;
        this.consumerOptions = {
            delta_types: ['contract_row'],
            end_block: 0xffffffff,
            fetch_deltas: true,
            fetch_traces: true,
            irreversible_only: true,
            max_messages_in_flight: 1,
            min_block_confirmations: 1,
            ...(params.consumerOptions || {}),
        };
        this.blockDelay = params.blockDelay;
        this.delayedBlocks = [];
    }

    async getRequestBlockConfig(): Promise<IBlockRequest> {
        return {
            fetch_deltas: this.consumerOptions.fetch_deltas,
            fetch_traces: this.consumerOptions.fetch_traces,
            fetch_block: true,
            have_positions: await this.repository.getReversibleBlocks(),
            start_block_num: (await this.repository.getLastProcessedBlock()) + 1,
            max_messages_in_flight: this.consumerOptions.max_messages_in_flight,
            end_block_num: this.consumerOptions.end_block,
            irreversible_only: this.consumerOptions.irreversible_only,
        };
    }

    getRequiredDeltas(): string[] {
        return this.consumerOptions.delta_types;
    }

    async consume(resp: ShipBlockResponse): Promise<void> {
        this.delayedBlocks = this.delayedBlocks.filter((row) => row.block.block_num < resp.block.block_num);
        this.delayedBlocks.push(resp);

        while (this.delayedBlocks.length > this.blockDelay) {
            const nextBlock = this.delayedBlocks.shift();

            await this.processBlock(nextBlock);
        }
    }

    async processBlock(resp: ShipBlockResponse): Promise<void> {
        const fullBlock: FullShipBlock = {
            this_block: resp.block,
            prev_block: resp.prev_block,
            last_irreversible: resp.last_irreversible,
            head: resp.head,
        };

        await this.processor.onBlockStart({ block: fullBlock });

        await this.processor.processBlock({
            block: fullBlock,
            deltas: this.processDeltas(resp),
            traces: this.processTraces(resp),
        });

        await this.repository.updateReversibleBlock(resp);
        await this.repository.updateLastProcessedBlock(resp);

        await this.processor.onBlockFinished({ block: fullBlock });
    }

    private processDeltas(resp: ShipBlockResponse): IExtractedShipDelta<Uint8Array>[] {
        if (this.consumerOptions.fetch_deltas) {
            return extractShipDeltas({
                block: resp.block,
                deltas: resp.deltas,
                serializedDeltas: this.consumerOptions.delta_types,
            });
        }
        return [];
    }

    private processTraces(resp: ShipBlockResponse): IExtractedShipTrace[] {
        if (this.consumerOptions.fetch_traces) {
            return extractShipTraces({
                traces: resp.traces,
                block: resp.block,
            });
        }
    }
}
