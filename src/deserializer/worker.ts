import { parentPort, workerData } from 'worker_threads';
import { SingleThreadDeserializer } from './singlethread-deserializer';

const args: { abi: any } = workerData;

const singleThreadDeserializer = new SingleThreadDeserializer(args.abi);

// This module only ever runs as a worker_threads worker (spawned via
// node-worker-threads-pool with task: worker.js), so parentPort is always set.
const port = parentPort;
if (!port) {
    throw new Error('deserializer worker.ts must be run inside a worker thread');
}

port.on('message', async (param: Array<{ type: string; data: Uint8Array | string; abi?: any } | undefined>) => {
    const result = await singleThreadDeserializer.deserialize(param);

    return port.postMessage(result);
});
