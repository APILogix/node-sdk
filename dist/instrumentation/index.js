/**
 * Instrumentation Module — exports all framework instrumentations
 */
export { registerAutoInstrumentations, resetAutoInstrumentations } from './auto-instrument.js';
export { lynktraceMiddleware, pulseMiddleware } from './express.js';
export { createGraphQLInstrumentation } from './graphql.js';
export { createPrismaInstrumentation, lynktracePrismaExtension, pulsePrismaExtension, instrumentPrismaClientInstance } from './prisma.js';
export { createMongoDBInstrumentation } from './mongodb.js';
export { createMongooseInstrumentation, MongooseInstrumentation, LynkTraceMongooseInstrumentation } from './mongoose.js';
export { createRedisInstrumentation, createIORedisInstrumentation, createRedisStatementSerializer } from './redis.js';
export { createBullMQInstrumentation } from './bullmq.js';
export { createAxiosInstrumentation } from './axios.js';
export { createNodemailerInstrumentation, NodemailerInstrumentation, LynkTraceNodemailerInstrumentation } from './nodemailer.js';
export { createDynamoDBInstrumentation } from './dynamodb.js';
export { createCassandraInstrumentation } from './cassandra.js';
export { createElasticsearchInstrumentation } from './elasticsearch.js';
export { createMSSQLInstrumentation } from './mssql.js';
export { createSQLiteInstrumentation } from './sqlite.js';
export { createTypeORMInstrumentation } from './typeorm.js';
export { createDrizzleInstrumentation, LynkTraceDrizzleLogger, PulseDrizzleLogger } from './drizzle.js';
export { createMikroORMInstrumentation } from './mikro-orm.js';
export { createSequelizeInstrumentation } from './sequelize.js';
export { createKnexInstrumentation } from './knex.js';
export { createKafkaInstrumentation } from './kafka.js';
export { createAMQPInstrumentation } from './amqplib.js';
export { createSqsSnsInstrumentation } from './sqs-sns.js';
export { createPubSubInstrumentation } from './pubsub.js';
export { createGrpcInstrumentation } from './grpc.js';
export { createNestJSInstrumentation } from './nestjs.js';
export { createDNSInstrumentation } from './dns.js';
export { resolveModuleSafe, applyIdempotentPatch, sanitizeQueryStatement, withSafeSpan } from './safe-wrapper.js';
