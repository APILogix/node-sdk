# SDK Import And Bootstrap Guide

This guide is the recommended startup contract for applications using `@pulse-apm/node`.

Auto-instrumentation in Node.js is load-order sensitive. Import Pulse before application frameworks, database clients, cache clients, queue libraries, GraphQL, Axios, Undici, and other modules you expect the SDK to patch. The root package import installs privacy-safe OpenTelemetry module-load hooks synchronously. `createSDK()` remains the async initialization boundary that fetches remote config, enables transport, applies privacy policy, and rebuilds instrumentation from backend policy.

## Recommended Method

The recommended method is:

1. Import `@pulse-apm/node` as the first application import.
2. Call and await `createSDK()` during startup.
3. Import or construct frameworks, routers, DB clients, cache clients, queue clients, and HTTP clients only after the Pulse import has run.
4. Start serving traffic only after `createSDK()` settles when startup telemetry matters.

Use `node --import @pulse-apm/node/register` only when you cannot control import order because a framework CLI, bundler, or generated wrapper loads your application modules first.

## Standard Applications

Use this shape when you control the application entrypoint:

```ts
import { createSDK } from '@pulse-apm/node'
import express from 'express'
import { Pool } from 'pg'

const sdkConfig = await createSDK({
    apiKey: process.env.PULSE_API_KEY!
})

if (!sdkConfig) {
    // Telemetry failed open. Start the application anyway or apply your own
    // operational policy.
}

const app = express()
const pool = new Pool()

app.get('/orgs', async (_req, res) => {
    const [org, members] = await Promise.all([pool.query('select * from orgs limit 1'), pool.query('select * from members limit 10')])

    const audit = await pool.query('select now()')
    res.json({ org: org.rows[0], members: members.rows, audit: audit.rows[0] })
})
```

Key rules:

- Put the Pulse import first in the entrypoint.
- Call `createSDK()` during startup before serving traffic.
- Do not wait to import Pulse until after Express, Fastify, PostgreSQL, MySQL2, MongoDB, Redis, Prisma, BullMQ, GraphQL, Axios, Undici, or HTTP clients are already loaded.
- Treat a returned `undefined` config as telemetry unavailable; the SDK fails open and does not invent fallback telemetry policy.

## Apps Without Convenient Top-Level Await

If top-level `await` is awkward, still import Pulse first and start initialization before composing the rest of the app:

```ts
import { createSDK } from '@pulse-apm/node'
import express from 'express'
import { Pool } from 'pg'

const sdkReady = createSDK({ apiKey: process.env.PULSE_API_KEY! })

const app = express()
const pool = new Pool()

await sdkReady

app.listen(3000)
```

The import installs the early hooks. The `createSDK()` promise enables export, privacy policy, sampling, transport, and remote instrumentation policy. Do not serve traffic until it settles if you require telemetry for startup requests.

## Framework CLIs, Bundlers, And Generated Startup

Use the register entrypoint when a framework or generated wrapper imports application modules before your code can run:

```bash
node --import @pulse-apm/node/register server.js
```

Then keep using the normal SDK API in application code:

```ts
import { createSDK, withSpan, withDbSpan } from '@pulse-apm/node'

await createSDK({ apiKey: process.env.PULSE_API_KEY! })
```

The register entrypoint:

- imports the same bootstrap implementation as the root package;
- shares the same process-global guards as `import '@pulse-apm/node'`;
- does not require an API key;
- does not call `/v1/init`;
- does not enable transport or send telemetry;
- does not replace the normal SDK API.

## Manual Spans And Fallback DB Spans

Manual spans and auto-instrumented spans use the same OpenTelemetry context. Use `withSpan()` when child work should nest under a business operation, and use `withDbSpan()` or `startDbSpan()` for unsupported clients or for libraries that were loaded too early to patch.

```ts
import { withSpan, withDbSpan } from '@pulse-apm/node'

await withSpan('org.create', async (span) => {
    span.setAttribute('org.plan', 'enterprise')

    await withDbSpan(
        {
            system: 'postgresql',
            operation: 'INSERT',
            table: 'billing_accounts'
        },
        async () => {
            await createBillingAccount()
        }
    )
})
```

If a custom scheduler or unsupported async boundary drops context, capture the current span and pass it as an explicit parent:

```ts
import { getActiveSpan, withDbSpan } from '@pulse-apm/node'

const parent = getActiveSpan()

queueMicrotask(() => {
    void withDbSpan(
        {
            system: 'postgresql',
            operation: 'SELECT',
            table: 'accounts',
            parent: parent ?? undefined
        },
        async () => {
            await loadAccounts()
        }
    )
})
```

## Privacy And Transport Boundaries

Before `createSDK()` succeeds, bootstrap hooks are conservative:

- no API key is read;
- no `/v1/init` request is made by the bootstrap itself;
- no telemetry is exported;
- request headers, query strings, bodies, cookies, and DB parameters are not intentionally captured by bootstrap policy;
- profiling, runtime metrics, cron monitoring, replay, and automatic error/log capture are not started by bootstrap alone.

After `createSDK()` succeeds, the validated remote snapshot is authoritative for instrumentation selection, sampling, privacy capture, scrubbing, killswitches, entitlements, limits, and transport routes.

## Hard Boundary

Pulse cannot reliably patch modules that were already loaded before the Pulse bootstrap ran:

```ts
import { Pool } from 'pg'
import { createSDK } from '@pulse-apm/node'
```

If the target library is already in Node's module cache, complete auto-instrumentation cannot be guaranteed across all library versions. Move the Pulse import earlier or use `node --import @pulse-apm/node/register`.
