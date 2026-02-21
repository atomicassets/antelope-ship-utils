import { IDeserializer } from '../types/ship';
import { ParallelDeserializer } from './parallel-deserializer';
import { SingleThreadDeserializer } from './singlethread-deserializer';

interface IDeserializerParams {
    threads?: number;
}

export class EOSJsDeserializer implements IDeserializer {
    waiting: number = 0;

    private strategyDeserializer: IDeserializer;

    constructor(private readonly params: IDeserializerParams) {}

    init(abi: any): Promise<void> {
        if (this.params.threads && this.params.threads > 0) {
            this.strategyDeserializer = new ParallelDeserializer(abi, this.params.threads);
        } else {
            this.strategyDeserializer = new SingleThreadDeserializer(abi);
        }
        return Promise.resolve();
    }

    deserialize(
        param: Array<{ type: string; data: Uint8Array | string; abi?: any } | undefined>
    ): Promise<Array<{ success: boolean; data: unknown; message?: string }>> {
        this.waiting += 1;

        try {
            return this.strategyDeserializer.deserialize(param);
        } finally {
            this.waiting -= 1;
        }
    }

    terminate(): Promise<void> {
        if (!this.strategyDeserializer) {
            return Promise.resolve();
        }
        return this.strategyDeserializer.terminate();
    }
}
