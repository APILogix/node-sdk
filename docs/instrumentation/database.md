# Database & Cache Instrumentation

## 1. Supported Database Systems

Pulse provides deep automatic instrumentation for the most popular Node.js database drivers and ORMs:

| Database / Driver | Module | Interception Mechanism |
|---|---|---|
| **PostgreSQL** (`pg`) | [`src/instrumentation/pg.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/pg.ts) | Intercepts `pg.Client.prototype.query` and `pg.Pool.prototype.connect`. |
| **MySQL2** (`mysql2`) | [`src/instrumentation/mysql.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/mysql.ts) | Hooks `Connection.prototype.query` and `execute`. |
| **Redis** (`redis`, `ioredis`) | [`src/instrumentation/redis.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/redis.ts) | Intercepts command dispatchers (`sendCommand`). |
| **MongoDB** (`mongodb`) | [`src/instrumentation/mongodb.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/mongodb.ts) | Utilizes MongoDB driver Command Monitoring APM. |
| **Mongoose ODM** | [`src/instrumentation/mongoose.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/mongoose.ts) | Custom middleware hooks on Model and Query execution. |
| **Prisma ORM** | [`src/instrumentation/prisma.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/instrumentation/prisma.ts) | `pulsePrismaExtension` & `@prisma/instrumentation`. |

---

## 2. SQL Sanitization & Query Normalization

To ensure data privacy and prevent credential leakage, database queries are sanitized before recording:

```sql
-- Raw Application Query:
SELECT * FROM users WHERE email = 'user@example.com' AND secret_hash = 'a9f8e7';

-- Sanitized Span Statement:
SELECT * FROM users WHERE email = $1 AND secret_hash = $2;
```

- **Query Parameters Scrubbed:** Values passed to prepared statements are replaced with positional placeholders (`$1`, `$2`, `?`).
- **Literal Value Redaction:** Inline string literals, numbers, and hex values in raw queries are sanitized to `?` or `$1`.

---

## 3. Manual Database Spans (`withDbSpan`)

For proprietary database clients or custom storage drivers, developers can emit explicit database spans using `withDbSpan` ([`src/tracing/db-span.ts`](file:///c:/Users/vikas/OneDrive/Desktop/APITOOLSDK/sdk-node/src/tracing/db-span.ts)):

```typescript
import { withDbSpan } from '@pulse-apm/node';

const user = await withDbSpan(
  {
    dbSystem: 'postgresql',
    statement: 'SELECT id, name FROM users WHERE id = $1',
    table: 'users',
    operation: 'SELECT',
  },
  async () => {
    return await customClient.execute('SELECT id, name FROM users WHERE id = $1', [userId]);
  }
);
```
