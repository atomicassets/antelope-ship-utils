import { ABI } from '@wharfkit/antelope';

import { deserializeEosioType } from './serialization';
import { IDeserializer } from '../types/ship';

export class SingleThreadDeserializer implements IDeserializer {
    waiting: number = 0;

    private readonly shipAbi: ABI;

    constructor(abi: any) {
        this.shipAbi = ABI.from(abi);
    }

    deserialize(
        param: Array<{ type: string; data: Uint8Array | string; abi?: any } | undefined>
    ): Promise<Array<{ success: boolean; data: unknown; message?: string }>> {
        const result = [];

        for (const row of param) {
            try {
                if (!row || !row.data) {
                    throw new Error('Empty data received on deserialize worker');
                }

                if (row.abi) {
                    const rowAbi = ABI.from(row.abi);

                    result.push({
                        success: true,
                        data: deserializeEosioType(row.type, row.data, rowAbi, false),
                    });
                } else {
                    result.push({
                        success: true,
                        data: deserializeEosioType(row.type, row.data, this.shipAbi),
                    });
                }
            } catch (error) {
                result.push({
                    success: false,
                    data: null,
                    message: String(error),
                });
            }
        }

        return Promise.resolve(result);
    }

    terminate(): Promise<void> {
        return Promise.resolve(undefined);
    }
}
