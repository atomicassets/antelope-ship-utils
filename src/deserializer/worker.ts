import { parentPort, workerData } from 'worker_threads';
import { SingleThreadDeserializer } from './singlethread-deserializer';
import { Abi } from 'eosjs/dist/eosjs-rpc-interfaces';

const args: { abi: Abi } = workerData;

const singleThreadDeserializer = new SingleThreadDeserializer(args.abi);

parentPort.on('message', async (param: Array<{ type: string; data: Uint8Array | string; abi?: any }>) => {
    const result = await singleThreadDeserializer.deserialize(param);

    return parentPort.postMessage(result);
});
