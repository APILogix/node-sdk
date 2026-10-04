# Initialization Shutdown & Race Safety

## 1. The Startup-Shutdown Race

In containerized environments (Kubernetes, AWS ECS), a container may receive a `SIGTERM` or immediate shutdown signal shortly after boot (e.g., rolling updates, failed health probes, or CLI script exits).

If `shutdown()` is called while `init()` is actively awaiting a slow `/v1/init` network request:
1. The network request must be cancelled immediately.
2. In-flight callbacks must not revive the SDK after shutdown.
3. The SDK must terminate cleanly without throwing `INVALID_STATE_TRANSITION`.

---

## 2. AbortController Cancellation

In [`src/core/remote-config-client.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/core/remote-config-client.ts), control-plane HTTP requests are wired to an internal `AbortController`:

```typescript
// Controlled cancellation in RemoteConfigClient
private abortController: AbortController = new AbortController();

public async post(endpoint: string, data: unknown): Promise<Response> {
  const signal = this.abortController.signal;
  return await fetch(url, {
    method: 'POST',
    headers: { ... },
    body: JSON.stringify(data),
    signal,
  });
}

public abort(): void {
  this.abortController.abort();
}
```

When `shutdown()` is called, `client.abortInFlight()` triggers `abort()`, causing the pending `fetch` to reject immediately with an `AbortError`.

---

## 3. Defense Against Zombie Resurrections

If a delayed control-plane response managed to resolve just as `shutdown()` completed, an unguarded implementation might attempt to initialize subsystems:

```typescript
// Guard implementation in src/core/init.ts
export async function initialize(options: NormalizedSDKOptions): Promise<RemoteConfigResponse | undefined> {
  // Check 1: Enter guard
  if (isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
    return undefined;
  }

  try {
    const config = await remoteConfigClient.initialize();
    
    // Check 2: Resolution guard
    if (isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
      return undefined;
    }
    
    // Subsystem activation only if still running
    await featureController.applyRemoteConfig(config);
    client.setState('initialized');
    return config;
  } catch (err) {
    // Check 3: Error catch guard
    if (isSDKShuttingDown() || client.getState() === 'stopping' || client.getState() === 'stopped') {
      return undefined;
    }
    client.setState('recovering');
    BackgroundRecoveryWorker.start();
    return undefined;
  }
}
```

### Safety Guarantees:
- **Shutdown Dominance:** Once `shutdown()` begins, state transitions to `'recovering'` or `'initialized'` are strictly blocked.
- **No Zombie Workers:** Recovery timers are never scheduled after shutdown has started.
- **Clean Exit:** No unhandled rejections or error events bubble up to the customer application.
