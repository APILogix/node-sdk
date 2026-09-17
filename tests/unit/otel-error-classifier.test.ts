import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isOtelInstrumentationError } from '../../src/instrumentation/http-lifecycle-guard.js'

describe('OTel Error Suppression & Precision Classification', () => {
  it('does NOT suppress genuine application TypeError inside HTTP callback accessing headers', () => {
    const err = new TypeError("Cannot read properties of null (reading 'headers')")
    err.stack = `TypeError: Cannot read properties of null (reading 'headers')
    at ClientRequest.<anonymous> (/app/src/controllers/payment.ts:42:15)
    at ClientRequest.emit (node:events:517:28)
    at HTTPParser.parserOnIncomingClient (node:_http_client:700:27)
    at HTTPParser.parserOnHeadersComplete (node:_http_common:119:17)
    at Socket.socketOnData (node:_http_client:540:22)
    at Socket.emit (node:events:517:28)
    at TCP.onStreamRead (node:net:350:12)`

    const result = isOtelInstrumentationError(err)
    assert.equal(result, false, 'Application TypeError must NOT be classified as OTel error')
  })

  it('does NOT suppress application TypeError accessing res property', () => {
    const err = new TypeError("Cannot read properties of null (reading 'res')")
    err.stack = `TypeError: Cannot read properties of null (reading 'res')
    at handleResponse (/app/src/services/checkout.ts:88:21)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`

    const result = isOtelInstrumentationError(err)
    assert.equal(result, false, 'Application accessing res must NOT be suppressed')
  })

  it('does NOT suppress application TypeError when OTel is in outer stack but throw site is app code', () => {
    const err = new TypeError("Cannot read properties of null (reading 'statusCode')")
    err.stack = `TypeError: Cannot read properties of null (reading 'statusCode')
    at myAppHandler (/app/src/index.ts:15:10)
    at ClientRequest.emit (node:events:517:28)
    at ClientRequest.emit (/app/node_modules/@opentelemetry/instrumentation-http/build/src/http.js:200:15)
    at Socket.emit (node:events:517:28)`

    const result = isOtelInstrumentationError(err)
    assert.equal(result, false, 'App error wrapped in OTel emitter must NOT be classified as OTel internal error')
  })

  it('does NOT suppress non-TypeError exceptions', () => {
    const err = new Error("Cannot read properties of null (reading 'headers')")
    err.stack = `Error: Cannot read properties of null (reading 'headers')
    at getIncomingRequestAttributes (/app/node_modules/@opentelemetry/instrumentation-http/build/src/utils.js:140:17)`

    const result = isOtelInstrumentationError(err)
    assert.equal(result, false, 'Non-TypeError must NOT be classified as OTel error')
  })

  it('does NOT suppress Node.js internal HTTP error without OTel instrumentation', () => {
    const err = new TypeError("Cannot read properties of null (reading 'socket')")
    err.stack = `TypeError: Cannot read properties of null (reading 'socket')
    at parserOnIncomingClient (node:_http_client:700:27)
    at Socket.socketOnData (node:_http_client:540:22)
    at Socket.emit (node:events:517:28)
    at TCP.onStreamRead (node:net:350:12)`

    const result = isOtelInstrumentationError(err)
    assert.equal(result, false, 'Node internal HTTP error without OTel must not be suppressed')
  })

  it('CORRECTLY classifies genuine OTel HTTP instrumentation race condition accessing res', () => {
    const err = new TypeError("Cannot read properties of null (reading 'res')")
    err.stack = `TypeError: Cannot read properties of null (reading 'res')
    at getIncomingRequestAttributes (/app/node_modules/@opentelemetry/instrumentation-http/build/src/utils.js:140:17)
    at ClientRequest.<anonymous> (/app/node_modules/@opentelemetry/instrumentation-http/build/src/http.js:312:25)
    at ClientRequest.emit (node:events:517:28)
    at Socket.socketCloseListener (node:_http_client:473:11)
    at Socket.emit (node:events:517:28)
    at TCP.<anonymous> (node:net:350:12)`

    const result = isOtelInstrumentationError(err)
    assert.equal(result, true, 'Genuine OTel race condition must be classified as OTel error')
  })

  it('CORRECTLY classifies genuine OTel HttpInstrumentation._closeHttpSpan accessing socket', () => {
    const err = new TypeError("Cannot read properties of null (reading 'socket')")
    err.stack = `TypeError: Cannot read properties of null (reading 'socket')
    at HttpInstrumentation._closeHttpSpan (/app/node_modules/@opentelemetry/instrumentation-http/build/src/http.js:450:20)
    at ClientRequest.emit (node:events:517:28)
    at Socket.socketCloseListener (node:_http_client:473:11)`

    const result = isOtelInstrumentationError(err)
    assert.equal(result, true, 'Genuine OTel span closing error must be classified as OTel error')
  })

  it('CORRECTLY classifies genuine OTel getOutgoingRequestAttributes accessing headers', () => {
    const err = new TypeError("Cannot read properties of null (reading 'headers')")
    err.stack = `TypeError: Cannot read properties of null (reading 'headers')
    at getOutgoingRequestAttributes (/app/node_modules/@opentelemetry/instrumentation-http/build/src/utils.js:210:14)
    at HttpInstrumentation._traceClientRequest (/app/node_modules/@opentelemetry/instrumentation-http/build/src/http.js:380:12)
    at ClientRequest.emit (node:events:517:28)`

    const result = isOtelInstrumentationError(err)
    assert.equal(result, true, 'Genuine OTel getOutgoingRequestAttributes error must be classified as OTel error')
  })
})
