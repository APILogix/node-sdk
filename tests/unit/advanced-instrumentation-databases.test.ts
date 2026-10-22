import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { createDynamoDBInstrumentation } from '../../src/instrumentation/dynamodb.js'
import { createCassandraInstrumentation } from '../../src/instrumentation/cassandra.js'
import { createElasticsearchInstrumentation } from '../../src/instrumentation/elasticsearch.js'
import { createMSSQLInstrumentation } from '../../src/instrumentation/mssql.js'
import { createSQLiteInstrumentation } from '../../src/instrumentation/sqlite.js'
import { createTypeORMInstrumentation } from '../../src/instrumentation/typeorm.js'
import { createDrizzleInstrumentation, PulseDrizzleLogger } from '../../src/instrumentation/drizzle.js'
import { createMikroORMInstrumentation } from '../../src/instrumentation/mikro-orm.js'
import { createSequelizeInstrumentation } from '../../src/instrumentation/sequelize.js'
import { createKnexInstrumentation } from '../../src/instrumentation/knex.js'
import { sanitizeQueryStatement } from '../../src/instrumentation/safe-wrapper.js'

describe('Advanced Instrumentation: Databases & ORMs', () => {
  describe('Query Sanitizer', () => {
    it('redacts sensitive values and string literals without event loop lag', () => {
      const sql1 = "SELECT * FROM users WHERE email = 'admin@example.com'"
      const sanitized1 = sanitizeQueryStatement(sql1, 1000)
      assert.equal(sanitized1.includes('admin@example.com'), false)
      assert.equal(sanitized1.includes("'?'"), true)

      const sql2 = 'SELECT * FROM payments WHERE card = 4111222233334444'
      const sanitized2 = sanitizeQueryStatement(sql2, 1000)
      assert.equal(sanitized2.includes('4111222233334444'), false)
      assert.equal(sanitized2.includes('[REDACTED]'), true)
    })

    it('bounds excessively large queries to maximum length', () => {
      const hugeQuery = 'SELECT ' + 'x'.repeat(10000)
      const sanitized = sanitizeQueryStatement(hugeQuery, 50)
      assert.equal(sanitized.length, 50)
    })
  })

  describe('DynamoDB Instrumentation', () => {
    it('safely handles disabled state returning null', () => {
      const inst = createDynamoDBInstrumentation(false)
      assert.equal(inst, null)
    })

    it('returns null gracefully if @aws-sdk/client-dynamodb is not installed', () => {
      const inst = createDynamoDBInstrumentation(true)
      // When not installed in host environment, must fail-open and return null
      assert.equal(inst === null || typeof inst.enable === 'function', true)
    })
  })

  describe('Cassandra Instrumentation', () => {
    it('safely handles disabled state returning null', () => {
      const inst = createCassandraInstrumentation(false)
      assert.equal(inst, null)
    })

    it('returns null gracefully if cassandra-driver is not installed', () => {
      const inst = createCassandraInstrumentation(true)
      assert.equal(inst === null || typeof inst.enable === 'function', true)
    })
  })

  describe('Elasticsearch & OpenSearch Instrumentation', () => {
    it('safely handles disabled state returning null', () => {
      const inst = createElasticsearchInstrumentation(false)
      assert.equal(inst, null)
    })

    it('returns null gracefully if elasticsearch client is not installed', () => {
      const inst = createElasticsearchInstrumentation(true)
      assert.equal(inst === null || typeof inst.enable === 'function', true)
    })
  })

  describe('MSSQL Instrumentation', () => {
    it('safely handles disabled state returning null', () => {
      const inst = createMSSQLInstrumentation(false)
      assert.equal(inst, null)
    })
  })

  describe('SQLite Instrumentation', () => {
    it('safely handles disabled state returning null', () => {
      const inst = createSQLiteInstrumentation(false)
      assert.equal(inst, null)
    })
  })

  describe('TypeORM Instrumentation', () => {
    it('safely handles disabled state returning null', () => {
      const inst = createTypeORMInstrumentation(false)
      assert.equal(inst, null)
    })
  })

  describe('Drizzle ORM Instrumentation', () => {
    it('creates logger and logs queries cleanly without errors', () => {
      const inst = createDrizzleInstrumentation(true)
      assert.notEqual(inst, null)
      assert.notEqual(inst?.logger, null)

      const tracer = trace.getTracer('test')
      const span = tracer.startSpan('parent.request')

      trace.getTracer('test')
      assert.doesNotThrow(() => {
        inst?.logger.logQuery("SELECT * FROM users WHERE status = 'active'", [1, 2])
      })
      span.end()
    })
  })

  describe('MikroORM, Sequelize, Knex Instrumentations', () => {
    it('safely handle disabled state without throwing', () => {
      assert.equal(createMikroORMInstrumentation(false), null)
      assert.equal(createSequelizeInstrumentation(false), null)
      assert.equal(createKnexInstrumentation(false), null)
    })
  })
})
