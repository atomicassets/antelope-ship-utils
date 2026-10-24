import Piscina from 'piscina';
import { IDeserializer } from '../types/ship';

export class ParallelDeserializer implements IDeserializer {
    waiting: number = 0;

    private readonly deserializeWorkers: Piscina;
    private termination?: Promise<void>;
    private workerError?: Error;

    constructor(abi: any, threads: number = 1) {
        if (!Number.isSafeInteger(threads) || threads < 1) {
            throw new RangeError('Deserializer threads must be a positive safe integer');
        }

        this.deserializeWorkers = new Piscina({
            filename: `${__dirname}/worker.js`,
            // Match the fixed-size pool: keep exactly the requested workers warm.
            // CPU budgets belong to the caller, who may run several readers.
            minThreads: threads,
            maxThreads: threads,
            idleTimeout: Infinity,
            recordTiming: false,
            workerData: { abi },
        });

        // Bootstrap/idle failures have no task to reject. Keep them on the
        // deserialize/terminate promise path instead of an unhandled error event.
        this.deserializeWorkers.on('error', (error: Error) => {
            this.workerError = error;
            void this.terminate().catch(() => undefined);
        });
    }

    async deserialize(
        param: Array<{ type: string; data: Uint8Array | string; abi?: any } | undefined>,
    ): Promise<Array<{ success: boolean; data: unknown; message?: string }>> {
        this.waiting += 1;

        try {
            if (this.workerError) {
                throw this.workerError;
            }
            if (this.termination) {
                throw new Error('This pool is deprecated! Please use a new one.');
            }
            return await this.deserializeWorkers.run(param);
        } finally {
            this.waiting -= 1;
        }
    }

    terminate(): Promise<void> {
        // Piscina permits reuse after destroy(); this deserializer stays closed
        // until EOSJsDeserializer.init() creates a new strategy on reconnect.
        return (this.termination ??= this.deserializeWorkers.destroy());
    }
}
