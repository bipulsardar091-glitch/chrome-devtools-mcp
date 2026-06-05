import { Request, Response, Router } from 'express';
import { CurlParseError, parseCurlRequest } from '../services/curlParser';
import { executeProxy } from '../services/proxyService';
import { CurlProxyRequestBody, CurlProxyResponse } from '../types/proxy';

const router = Router();

function badRequest(message: string): CurlProxyResponse {
  return {
    status_code: null,
    headers: {},
    body: null,
    execution_time_ms: 0,
    error: { type: 'CurlParseError', message },
  };
}

router.post('/proxy', async (req: Request, res: Response) => {
  const start = process.hrtime.bigint();
  const contentType = (req.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();

  let curlCommand: string;

  try {
    if (contentType === 'application/json') {
      const body = req.body as Partial<CurlProxyRequestBody> | undefined;
      if (!body || typeof body.curl !== 'string') {
        const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
        res.status(400).json({
          ...badRequest("Request body must include a 'curl' string."),
          execution_time_ms: Math.round(elapsed * 100) / 100,
        });
        return;
      }
      curlCommand = body.curl;
    } else {
      // Raw curl command in the request body.
      if (Buffer.isBuffer(req.body)) {
        curlCommand = req.body.toString('utf-8').trim();
      } else if (typeof req.body === 'string') {
        curlCommand = req.body.trim();
      } else {
        curlCommand = '';
      }
    }

    if (!curlCommand) {
      const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
      res.status(400).json({
        ...badRequest('Curl command cannot be empty.'),
        execution_time_ms: Math.round(elapsed * 100) / 100,
      });
      return;
    }

    const parsed = parseCurlRequest(curlCommand);
    console.log(`[/proxy] ${parsed.method} ${parsed.url}`);

    const result = await executeProxy(parsed);

    if (result.error) {
      res.status(502).json(result);
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
    if (err instanceof CurlParseError) {
      res.status(400).json({
        ...badRequest(err.message),
        execution_time_ms: Math.round(elapsed * 100) / 100,
      });
      return;
    }
    res.status(500).json({
      status_code: null,
      headers: {},
      body: null,
      execution_time_ms: Math.round(elapsed * 100) / 100,
      error: {
        type: (err as Error).name || 'InternalError',
        message: (err as Error).message,
      },
    });
  }
});

export default router;
