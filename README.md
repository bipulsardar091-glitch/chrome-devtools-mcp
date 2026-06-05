# localProxy

A Node + Express + TypeScript service that recreates the proxy logic of the parent FastAPI project.

This service does not include the database, scheduler, or scraper — only the `POST /proxy` endpoint that accepts a full `curl` command and forwards it to the target endpoint, returning the upstream status, headers, body, and timing information.

It also exposes a streamable HTTP MCP server at `/mcp` that proxies the
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
stdio server using the [`mcp-proxy`](https://www.npmjs.com/package/mcp-proxy)
library. The `chrome-devtools-mcp` repo is cloned into `./chrome-devtools-mcp/`
and built as part of setup; the Chrome executable itself is resolved at
startup (see [Chrome management](#chrome-management) below).

## Endpoints

- `GET /` — Service info.
- `POST /proxy` — Execute a curl command. Accepts either:
  - `application/json` with `{ "curl": "curl ..." }`
  - `text/plain` (or anything else) with the raw curl command in the body
- `GET /health` — Health check.
- `ALL /mcp` — Streamable HTTP MCP server. Sends JSON-RPC over HTTP and
  Server-Sent Events. Proxies to the locally built chrome-devtools-mcp stdio
  server. Standard MCP `initialize` → `notifications/initialized` handshake,
  then `tools/list` / `tools/call` etc.
- `GET /mcp/health` — Status of the inner MCP proxy (port, binary path).

## Setup

```bash
# 1. Install localProxy deps
npm install

# 2. Build and start localProxy
npm run build
npm start
```

For development with auto-reload:

```bash
npm run dev
```

The server listens on `PORT` (default `3000`).

### Chrome management

On startup the server resolves a Chrome executable through the
`chromeManager` service and persists the choice in `./settings.json`:

1. **Load** `./settings.json` (if it exists).
2. **Validate** the stored `chromePath` is still a launchable binary. If yes,
   reuse it and refresh `lastValidatedAt`.
3. **Detect** a system-installed Chrome on Windows (`%ProgramFiles%\Google\Chrome\Application\chrome.exe`,
   `%LOCALAPPDATA%\…`, etc.) or macOS (`/Applications/Google Chrome.app/…`,
   plus Beta / Canary / Dev channels). If found, record `chromeSource: "system"`.
4. **Download** the latest stable Chrome for Testing into `./bin/chrome/<buildId>/`
   (exposed as `chrome_binary` / `chrome_binary.exe`) via `@puppeteer/browsers`
   and record `chromeSource: "local"`.

The server refuses to start until one of these paths succeeds. The resolved
binary is passed to the chrome-devtools-mcp stdio child as `--executablePath`,
so every `tools/call` runs against the validated Chrome.

Inspect the current selection at any time:

```bash
curl http://localhost:3000/mcp/health
# → { "chromePath": "C:\\…\\bin\\chrome\\149.0.7827.54\\chrome_binary.exe", … }
```

To force a re-download, delete `./bin/chrome/` (or set `chromePath` in
`settings.json` to a non-existent path) and restart.

## Example

```bash
curl -X POST http://localhost:3000/proxy \
  -H "Content-Type: application/json" \
  -d '{"curl": "curl https://api.example.com/users -H \"Accept: application/json\""}'
```

Or with a raw multi-line curl:

```bash
curl -X POST http://localhost:3000/proxy \
  -H "Content-Type: text/plain" \
  --data-binary $'curl https://api.example.com/users \\\n  -H "Accept: application/json"'
```

Talk to the MCP server:

```bash
# 1. Initialize the session
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 2. List the chrome-devtools-mcp tools
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: <id-from-step-1>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

