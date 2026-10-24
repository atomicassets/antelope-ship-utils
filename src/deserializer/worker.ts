import { workerData } from 'node:worker_threads';
import { SingleThreadDeserializer } from './singlethread-deserializer';

const args: { abi: any } = workerData;

// Initialize the SHIP ABI once per worker, then reuse the existing row decoder.
const singleThreadDeserializer = new SingleThreadDeserializer(args.abi);

export default function deserialize(
    param: Parameters<SingleThreadDeserializer['deserialize']>[0],
): ReturnType<SingleThreadDeserializer['deserialize']> {
    return singleThreadDeserializer.deserialize(param);
}
