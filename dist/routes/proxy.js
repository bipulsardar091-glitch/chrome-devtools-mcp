"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const curlParser_1 = require("../services/curlParser");
const proxyService_1 = require("../services/proxyService");
const router = (0, express_1.Router)();
function badRequest(message) {
    return {
        status_code: null,
        headers: {},
        body: null,
        execution_time_ms: 0,
        error: { type: 'CurlParseError', message },
    };
}
router.post('/proxy', async (req, res) => {
    const start = process.hrtime.bigint();
    const contentType = (req.headers['content-type'] ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
    let curlCommand;
    try {
        if (contentType === 'application/json') {
            const body = req.body;
            if (!body || typeof body.curl !== 'string') {
                const elapsed = Number(process.hrtime.bigint() - start) / 1000000;
                res.status(400).json({
                    ...badRequest("Request body must include a 'curl' string."),
                    execution_time_ms: Math.round(elapsed * 100) / 100,
                });
                return;
            }
            curlCommand = body.curl;
        }
        else {
            // Raw curl command in the request body.
            if (Buffer.isBuffer(req.body)) {
                curlCommand = req.body.toString('utf-8').trim();
            }
            else if (typeof req.body === 'string') {
                curlCommand = req.body.trim();
            }
            else {
                curlCommand = '';
            }
        }
        if (!curlCommand) {
            const elapsed = Number(process.hrtime.bigint() - start) / 1000000;
            res.status(400).json({
                ...badRequest('Curl command cannot be empty.'),
                execution_time_ms: Math.round(elapsed * 100) / 100,
            });
            return;
        }
        const parsed = (0, curlParser_1.parseCurlRequest)(curlCommand);
        console.log(`[/proxy] ${parsed.method} ${parsed.url}`);
        const result = await (0, proxyService_1.executeProxy)(parsed);
        if (result.error) {
            res.status(502).json(result);
            return;
        }
        res.status(200).json(result);
    }
    catch (err) {
        const elapsed = Number(process.hrtime.bigint() - start) / 1000000;
        if (err instanceof curlParser_1.CurlParseError) {
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
                type: err.name || 'InternalError',
                message: err.message,
            },
        });
    }
});
exports.default = router;
//# sourceMappingURL=proxy.js.map