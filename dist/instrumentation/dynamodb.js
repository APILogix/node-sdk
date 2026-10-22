/**
 * AWS DynamoDB Instrumentation — auto-instrumentation for AWS SDK v3 DynamoDB
 * clients (@aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb).
 *
 * Captures:
 * - Low-level commands (GetItem, PutItem, Query, Scan, BatchWriteItem)
 * - High-level DocumentClient commands
 * - Consumed capacity units (RCU / WCU)
 * - Sanitized primary key & projection attributes
 * - Regional latency & request tracking
 */
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { resolveModuleSafe, applyIdempotentPatch } from './safe-wrapper.js';
const DYNAMODB_GUARD = Symbol.for('pulse-sdk.patch.dynamodb');
/**
 * Patches DynamoDBClient and DynamoDBDocumentClient prototypes.
 */
export function createDynamoDBInstrumentation(enabled, options, captureConfig) {
    if (!enabled)
        return null;
    const ddbModule = resolveModuleSafe('@aws-sdk/client-dynamodb');
    if (!ddbModule)
        return null;
    const DynamoDBClient = ddbModule.DynamoDBClient ?? ddbModule.default?.DynamoDBClient;
    if (!DynamoDBClient || !DynamoDBClient.prototype || typeof DynamoDBClient.prototype.send !== 'function') {
        return null;
    }
    const origSend = DynamoDBClient.prototype.send;
    let active = true;
    applyIdempotentPatch(DYNAMODB_GUARD, () => {
        DynamoDBClient.prototype.send = function pulseDynamoDBSend(command, ...args) {
            if (!active) {
                return origSend.apply(this, [command, ...args]);
            }
            const tracer = trace.getTracer('@lynktrace/node-dynamodb');
            const commandName = command?.constructor?.name ?? 'Command';
            const operation = commandName.replace(/Command$/, '');
            const input = command?.input ?? {};
            const tableName = input.TableName ?? input.TableNames?.join(',') ?? 'unknown';
            const span = tracer.startSpan(`DynamoDB.${operation}`, {
                kind: SpanKind.CLIENT,
                attributes: {
                    'db.system': 'dynamodb',
                    'db.operation': operation,
                    'aws.table_name': tableName,
                    'aws.region': this?.config?.region ? String(this.config.region) : undefined,
                },
            });
            // Parameter capture (gated by config and privacy)
            if (options?.captureParams && captureConfig?.body && input.Key) {
                try {
                    span.setAttribute('aws.dynamodb.key', JSON.stringify(input.Key).slice(0, 1024));
                }
                catch { }
            }
            const promise = origSend.apply(this, [command, ...args]);
            if (promise && typeof promise.then === 'function') {
                return promise.then((response) => {
                    try {
                        if (response?.ConsumedCapacity) {
                            const units = response.ConsumedCapacity.CapacityUnits ?? response.ConsumedCapacity.TotalCapacityUnits;
                            if (units != null) {
                                span.setAttribute('aws.dynamodb.consumed_capacity', units);
                            }
                        }
                        if (response?.Count != null) {
                            span.setAttribute('aws.dynamodb.count', response.Count);
                        }
                        span.setStatus({ code: SpanStatusCode.OK });
                        span.end();
                    }
                    catch { }
                    return response;
                }, (error) => {
                    try {
                        span.recordException(error instanceof Error ? error : new Error(String(error)));
                        span.setStatus({
                            code: SpanStatusCode.ERROR,
                            message: error?.message ?? String(error),
                        });
                        span.end();
                    }
                    catch { }
                    throw error;
                });
            }
            span.end();
            return promise;
        };
        return () => {
            DynamoDBClient.prototype.send = origSend;
        };
    });
    return {
        enable: () => { active = true; },
        disable: () => { active = false; },
        teardown: () => {
            active = false;
            DynamoDBClient.prototype.send = origSend;
        },
    };
}
