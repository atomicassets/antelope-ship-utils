import { ShipBlockResponse } from '../../types/ship';
import { IProcessedBlockRepository } from '../../types/interfaces';

export class LocalBlockRepository implements IProcessedBlockRepository {
    constructor(
        private currentBlock: number,
        private reversibleBlocks: Array<{ block_id: string; block_num: number }> = []
    ) {}

    async updateReversibleBlock(resp: ShipBlockResponse): Promise<void> {
        this.reversibleBlocks.push({
            block_num: resp.block.block_num,
            block_id: resp.block.block_id,
        });

        this.reversibleBlocks = this.reversibleBlocks.filter(
            (block) => block.block_num >= resp.last_irreversible.block_num
        );
    }

    async getLastProcessedBlock(): Promise<number> {
        return this.currentBlock;
    }

    async getReversibleBlocks(): Promise<Array<{ block_num: number; block_id: string }>> {
        return this.reversibleBlocks;
    }

    async updateLastProcessedBlock(resp: ShipBlockResponse): Promise<void> {
        this.currentBlock = resp.block.block_num;
    }
}
