import { StaticPool } from 'node-worker-threads-pool';
import { IDeserializer } from '../types/ship';

export class ParallelDeserializer implements IDeserializer {
    waiting: number = 0;

    private deserializeWorkers: StaticPool<
        (x: Array<{ type: string; data: Uint8Array | string; abi?: any }>) => Array<{
            success: true;
            data: unknown;
            message?: string;
        }>
    >;

    constructor(abi: any, threads: number = 1) {
        this.deserializeWorkers = new StaticPool({
            size: threads,
            task: `${__dirname}/worker.js`,
            workerData: { abi },
        });
    }

    deserialize(
        param: Array<{ type: string; data: Uint8Array | string; abi?: any } | undefined>
    ): Promise<Array<{ success: boolean; data: unknown; message?: string }>> {
        this.waiting += 1;

        try {
            return this.deserializeWorkers.exec(param);
        } finally {
            this.waiting -= 1;
        }
    }

    terminate(): Promise<void> {
        return this.deserializeWorkers.destroy();
    }
}
