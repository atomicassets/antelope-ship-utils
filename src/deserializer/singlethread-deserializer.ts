import { Serialize } from 'eosjs';

import { deserializeEosioType } from './serialization';
import { Abi } from 'eosjs/dist/eosjs-rpc-interfaces';
import { IDeserializer } from '../types/ship';

export class SingleThreadDeserializer implements IDeserializer {
    waiting: number = 0;

    private readonly eosJSTypes: Map<string, Serialize.Type>;

    constructor(abi: Abi) {
        this.eosJSTypes = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), abi);
    }

    deserialize(
        param: Array<{ type: string; data: Uint8Array | string; abi?: Abi } | undefined>
    ): Promise<Array<{ success: boolean; data: unknown; message?: string }>> {
        const result = [];

        for (const row of param) {
            try {
                if (!row || !row.data) {
                    throw new Error('Empty data received on deserialize worker');
                }

                if (row.abi) {
                    const abiTypes = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), row.abi);

                    result.push({
                        success: true,
                        data: deserializeEosioType(row.type, row.data, abiTypes, false),
                    });
                } else {
                    result.push({
                        success: true,
                        data: deserializeEosioType(row.type, row.data, this.eosJSTypes),
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
