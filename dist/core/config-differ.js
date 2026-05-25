/**
 * ConfigDiffer — deep-diff utility for RemoteConfigResponse objects.
 *
 * The refresh loop calls this on every successful fetch so subsystems can
 * decide whether to react. Cheap by design: a structural equality check
 * per top-level section, not a per-field traversal of the full tree.
 */
/**
 * Diff two remote config snapshots. Returns which top-level sections
 * changed and a flat map of field-level changes for diagnostic logging.
 */
export function diffConfigs(oldConfig, newConfig) {
    const changes = new Map();
    const featuresChanged = !deepEqual(oldConfig.features, newConfig.features);
    const killswitchesChanged = !deepEqual(oldConfig.killswitches, newConfig.killswitches);
    const samplingChanged = !deepEqual(oldConfig.sampling, newConfig.sampling);
    const transportChanged = !deepEqual(oldConfig.transport, newConfig.transport);
    const privacyChanged = !deepEqual(oldConfig.privacy, newConfig.privacy);
    const limitsChanged = !deepEqual(oldConfig.limits, newConfig.limits);
    const instrumentationChanged = !deepEqual(oldConfig.instrumentation, newConfig.instrumentation);
    const runtimeChanged = !deepEqual(oldConfig.runtime, newConfig.runtime);
    if (featuresChanged)
        collectChanges('features', oldConfig.features, newConfig.features, changes);
    if (killswitchesChanged)
        collectChanges('killswitches', oldConfig.killswitches, newConfig.killswitches, changes);
    if (samplingChanged)
        collectChanges('sampling', oldConfig.sampling, newConfig.sampling, changes);
    if (transportChanged)
        changes.set('transport', { old: '[complex]', new: '[complex]' });
    if (privacyChanged)
        changes.set('privacy', { old: '[complex]', new: '[complex]' });
    if (limitsChanged)
        collectChanges('limits', oldConfig.limits, newConfig.limits, changes);
    if (instrumentationChanged)
        changes.set('instrumentation', { old: '[complex]', new: '[complex]' });
    if (runtimeChanged)
        collectChanges('runtime', oldConfig.runtime, newConfig.runtime, changes);
    return {
        featuresChanged,
        killswitchesChanged,
        samplingChanged,
        transportChanged,
        privacyChanged,
        limitsChanged,
        instrumentationChanged,
        runtimeChanged,
        changes,
    };
}
function deepEqual(a, b) {
    if (a === b)
        return true;
    if (a === null || b === null)
        return false;
    if (typeof a !== typeof b)
        return false;
    if (typeof a !== 'object')
        return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length)
            return false;
        return a.every((val, idx) => deepEqual(val, b[idx]));
    }
    if (Array.isArray(a) !== Array.isArray(b))
        return false;
    const aObj = a;
    const bObj = b;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length)
        return false;
    return aKeys.every(key => deepEqual(aObj[key], bObj[key]));
}
function collectChanges(prefix, oldVal, newVal, changes) {
    if (typeof oldVal !== 'object' || typeof newVal !== 'object' || oldVal === null || newVal === null) {
        changes.set(prefix, { old: oldVal, new: newVal });
        return;
    }
    const oldObj = oldVal;
    const newObj = newVal;
    const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
    for (const key of allKeys) {
        if (!deepEqual(oldObj[key], newObj[key])) {
            changes.set(`${prefix}.${key}`, { old: oldObj[key], new: newObj[key] });
        }
    }
}
//# sourceMappingURL=config-differ.js.map