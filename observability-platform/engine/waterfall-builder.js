/**
 * Reconstructs a mathematically accurate span waterfall for a trace.
 * Adheres to Section 5 & 6 (Waterfall Precision):
 * - Preserves temporal ordering.
 * - Preserves exact parent-child IDs.
 * - Never fabricates missing parents (flags them explicitly as missing).
 * - Preserves overlap, parallelism, and timing gaps.
 */

export function buildTraceWaterfall(trace, spans) {
  if (!spans || spans.length === 0) {
    return {
      traceId: trace.traceId,
      root: null,
      spans: [],
      displayList: [],
      traceStartTime: trace.timestamp || 0,
      traceEndTime: trace.timestamp || 0,
      totalDuration: trace.totalDuration || 0,
      missingParents: [],
      orphanSpans: []
    };
  }

  // 1. Calculate time boundaries
  let traceStartTime = Infinity;
  let traceEndTime = -Infinity;

  for (const s of spans) {
    if (s.startTime != null && s.startTime < traceStartTime) {
      traceStartTime = s.startTime;
    }
    const end = s.endTime ?? (s.startTime != null && s.duration != null ? s.startTime + s.duration : null);
    if (end != null && end > traceEndTime) {
      traceEndTime = end;
    }
  }

  if (traceStartTime === Infinity) traceStartTime = trace.timestamp || 0;
  if (traceEndTime === -Infinity || traceEndTime < traceStartTime) {
    traceEndTime = traceStartTime + (trace.totalDuration || 0);
  }

  const totalDuration = Math.max(traceEndTime - traceStartTime, trace.totalDuration || 0, 0.001);

  // 2. Index spans by spanId
  const spanMap = new Map();
  for (const s of spans) {
    spanMap.set(s.spanId, {
      ...s,
      children: [],
      offsetMs: s.startTime != null ? Math.max(0, s.startTime - traceStartTime) : 0,
      offsetPercent: s.startTime != null ? Math.max(0, ((s.startTime - traceStartTime) / totalDuration) * 100) : 0,
      durationPercent: s.duration != null ? Math.max(0.1, (s.duration / totalDuration) * 100) : 1,
      isMissingParent: false,
      isOrphan: false
    });
  }

  // 3. Reconstruct tree hierarchy
  const roots = [];
  const missingParents = [];
  const missingParentGroups = new Map(); // missingParentId -> [spans]

  // If trace.rootSpan is known, prioritize it as main root
  const rootSpanId = trace.rootSpan ? trace.rootSpan.spanId : null;

  for (const node of spanMap.values()) {
    if (node.parentSpanId) {
      if (spanMap.has(node.parentSpanId)) {
        spanMap.get(node.parentSpanId).children.push(node);
      } else {
        // Parent ID is referenced but does not exist in dataset!
        node.isMissingParent = true;
        if (!missingParentGroups.has(node.parentSpanId)) {
          missingParentGroups.set(node.parentSpanId, []);
        }
        missingParentGroups.get(node.parentSpanId).push(node);
        missingParents.push({
          spanId: node.spanId,
          missingParentId: node.parentSpanId,
          spanName: node.name
        });
      }
    } else {
      roots.push(node);
    }
  }

  // Sort children by startTime
  for (const node of spanMap.values()) {
    node.children.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  }
  roots.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

  // If roots is empty but spans exist (e.g. cycle or all orphans), promote nodes
  if (roots.length === 0 && spanMap.size > 0) {
    for (const node of spanMap.values()) {
      roots.push(node);
      node.isOrphan = true;
    }
  }

  // Create virtual placeholder nodes for missing parents so they are explicitly visible in the hierarchy
  const missingParentNodes = [];
  for (const [missingParentId, childSpans] of missingParentGroups.entries()) {
    // Calculate earliest start and latest end of the orphan cluster
    let clusterStart = Infinity;
    let clusterEnd = -Infinity;
    for (const c of childSpans) {
      if (c.startTime != null && c.startTime < clusterStart) clusterStart = c.startTime;
      const end = c.endTime ?? (c.startTime != null ? c.startTime + (c.duration || 0) : null);
      if (end != null && end > clusterEnd) clusterEnd = end;
    }
    const clusterDur = Math.max(0, clusterEnd - clusterStart);

    const virtualMissingNode = {
      spanId: `missing-${missingParentId}`,
      originalMissingId: missingParentId,
      name: `Missing parent span: ${missingParentId}`,
      kind: 'unknown',
      status: 'missing_parent',
      statusMessage: `Referenced by ${childSpans.length} child spans, but was dropped or never closed by SDK instrumentation`,
      startTime: clusterStart !== Infinity ? clusterStart : traceStartTime,
      endTime: clusterEnd !== -Infinity ? clusterEnd : traceEndTime,
      duration: clusterDur,
      offsetMs: clusterStart !== Infinity ? Math.max(0, clusterStart - traceStartTime) : 0,
      offsetPercent: clusterStart !== Infinity ? Math.max(0, ((clusterStart - traceStartTime) / totalDuration) * 100) : 0,
      durationPercent: clusterDur > 0 ? Math.max(0.1, (clusterDur / totalDuration) * 100) : 1,
      attributes: {
        'error.type': 'MissingParentSpan',
        'diagnostic.reason': 'Parent span ID referenced in telemetry but absent in event stream',
        'missing.parent_id': missingParentId,
        'children.count': childSpans.length
      },
      events: [],
      children: childSpans,
      isVirtualMissingParent: true,
      isMissingParent: false,
      isOrphan: true
    };
    missingParentNodes.push(virtualMissingNode);
  }

  // Combine roots + missing parent clusters
  const finalRoots = [...roots, ...missingParentNodes];

  // 4. Flatten tree for tabular / timeline display with depth markers
  const displayList = [];

  function flatten(node, depth = 0, pathPrefix = '') {
    const rowId = `${pathPrefix}${node.spanId}`;
    displayList.push({
      ...node,
      displayDepth: depth,
      rowId,
      hasChildren: node.children.length > 0
    });
    for (let i = 0; i < node.children.length; i++) {
      flatten(node.children[i], depth + 1, `${rowId}/`);
    }
  }

  for (const root of finalRoots) {
    flatten(root, 0, '');
  }

  return {
    traceId: trace.traceId,
    roots: finalRoots,
    displayList,
    traceStartTime,
    traceEndTime,
    totalDuration,
    missingParents,
    missingParentNodesCount: missingParentNodes.length,
    spanCount: spans.length
  };
}
