"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const node_http_1 = __importDefault(require("node:http"));
const node_path_1 = __importDefault(require("node:path"));
const mcp_proxy_1 = require("mcp-proxy");
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const index_js_2 = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
const chromeManager_1 = require("../services/chromeManager");
const MCP_BIN = node_path_1.default.resolve(__dirname, '..', '..', 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js');
let mcpPort = null;
let mcpServer = null;
let initPromise = null;
async function startMcpProxy() {
    if (mcpPort)
        return mcpPort;
    if (initPromise)
        return initPromise;
    initPromise = (async () => {
        // Allocate a free local port for the inner streamable-HTTP transport.
        const net = await Promise.resolve().then(() => __importStar(require('node:net')));
        mcpPort = await new Promise((resolve, reject) => {
            const srv = net.createServer();
            srv.unref();
            srv.on('error', reject);
            srv.listen(0, '127.0.0.1', () => {
                const addr = srv.address();
                if (typeof addr === 'object' && addr) {
                    const port = addr.port;
                    srv.close(() => resolve(port));
                }
                else {
                    reject(new Error('Could not allocate port'));
                }
            });
        });
        mcpServer = await (0, mcp_proxy_1.startHTTPServer)({
            port: mcpPort,
            host: '127.0.0.1',
            // Disable SSE; we only need the streamable HTTP /mcp endpoint.
            sseEndpoint: null,
            streamEndpoint: '/mcp',
            // The Server's capabilities must mirror what the child will advertise
            // so that mcp-proxy installs matching request handlers during the
            // onConnect handshake. We pass a generous set; proxyServer only
            // installs the handlers for capabilities that are actually set, and
            // chrome-devtools-mcp advertises tools so this covers it.
            createServer: async () => {
                return new index_js_1.Server({ name: 'chrome-devtools-mcp-proxy', version: '1.0.0' }, {
                    capabilities: {
                        tools: {},
                        resources: {},
                        prompts: {},
                        logging: {},
                        completions: {},
                    },
                });
            },
            onConnect: async (server) => {
                // chromeManager.getChromePath() is populated by the server startup
                // gate in src/server.ts. The bundled chrome-devtools-mcp@1.1.1 has
                // NO CLI parser for --executablePath / --headless / --isolated / --channel
                // — see chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp-main.js
                // (a grep for those flags returns nothing). Passing them kills the
                // stdio child at start, which then makes every tools/call (including
                // navigate_page) fail with "MCP tool not able to open browser".
                // The bundle's own Chrome auto-discovery (Puppeteer) finds the
                // system Chrome we already validated in chromeManager, so we just
                // launch the binary with no extra args.
                const chromePath = (0, chromeManager_1.getChromePath)();
                if (chromePath) {
                    console.log(`[mcp] chrome-devtools-mcp will auto-discover Chrome at ${chromePath}`);
                }
                else {
                    console.warn('[mcp] no Chrome path resolved yet; chrome-devtools-mcp will fall back to its own discovery');
                }
                const mcpArgs = [MCP_BIN];
                void chromePath;
                const stdio = new stdio_js_1.StdioClientTransport({
                    command: process.execPath,
                    args: mcpArgs,
                    env: process.env,
                    stderr: 'pipe',
                });
                const client = new index_js_2.Client({ name: 'localProxy-mcp-client', version: '1.0.0' }, { capabilities: {} });
                stdio.stderr?.on('data', (chunk) => {
                    process.stderr.write(`[chrome-devtools-mcp] ${chunk}`);
                });
                await client.connect(stdio);
                // Forward the upstream server's advertised capabilities to the
                // proxy so it installs the right request handlers (e.g. tools/list,
                // tools/call). Without this, the inner Server would return
                // "Method not found" for every chrome-devtools-mcp tool.
                const upstreamCapabilities = client.getServerCapabilities() ?? {};
                await (0, mcp_proxy_1.proxyServer)({
                    server,
                    client,
                    serverCapabilities: upstreamCapabilities,
                });
            },
        });
        console.log(`[mcp] chrome-devtools-mcp proxy listening on http://127.0.0.1:${mcpPort}/mcp`);
        return mcpPort;
    })();
    try {
        return await initPromise;
    }
    catch (err) {
        initPromise = null;
        throw err;
    }
}
function forwardToInner(port, method, headers, body) {
    return new Promise((resolve, reject) => {
        const req = node_http_1.default.request({
            host: '127.0.0.1',
            port,
            method,
            path: '/mcp',
            headers: { ...headers, 'content-length': String(body.length) },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                resolve({
                    status: res.statusCode ?? 502,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        if (body.length > 0)
            req.write(body);
        req.end();
    });
}
// True iff the buffered upstream response is the MCP streamable-HTTP
// transport's "Session not found" error. We only look at JSON bodies
// (Content-Type: application/json) — for SSE responses the transport
// is already streaming and we can't transparently retry.
function isStaleSessionResponse(status, headers, body) {
    if (status !== 404)
        return false;
    const ct = headers['content-type'];
    const ctStr = Array.isArray(ct) ? ct[0] : ct;
    if (!ctStr || !/application\/json/i.test(ctStr))
        return false;
    try {
        const parsed = JSON.parse(body.toString('utf8'));
        return parsed?.error?.code === -32001;
    }
    catch {
        return false;
    }
}
const router = (0, express_1.Router)();
router.all('/mcp', async (req, res) => {
    let port;
    try {
        port = await startMcpProxy();
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(503).json({ error: `MCP proxy unavailable: ${message}` });
        return;
    }
    // Buffer the original request body so we can replay it after a fresh
    // initialize if the upstream reports a stale session.
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    // Build the headers we will send to the inner transport. Hop-by-hop
    // headers are dropped; the inner transport sits on 127.0.0.1.
    const baseHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v))
            baseHeaders[k] = v.join(', ');
        else if (v != null)
            baseHeaders[k] = String(v);
    }
    delete baseHeaders['host'];
    delete baseHeaders['connection'];
    delete baseHeaders['content-length'];
    const hadSessionHeader = Boolean(baseHeaders['mcp-session-id']);
    // First attempt: forward the request as-is.
    let upstream;
    try {
        upstream = await forwardToInner(port, req.method ?? 'POST', baseHeaders, body);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[/mcp] proxy error:', message);
        res.status(502).json({ error: message });
        return;
    }
    // Auto-recover from "Session not found": mint a new session by sending
    // our own initialize to the inner transport, then replay the original
    // request on that new session. The client never sees the -32001.
    if (hadSessionHeader &&
        isStaleSessionResponse(upstream.status, upstream.headers, upstream.body)) {
        const initBody = Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
                protocolVersion: '2025-03-26',
                capabilities: {},
                clientInfo: { name: 'localProxy-mcp-reinit', version: '1.0.0' },
            },
        }));
        const initHeaders = {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
        };
        let initResponse;
        try {
            initResponse = await forwardToInner(port, 'POST', initHeaders, initBody);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[/mcp] reinitialize failed:', message);
            res.status(502).json({ error: `reinitialize failed: ${message}` });
            return;
        }
        const newSession = initResponse.headers['mcp-session-id'];
        const newSessionStr = Array.isArray(newSession) ? newSession[0] : newSession;
        if (initResponse.status < 200 || initResponse.status >= 300 || !newSessionStr) {
            // Couldn't mint a session — surface the original upstream error to
            // the client so they can decide what to do.
            res.status(upstream.status);
            for (const [k, v] of Object.entries(upstream.headers)) {
                if (v != null)
                    res.setHeader(k, v);
            }
            res.end(upstream.body);
            return;
        }
        // Replay the original request on the new session.
        const replayHeaders = { ...baseHeaders, 'mcp-session-id': newSessionStr };
        let replay;
        try {
            replay = await forwardToInner(port, req.method ?? 'POST', replayHeaders, body);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[/mcp] replay after reinitialize failed:', message);
            res.status(502).json({ error: `replay failed: ${message}` });
            return;
        }
        // If the replay *also* returns Session not found (shouldn't happen,
        // since we just minted the session), bail out rather than loop.
        if (isStaleSessionResponse(replay.status, replay.headers, replay.body)) {
            res.status(replay.status);
            for (const [k, v] of Object.entries(replay.headers)) {
                if (v != null)
                    res.setHeader(k, v);
            }
            res.end(replay.body);
            return;
        }
        upstream = replay;
        // The replay's mcp-session-id header will be the same new id, but make
        // sure it's set on the response so the client picks it up.
        upstream.headers['mcp-session-id'] = newSessionStr;
    }
    // Stream the (possibly re-played) upstream response back to the client.
    res.status(upstream.status);
    for (const [k, v] of Object.entries(upstream.headers)) {
        if (v != null)
            res.setHeader(k, v);
    }
    res.end(upstream.body);
});
router.get('/mcp/health', async (_req, res) => {
    try {
        const port = await startMcpProxy();
        res.json({
            status: 'ok',
            bin: MCP_BIN,
            chromePath: (0, chromeManager_1.getChromePath)(),
            upstream: `http://127.0.0.1:${port}/mcp`,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res
            .status(503)
            .json({ status: 'unavailable', error: message, bin: MCP_BIN, chromePath: (0, chromeManager_1.getChromePath)() });
    }
});
exports.default = router;
//# sourceMappingURL=mcp.js.map