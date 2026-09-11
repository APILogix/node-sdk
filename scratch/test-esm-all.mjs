import { register, supportsSyncHooks } from 'import-in-the-middle/register-hooks.mjs';
import { createPgInstrumentation } from '../dist/instrumentation/pg.js';
import { createRedisInstrumentation, createIORedisInstrumentation } from '../dist/instrumentation/redis.js';
import { createMongoDBInstrumentation } from '../dist/instrumentation/mongodb.js';
import { registerInstrumentations } from '@opentelemetry/instrumentation';

register();

const pgInst = createPgInstrumentation(true, { captureQueries: true }, { headers: false, body: false, response: false, query: false, cookies: false });
const redisInst = createRedisInstrumentation(true, {}, { headers: false, body: false, response: false, query: false, cookies: false });
const ioRedisInst = createIORedisInstrumentation(true, {}, { headers: false, body: false, response: false, query: false, cookies: false });
const mongoInst = createMongoDBInstrumentation(true, {}, { headers: false, body: false, response: false, query: false, cookies: false });

registerInstrumentations({
  instrumentations: [pgInst, redisInst, ioRedisInst, mongoInst],
});

const redis = await import('redis');
console.log('Redis module loaded:', !!redis);

const ioredis = await import('ioredis');
const RedisClient = ioredis.default || ioredis;
console.log('ioredis prototype sendCommand isWrapped:', !!RedisClient.prototype.sendCommand?.__wrapped);

const mongodb = await import('mongodb');
console.log('mongodb loaded:', !!mongodb);
