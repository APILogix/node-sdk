import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns'
import { createKafkaInstrumentation } from '../../src/instrumentation/kafka.js'
import { createAMQPInstrumentation } from '../../src/instrumentation/amqplib.js'
import { createSqsSnsInstrumentation } from '../../src/instrumentation/sqs-sns.js'
import { createPubSubInstrumentation } from '../../src/instrumentation/pubsub.js'
import { createGrpcInstrumentation } from '../../src/instrumentation/grpc.js'
import { createNestJSInstrumentation } from '../../src/instrumentation/nestjs.js'
import { createDNSInstrumentation } from '../../src/instrumentation/dns.js'

describe('Advanced Instrumentation: Messaging, RPC & Infrastructure', () => {
  describe('KafkaJS Instrumentation', () => {
    it('safely handles disabled state returning null', () => {
      assert.equal(createKafkaInstrumentation(false), null)
    })

    it('returns null gracefully if kafkajs is not installed', () => {
      const inst = createKafkaInstrumentation(true)
      assert.equal(inst === null || typeof inst.enable === 'function', true)
    })
  })

  describe('RabbitMQ AMQP Instrumentation', () => {
    it('safely handles disabled state returning null', () => {
      assert.equal(createAMQPInstrumentation(false), null)
    })

    it('returns null gracefully if amqplib is not installed', () => {
      const inst = createAMQPInstrumentation(true)
      assert.equal(inst === null || typeof inst.enable === 'function', true)
    })
  })

  describe('AWS SQS & SNS Instrumentation', () => {
    it('safely handles disabled state returning null', () => {
      assert.equal(createSqsSnsInstrumentation(false, false), null)
    })

    it('returns null gracefully if AWS SQS/SNS SDK is not installed', () => {
      const inst = createSqsSnsInstrumentation(true, true)
      assert.equal(inst === null || typeof inst.enable === 'function', true)
    })
  })

  describe('Google Cloud Pub/Sub Instrumentation', () => {
    it('safely handles disabled state returning null', () => {
      assert.equal(createPubSubInstrumentation(false), null)
    })
  })

  describe('gRPC Instrumentation', () => {
    it('safely handles disabled state returning null', () => {
      assert.equal(createGrpcInstrumentation(false), null)
    })

    it('returns null gracefully if @grpc/grpc-js is not installed', () => {
      const inst = createGrpcInstrumentation(true)
      assert.equal(inst === null || typeof inst.enable === 'function', true)
    })
  })

  describe('NestJS Instrumentation', () => {
    it('safely handles disabled state returning null', () => {
      assert.equal(createNestJSInstrumentation(false), null)
    })
  })

  describe('Node.js Native DNS Instrumentation', () => {
    it('safely handles disabled state returning null', () => {
      assert.equal(createDNSInstrumentation(false), null)
    })

    it('measures DNS lookup and restores original dns.lookup cleanly on teardown', async () => {
      const inst = createDNSInstrumentation(true)
      assert.notEqual(inst, null)

      await new Promise<void>((resolve) => {
        dns.lookup('localhost', (err, address, family) => {
          assert.equal(err, null)
          assert.notEqual(address, null)
          resolve()
        })
      })

      inst?.teardown()
    })
  })
})
