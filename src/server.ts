import cors from 'cors';
import express, { Request, Response } from 'express';
import proxyRouter from './routes/proxy';
import mcpRouter from './routes/mcp';
import { ensureChrome, ChromeManagerError, getChromePath } from './services/chromeManager';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors({ origin: '*', credentials: false }));

// Mount the MCP streamable-HTTP router BEFORE the body-parsing middlewares
// below. The streamable HTTP transport needs to read the raw request stream
// itself; the `express.raw({ type: () => true })` fallback would otherwise
// consume the body and break the transport.
app.use(mcpRouter);

app.use(
  express.json({
    limit: '10mb',
  }),
);
// The proxy accepts raw curl commands in text/plain bodies.
app.use(express.text({ type: ['text/plain', 'application/x-www-form-urlencoded'], limit: '10mb' }));
// Fallback: keep raw bytes around for arbitrary content types (axios will
// always return a Buffer for the parsed body of unknown content types).
app.use(
  express.raw({
    type: () => true,
    limit: '10mb',
  }),
);

app.get('/', (_req: Request, res: Response) => {
  res.json({
    message: 'localProxy - curl command proxy service',
    endpoints: {
      'GET /': 'Service info',
      'GET /health': 'Health check',
      'POST /proxy':
        'Execute a curl command. JSON { "curl": "..." } or text/plain body with the raw curl command.',
      'ALL /mcp': 'Streamable HTTP MCP server proxying the bundled chrome-devtools-mcp stdio server (launches the auto-discovered Chrome).',
      'GET /mcp/health': 'Health/status of the proxied MCP server.',
    },
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.use(proxyRouter);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

(async () => {
  try {
    const chromePath = await ensureChrome();
    console.log(`[server] using Chrome at ${chromePath}`);
    app.listen(PORT, () => {
      console.log(`[server] localProxy listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    if (err instanceof ChromeManagerError) {
      console.error(`[server] FATAL: ${err.message}`);
      if (err.cause) console.error('[server] cause:', err.cause);
    } else {
      console.error('[server] FATAL during startup:', err);
    }
    process.exit(1);
  }
})();

// `getChromePath` is consumed by the MCP router at runtime; this no-op keeps
// the import in one place so server.ts visibly owns the chrome lifecycle.
void getChromePath;
