import { ABI, APIClient, FetchProvider } from '@wharfkit/antelope';

import { IAbiProvider } from '../types/interfaces';

interface IAbiHistory {
    abi: ABI;
    account: string;
    block_num: number;
}

interface ILocalAbiProviderParams {
    rpcEndpoint: string;
    fetchApi: typeof globalThis.fetch;
}

export class LocalAbiProvider implements IAbiProvider {
    private client: APIClient;
    private savedAbis: IAbiHistory[] = [];

    constructor(params: ILocalAbiProviderParams) {
        this.client = new APIClient(
            new FetchProvider(params.rpcEndpoint, { fetch: params.fetchApi })
        );
    }

    async init(): Promise<void> {}

    async getAbi(contract: string, blockNum: number): Promise<ABI> {
        const firstTry = this.savedAbis.find((row) => row.account === contract && blockNum >= row.block_num);

        if (firstTry) {
            return firstTry.abi;
        }

        const secondTry = this.savedAbis.find((row) => row.account === contract);

        if (secondTry) {
            return secondTry.abi;
        }

        const info = await this.client.v1.chain.get_info();
        const result = await this.client.v1.chain.get_abi(contract);

        if (!result.abi) {
            throw new Error(`No Abi found for ${contract}`);
        }

        const abi = ABI.from(result.abi);
        await this.setAbi(contract, Number(info.head_block_num), abi);

        return abi;
    }

    async setAbi(contract: string, blockNum: number, abi: ABI): Promise<void> {
        this.savedAbis.unshift({
            account: contract,
            block_num: blockNum,
            abi,
        });

        this.savedAbis.sort((a, b) => b.block_num - a.block_num);

        return Promise.resolve();
    }
}
