import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCubicleData } from '../engine/loader.js';
import { correlateTelemetry } from '../engine/correlator.js';
import { buildTraceWaterfall } from '../engine/waterfall-builder.js';
import { runDiagnostics } from '../engine/diagnostics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cubicleDir = path.resolve(__dirname, '../../cubicle');

test('Reconstruction Engine Test Suite', async (t) => {
  let loaded;
  let correlated;

  await t.test('Phase 1: Ingests all cubicle files without data loss', () => {
    loaded = loadCubicleData(cubicleDir);
    assert.equal(loaded.metadata.counts.totalFiles, 4219, 'Must ingest all 4,219 raw files');
    assert.equal(loaded.metadata.counts.corruptedFiles, 0, 'Zero corrupted files');
    assert.equal(loaded.requests.length, 16, 'Exactly 16 request files');
    assert.equal(loaded.errors.length, 3, 'Exactly 3 error files');
    assert.equal(loaded.logs.length, 2, 'Exactly 2 log files');
    assert.equal(loaded.init.length, 3, 'Exactly 3 init files');
    assert.equal(loaded.spans.length, 2106, 'Exactly 2,106 span files in spans folder');
    assert.equal(loaded.traces.length, 1836, 'Exactly 1,836 trace files in traces folder');
    assert.equal(loaded.raw_batches.length, 253, 'Exactly 253 batch files');
  });

  await t.test('Phase 2 & 3: Correlation and Canonical Data Model', () => {
    correlated = correlateTelemetry(loaded);
    assert.equal(correlated.requests.length, 16, '16 normalized requests');
    assert.equal(correlated.spans.length, 2107, '2,107 unique spans (2106 in spans folder + 1 embedded-only OrganizationInvite.updateMany)');
    assert.equal(correlated.traces.length, 1778, '1,778 distinct traces');
    assert.equal(correlated.errors.length, 3, '3 normalized errors');
    assert.equal(correlated.logs.length, 2, '2 normalized logs');
  });

  await t.test('Phase 4: Missing Parent Span Detection', () => {
    // Trace e1150d3ab63d19892bdd2c731a5ef0e9 has 3 Prisma spans pointing to missing parent 51b55868fbb7c3de
    const signinTrace = correlated.indexes.traceIndex.get('e1150d3ab63d19892bdd2c731a5ef0e9');
    assert.ok(signinTrace, 'Signin trace exists');
    assert.equal(signinTrace.waterfall.missingParents.length, 3, 'Detects exactly 3 spans with missing parent');
    assert.equal(signinTrace.waterfall.missingParentNodesCount, 1, 'Creates 1 virtual missing parent container');
    
    const virtualNode = signinTrace.waterfall.roots.find(r => r.isVirtualMissingParent);
    assert.ok(virtualNode, 'Virtual missing parent node present in roots');
    assert.equal(virtualNode.originalMissingId, '51b55868fbb7c3de');
    assert.equal(virtualNode.children.length, 3, 'Virtual node holds the 3 orphan spans');
  });

  await t.test('Phase 5: Multi-Span Trace Waterfall Hierarchy & Timing', () => {
    // Check signin trace (POST /api/auth/signin) with 44 spans
    const signinTrace = correlated.indexes.traceIndex.get('e1150d3ab63d19892bdd2c731a5ef0e9');
    assert.equal(signinTrace.spans.length, 44, 'Signin trace contains 44 spans');
    assert.ok(signinTrace.computedDuration > 14000, 'Duration reflects true execution (>14s)');
    
    // Check root span
    const root = signinTrace.waterfall.roots.find(r => !r.isVirtualMissingParent);
    assert.equal(root.name, 'POST /api/auth/signin');
    assert.equal(root.kind, 'server');
    assert.ok(root.children.length >= 15, 'Root span has direct middleware and handler children');

    // Temporal ordering check: each child start >= parent start
    function verifyOrdering(node) {
      for (const child of node.children) {
        if (child.startTime != null && node.startTime != null) {
          assert.ok(child.startTime >= node.startTime, `Child ${child.name} start (${child.startTime}) should be >= parent ${node.name} start (${node.startTime})`);
        }
        verifyOrdering(child);
      }
    }
    verifyOrdering(root);
  });

  await t.test('Phase 6: Request -> Trace -> Span -> Error -> Log Correlation', () => {
    // Request 1: POST /api/auth/refresh (requestId: 34bab098-f82c-46f0-969b-cc922c7d123b)
    const reqRefresh = correlated.indexes.requestIndex.get('34bab098-f82c-46f0-969b-cc922c7d123b');
    assert.ok(reqRefresh, 'Request exists in index');
    assert.equal(reqRefresh.traceId, '67bd5f53d33bb8e04d743dc4f9170ada');
    assert.ok(reqRefresh.correlatedTrace, 'Correlates to trace');
    assert.equal(reqRefresh.correlatedErrors.length, 1, 'Correlates to 1 SSL warning error');
    assert.equal(reqRefresh.correlatedLogs.length, 1, 'Correlates to 1 log');

    // Request 2: GET /api/me/permissions (requestId: ea69a58c-20df-49ef-9100-97c96abef0e2)
    const reqPerm = correlated.indexes.requestIndex.get('ea69a58c-20df-49ef-9100-97c96abef0e2');
    assert.ok(reqPerm, 'Permissions request exists');
    assert.equal(reqPerm.traceId, '22486473cb44baca65b80386a643e7e8');
    
    // Trace has fatal error
    const permTrace = correlated.indexes.traceIndex.get('22486473cb44baca65b80386a643e7e8');
    assert.ok(permTrace.hasError, 'Trace flagged as having error');
    assert.equal(permTrace.errors.length, 1, '1 fatal error on trace');
    assert.equal(permTrace.errors[0].name, 'TypeError');
    assert.equal(permTrace.errors[0].spanId, 'bd98d8a4e6c85ea8');
  });

  await t.test('Phase 7: Database Telemetry Extraction', () => {
    assert.equal(correlated.databases.length, 1814, 'Exactly 1,814 database operations captured');
    const mongoOps = correlated.databases.filter(d => d.system === 'mongodb');
    const pgOps = correlated.databases.filter(d => d.system === 'postgresql');
    const prismaOps = correlated.databases.filter(d => d.system === 'prisma');
    assert.equal(mongoOps.length, 1794, '1,794 MongoDB operations');
    assert.equal(pgOps.length, 8, '8 PostgreSQL operations');
    assert.equal(prismaOps.length, 12, '12 Prisma operations');
  });

  await t.test('Phase 8: Forensic Diagnostics Integrity Checks', () => {
    const diag = runDiagnostics(correlated, loaded);
    assert.equal(diag.findings.timingViolations.length, 0, 'No negative durations or inverted timestamps');
    assert.equal(diag.findings.uncorrelatedEntities.length, 0, 'Zero uncorrelated errors or logs');
    assert.equal(diag.findings.missingParents.length, 3, 'Identified all 3 missing parents');
    assert.equal(diag.findings.duplicateBatches.length, 58, 'Identified 58 duplicate trace files (1836 - 1778)');
  });

  await t.test('Phase 9: Edge Cases (Synthetic Unit Checks)', () => {
    // Test synthetic orphan span waterfall
    const syntheticTrace = { traceId: 'synthetic_01', timestamp: 1000, totalDuration: 50 };
    const syntheticSpans = [
      { spanId: 's1', traceId: 'synthetic_01', parentSpanId: 'missing_p1', name: 'orphan_child', startTime: 1010, endTime: 1030, duration: 20 },
      { spanId: 's2', traceId: 'synthetic_01', parentSpanId: null, name: 'independent_root', startTime: 1000, endTime: 1050, duration: 50 }
    ];
    const wf = buildTraceWaterfall(syntheticTrace, syntheticSpans);
    assert.equal(wf.roots.length, 2, 'Has 1 genuine root + 1 virtual missing parent root');
    assert.equal(wf.displayList.length, 3, 'Display list contains 3 rows (independent_root, missing_parent, orphan_child)');
  });
});
