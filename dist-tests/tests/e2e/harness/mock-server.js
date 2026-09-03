import http, {} from 'node:http';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import { ALL_10_ROUTES, createDefaultMockConfig, computeConfigHash, updateConfigRoutes, deepMerge } from './config-builder.js';
import { ChaosEngine } from './chaos-engine.js';
export class RemoteConfigMockServer {
    options;
    server = null;
    sockets = new Set();
    requests = [];
    chaos = new ChaosEngine();
    customHandlers = new Map();
    activeConfig;
    configRevision = 1;
    currentEtagValue = '';
    triggerRefreshOnNextAck = false;
    targetRouteForRefresh = null;
    assignedPort = 0;
    boundUrl = '';
    constructor(options = {}) {
        this.options = options;
        this.triggerRefreshOnNextAck = options.defaultAckChange ?? false;
        // Initial config populated before dynamic port assignment
        this.activeConfig = createDefaultMockConfig('http://127.0.0.1:0', options.initialConfig);
        this.currentEtagValue = computeConfigHash(this.activeConfig);
    }
    static async start(options = {}) {
        const server = new RemoteConfigMockServer(options);
        await server.start();
        return server;
    }
    get url() {
        return this.boundUrl || `http://127.0.0.1:${this.assignedPort}`;
    }
    get baseUrl() {
        return this.url;
    }
    get port() {
        return this.assignedPort;
    }
    get addressPort() {
        return this.assignedPort;
    }
    get config() {
        return this.activeConfig;
    }
    get eTag() {
        return this.currentEtagValue;
    }
    get currentEtag() {
        return this.currentEtagValue;
    }
    get chaosEngine() {
        return this.chaos;
    }
    async start() {
        if (this.server)
            return this.url;
        const host = this.options.host ?? '127.0.0.1';
        const requestedPort = this.options.port ?? 0;
        this.server = http.createServer((req, res) => {
            void this.handleIncoming(req, res);
        });
        this.server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
        });
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(requestedPort, host, () => {
                this.server.removeListener('error', reject);
                resolve();
            });
        });
        const address = this.server.address();
        this.assignedPort = address.port;
        this.boundUrl = `http://${host}:${this.assignedPort}`;
        // Dynamically update all 10 route URLs to point to this active server instance
        const initial = createDefaultMockConfig(this.boundUrl, this.options.initialConfig);
        this.currentEtagValue = computeConfigHash(initial);
        this.activeConfig = {
            ...initial,
            meta: {
                ...initial.meta,
                configHash: this.currentEtagValue,
            },
        };
        return this.boundUrl;
    }
    async stop() {
        for (const socket of this.sockets) {
            try {
                socket.destroy();
            }
            catch { }
        }
        this.sockets.clear();
        if (!this.server)
            return;
        await new Promise((resolve, reject) => {
            this.server.close(err => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
            this.server = null;
            this.assignedPort = 0;
            this.boundUrl = '';
        });
    }
    async close() {
        await this.stop();
    }
    reset() {
        this.requests.length = 0;
        this.chaos.clear();
        this.customHandlers.clear();
        this.triggerRefreshOnNextAck = this.options.defaultAckChange ?? false;
        this.targetRouteForRefresh = null;
        this.configRevision = 1;
        if (this.assignedPort > 0) {
            this.activeConfig = createDefaultMockConfig(this.url, this.options.initialConfig);
            this.currentEtagValue = computeConfigHash(this.activeConfig);
        }
    }
    // ─── Configuration State Management ───────────────────────────────────────
    getConfig() {
        return structuredClone(this.activeConfig);
    }
    setConfig(newConfig) {
        const updated = updateConfigRoutes(createDefaultMockConfig(this.url, newConfig), this.url);
        this.configRevision++;
        this.currentEtagValue = computeConfigHash(updated);
        this.activeConfig = {
            ...updated,
            meta: {
                ...updated.meta,
                configHash: this.currentEtagValue,
            },
        };
    }
    mutateConfig(mutator, options = {}) {
        const draft = structuredClone(this.activeConfig);
        const result = mutator(draft);
        let nextConfig = draft;
        if (result && typeof result === 'object') {
            nextConfig = deepMerge(draft, result);
        }
        this.configRevision++;
        const updated = updateConfigRoutes(nextConfig, this.url);
        this.currentEtagValue = computeConfigHash(updated);
        this.activeConfig = {
            ...updated,
            meta: {
                ...updated.meta,
                generatedAt: new Date().toISOString(),
                configHash: this.currentEtagValue,
            },
        };
        if (options.notifyChange) {
            this.triggerRefreshOnNextAck = true;
        }
        return structuredClone(this.activeConfig);
    }
    simulateConfigChange(delta) {
        return structuredClone(this.mutateConfig(draft => {
            return deepMerge(draft, delta);
        }, { notifyChange: true }));
    }
    armConfigRefreshSignal(onRoute) {
        this.triggerRefreshOnNextAck = true;
        this.targetRouteForRefresh = onRoute ?? null;
    }
    flagConfigChanged(notify = true) {
        this.triggerRefreshOnNextAck = notify;
    }
    setFeature(feature, enabled, notifyChange = true) {
        this.mutateConfig(draft => {
            draft.features[feature] = enabled;
        }, { notifyChange });
    }
    setKillswitch(killswitch, enabled, notifyChange = true) {
        this.mutateConfig(draft => {
            draft.killswitches[killswitch] = enabled;
        }, { notifyChange });
    }
    setSamplingRate(category, rate, notifyChange = true) {
        this.mutateConfig(draft => {
            if (category !== 'routes') {
                draft.sampling[category] = rate;
            }
        }, { notifyChange });
    }
    // ─── Chaos Fault Injection ────────────────────────────────────────────────
    injectFault(rule) {
        return this.chaos.addRule(rule);
    }
    clearFaults() {
        this.chaos.clear();
    }
    registerRouteHandler(path, handler) {
        this.customHandlers.set(path, handler);
    }
    // ─── Recording & Query API ────────────────────────────────────────────────
    clearHistory() {
        this.requests.length = 0;
    }
    getReceivedRequests(filter) {
        if (!filter)
            return [...this.requests];
        if (typeof filter === 'function') {
            return this.requests.filter(filter);
        }
        return this.requests.filter(r => r.path === filter || r.route === filter || r.path.includes(filter) || r.path.endsWith(filter));
    }
    getRequests(routeOrPath) {
        return [...this.getReceivedRequests(routeOrPath)];
    }
    getLatestRequest(routeOrPath) {
        const list = this.getRequests(routeOrPath);
        return list[list.length - 1];
    }
    getReceivedEvents(route) {
        const matching = route ? this.getReceivedRequests(route) : this.requests;
        return matching.flatMap(r => r.events);
    }
    getReceivedEventCount(route) {
        return this.getReceivedEvents(route).length;
    }
    async waitForRequests(filterOrRoute, countOrOptions = 1, timeoutMs = 5_000) {
        let targetCount = 1;
        let effectiveTimeout = timeoutMs;
        if (typeof countOrOptions === 'number') {
            targetCount = countOrOptions;
        }
        else if (typeof countOrOptions === 'object') {
            targetCount = countOrOptions.count ?? 1;
            effectiveTimeout = countOrOptions.timeoutMs ?? timeoutMs;
        }
        const predicate = typeof filterOrRoute === 'function'
            ? filterOrRoute
            : req => req.path === filterOrRoute ||
                req.route === filterOrRoute ||
                req.path.includes(filterOrRoute) ||
                req.path.endsWith(filterOrRoute);
        const started = Date.now();
        while (Date.now() - started < effectiveTimeout) {
            const matches = this.requests.filter(predicate);
            if (matches.length >= targetCount)
                return matches;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        const found = this.requests.filter(predicate).length;
        throw new Error(`Timeout waiting for ${targetCount} requests matching criteria after ${effectiveTimeout}ms (found ${found}, total recorded: ${this.requests.length})`);
    }
    async waitForEvents(routeOrFilter, countOrOptions = 1, timeoutMs = 5_000) {
        let targetCount = 1;
        let effectiveTimeout = timeoutMs;
        if (typeof countOrOptions === 'number') {
            targetCount = countOrOptions;
        }
        else if (typeof countOrOptions === 'object') {
            targetCount = countOrOptions.count ?? 1;
            effectiveTimeout = countOrOptions.timeoutMs ?? timeoutMs;
        }
        const isFn = typeof routeOrFilter === 'function';
        const started = Date.now();
        while (Date.now() - started < effectiveTimeout) {
            const allEvents = isFn
                ? this.getReceivedEvents().filter(routeOrFilter)
                : this.getReceivedEvents(routeOrFilter);
            if (allEvents.length >= targetCount)
                return [...allEvents];
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        const totalFound = isFn
            ? this.getReceivedEvents().filter(routeOrFilter).length
            : this.getReceivedEvents(routeOrFilter).length;
        throw new Error(`Timeout waiting for ${targetCount} events after ${effectiveTimeout}ms (found ${totalFound})`);
    }
    // ─── HTTP Request Dispatch & Handling ─────────────────────────────────────
    async handleIncoming(req, res) {
        const rawUrl = req.url ?? '/';
        const parsedUrl = new URL(rawUrl, this.url);
        const normalizedPath = parsedUrl.pathname.replace(/\/+$/, '') || '/';
        const route = this.resolveRouteName(normalizedPath);
        // Read full incoming body
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const rawBody = Buffer.concat(chunks);
        // Decompress payload if compressed
        const encoding = (req.headers['content-encoding'] ?? '').toLowerCase();
        let decodedBody = '';
        try {
            if (encoding === 'gzip' && rawBody.length > 0) {
                decodedBody = gunzipSync(rawBody).toString('utf8');
            }
            else if (encoding === 'br' && rawBody.length > 0) {
                decodedBody = brotliDecompressSync(rawBody).toString('utf8');
            }
            else if (encoding === 'deflate' && rawBody.length > 0) {
                decodedBody = inflateSync(rawBody).toString('utf8');
            }
            else {
                decodedBody = rawBody.toString('utf8');
            }
        }
        catch (err) {
            decodedBody = rawBody.toString('utf8');
        }
        let parsedBody = null;
        try {
            parsedBody = decodedBody ? JSON.parse(decodedBody) : null;
        }
        catch {
            parsedBody = decodedBody;
        }
        // Extract telemetry events array if present in batch envelope
        let events = [];
        if (parsedBody && typeof parsedBody === 'object') {
            if (Array.isArray(parsedBody.events)) {
                events = parsedBody.events;
            }
            else if (Array.isArray(parsedBody)) {
                events = parsedBody;
            }
        }
        // Record the incoming request immediately so all arrived requests are in history
        const recorded = {
            id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: Date.now(),
            method: req.method ?? 'GET',
            path: normalizedPath,
            headers: req.headers,
            rawBody,
            decodedBody,
            body: parsedBody,
            events,
            route,
            statusCode: 200,
            encoding: encoding || undefined,
        };
        this.requests.push(recorded);
        // Evaluate Chaos Fault Injection rules
        const chaosResult = await this.chaos.evaluate(req, res, route, normalizedPath);
        if (chaosResult.handled) {
            ;
            recorded.statusCode = res.statusCode || 500;
            return;
        }
        // Check optional API Key authentication requirement
        if (this.options.requireApiKey) {
            const authHeader = req.headers['authorization'];
            const apiKeyHeader = req.headers['x-api-key'];
            const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
            const suppliedKey = apiKeyHeader || bearerToken;
            if (!suppliedKey || suppliedKey !== this.options.requireApiKey) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized', message: 'Missing or invalid API key' }));
                recorded.statusCode = 401;
                return;
            }
        }
        // Custom route handlers override
        if (this.customHandlers.has(normalizedPath)) {
            await this.customHandlers.get(normalizedPath)(req, res);
            recorded.statusCode = res.statusCode || 200;
            return;
        }
        // Control plane: /api/v1/init or /v1/init
        if (normalizedPath === '/api/v1/init' || normalizedPath === '/v1/init') {
            this.handleInit(req, res);
            recorded.statusCode = 200;
            return;
        }
        // Control plane: /api/v1/sdk-config or /v1/sdk-config
        if (normalizedPath === '/api/v1/sdk-config' || normalizedPath === '/v1/sdk-config') {
            this.handleSdkConfig(req, res);
            recorded.statusCode = res.statusCode || 200;
            return;
        }
        // Telemetry Ingestion Routes (traces, requests, errors, logs, metrics, etc.)
        if (ALL_10_ROUTES.includes(route)) {
            this.handleTelemetryIngest(req, res, route, events.length);
            recorded.statusCode = res.statusCode || 200;
            return;
        }
        // 404 Not Found fallback
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found', path: normalizedPath }));
        recorded.statusCode = 404;
    }
    handleInit(req, res) {
        const payload = {
            success: true,
            projectId: this.activeConfig.sdk.projectId,
            organizationId: 'org-e2e-test',
            environmentId: 'env-e2e-test',
            environment: this.activeConfig.sdk.environment,
            release: this.activeConfig.sdk.release,
            configRevision: this.configRevision,
            configHash: this.currentEtagValue,
            config: this.activeConfig,
        };
        res.writeHead(200, {
            'content-type': 'application/json',
            'ETag': this.currentEtagValue,
        });
        res.end(JSON.stringify(payload));
    }
    handleSdkConfig(req, res) {
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch &&
            (ifNoneMatch === this.currentEtagValue ||
                ifNoneMatch === `W/${this.currentEtagValue}` ||
                ifNoneMatch === `W/"${this.currentEtagValue}"` ||
                ifNoneMatch === `"${this.currentEtagValue}"`)) {
            res.writeHead(304, { 'ETag': this.currentEtagValue });
            res.end();
            return;
        }
        res.writeHead(200, {
            'content-type': 'application/json',
            'ETag': this.currentEtagValue,
        });
        res.end(JSON.stringify({ config: this.activeConfig }));
    }
    handleTelemetryIngest(req, res, route, eventCount) {
        let shouldTriggerRefresh = false;
        if (this.triggerRefreshOnNextAck) {
            if (!this.targetRouteForRefresh || this.targetRouteForRefresh === route) {
                shouldTriggerRefresh = true;
                this.triggerRefreshOnNextAck = false;
                this.targetRouteForRefresh = null;
            }
        }
        if (shouldTriggerRefresh) {
            const ackPayload = {
                success: true,
                received: eventCount,
                change: true,
                status: 202,
            };
            res.writeHead(202, { 'content-type': 'application/json' });
            res.end(JSON.stringify(ackPayload));
            return;
        }
        const ackPayload = {
            success: true,
            received: eventCount,
            change: false,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ackPayload));
    }
    resolveRouteName(path) {
        if (path.includes('/init'))
            return 'init';
        if (path.includes('/sdk-config'))
            return 'sdk-config';
        if (path.includes('/checkins'))
            return 'crons';
        for (const routeName of ALL_10_ROUTES) {
            if (path.endsWith(`/${routeName}`) || path.endsWith(`/${routeName}/`) || path === `/${routeName}` || path.includes(`/${routeName}/`) || path.includes(`/${routeName}?`)) {
                return routeName;
            }
        }
        return '';
    }
}
