export interface IRedisConfig {
    port: number;
    host: string;
    global_prefix: string;
    db?: number;
}
