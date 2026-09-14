import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads all raw telemetry files from the cubicle folder.
 * Preserves exact file paths, sizes, timestamps, and payload contents.
 */
export function loadCubicleData(cubicleDir) {
  const result = {
    metadata: {
      cubicleDir,
      loadedAt: new Date().toISOString(),
      counts: {
        init: 0,
        requests: 0,
        errors: 0,
        logs: 0,
        spans: 0,
        traces: 0,
        raw_batches: 0,
        totalFiles: 0,
        corruptedFiles: 0
      }
    },
    init: [],
    requests: [],
    errors: [],
    logs: [],
    spans: [],
    traces: [],
    raw_batches: [],
    rawEventsMap: new Map() // eventId/traceId/file -> raw event with provenance
  };

  const categories = ['init', 'requests', 'errors', 'logs', 'spans', 'traces', 'raw_batches'];

  for (const cat of categories) {
    const dirPath = path.join(cubicleDir, cat);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath);
    result.metadata.counts[cat] = files.length;
    result.metadata.counts.totalFiles += files.length;

    for (const filename of files) {
      const fullPath = path.join(dirPath, filename);
      const relPath = path.posix.join('cubicle', cat, filename);
      try {
        const stat = fs.statSync(fullPath);
        const rawContent = fs.readFileSync(fullPath, 'utf8');
        const parsed = JSON.parse(rawContent);

        const record = {
          _provenance: {
            category: cat,
            filename,
            relativePath: relPath,
            sizeBytes: stat.size,
            mtime: stat.mtime.toISOString()
          },
          data: parsed
        };

        result[cat].push(record);

        // Index in rawEventsMap
        const eventId = parsed.eventId;
        if (eventId) {
          result.rawEventsMap.set(eventId, record);
        }
      } catch (err) {
        result.metadata.counts.corruptedFiles++;
        console.error(`[Loader] Failed to read ${relPath}:`, err.message);
      }
    }
  }

  return result;
}
