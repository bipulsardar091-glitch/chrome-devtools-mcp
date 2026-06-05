"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeProxy = executeProxy;
const axios_1 = __importDefault(require("axios"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const FormData = require('form-data');
const http_1 = require("http");
const https_1 = require("https");
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'content-encoding',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);
/**
 * Encode a response body the same way the Python version does:
 * - application/json -> parsed object
 * - any text/* or xml content type -> string
 * - everything else -> { encoding: 'base64', content: <base64> }
 */
function formatResponseBody(data, contentType) {
    const lower = contentType.toLowerCase();
    if (lower.includes('application/json')) {
        const text = data.toString('utf-8');
        try {
            return JSON.parse(text);
        }
        catch {
            return text;
        }
    }
    if (!lower.startsWith('text/') && !lower.includes('xml')) {
        return {
            encoding: 'base64',
            content: data.toString('base64'),
        };
    }
    return data.toString('utf-8');
}
function buildFormData(files) {
    const form = new FormData();
    for (const [fieldName, filename, value] of files) {
        if (filename !== null) {
            // File upload: [fieldName, filename, buffer]
            form.append(fieldName, value, { filename });
        }
        else {
            // Plain form value: [fieldName, null, value]
            form.append(fieldName, value);
        }
    }
    return form;
}
function filterHeaders(rawHeaders) {
    const out = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
        if (value === undefined)
            continue;
        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase()))
            continue;
        out[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return out;
}
async function executeProxy(parsed) {
    const start = process.hrtime.bigint();
    const httpAgent = new http_1.Agent({ keepAlive: false });
    const httpsAgent = new https_1.Agent({
        keepAlive: false,
        rejectUnauthorized: parsed.verifySSL,
    });
    let data;
    let isMultipart = false;
    if (parsed.files && parsed.files.length > 0) {
        data = buildFormData(parsed.files);
        isMultipart = true;
    }
    else if (parsed.data !== null) {
        data = parsed.data;
    }
    const config = {
        method: parsed.method,
        url: parsed.url,
        headers: { ...parsed.headers },
        params: parsed.params
            ? Object.fromEntries(new URLSearchParams(parsed.params))
            : undefined,
        // axios treats Buffer / string / FormData correctly; we need arraybuffer so
        // we can re-encode binary bodies in the response.
        responseType: 'arraybuffer',
        timeout: parsed.timeout * 1000,
        maxRedirects: parsed.followRedirects ? 21 : 0, // mirror curl's default cap
        httpAgent,
        httpsAgent,
        // Don't throw on non-2xx; we want the status code in the response.
        validateStatus: () => true,
    };
    if (parsed.auth) {
        config.auth = {
            username: parsed.auth[0],
            password: parsed.auth[1],
        };
    }
    if (parsed.cookies && Object.keys(parsed.cookies).length > 0) {
        config.headers = config.headers ?? {};
        const cookieHeader = Object.entries(parsed.cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
        config.headers['Cookie'] = cookieHeader;
    }
    if (data !== undefined) {
        config.data = data;
    }
    if (isMultipart) {
        // form-data sets its own Content-Type with boundary; let axios use it.
        delete config.headers['Content-Type'];
        // form-data provides getHeaders() for node streams; axios picks them up.
    }
    let response = null;
    let errorPayload = null;
    try {
        response = await axios_1.default.request(config);
    }
    catch (err) {
        if (axios_1.default.isAxiosError(err)) {
            const axErr = err;
            errorPayload = {
                type: axErr.code ?? axErr.name ?? 'AxiosError',
                message: axErr.message,
            };
        }
        else {
            const e = err;
            errorPayload = { type: e.name || 'Error', message: e.message };
        }
    }
    finally {
        for (const fh of parsed.openedFiles) {
            try {
                fh.close();
            }
            catch {
                // ignore
            }
        }
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1000000;
    if (errorPayload || !response) {
        return {
            status_code: null,
            headers: {},
            body: null,
            execution_time_ms: Math.round(elapsedMs * 100) / 100,
            error: errorPayload ?? { type: 'UnknownError', message: 'Unknown error' },
        };
    }
    const headers = filterHeaders(response.headers);
    const contentType = headers['content-type'] ?? '';
    const bodyBuf = Buffer.isBuffer(response.data)
        ? response.data
        : Buffer.from(response.data ?? '');
    return {
        status_code: response.status,
        headers,
        body: formatResponseBody(bodyBuf, contentType),
        execution_time_ms: Math.round(elapsedMs * 100) / 100,
        error: null,
    };
}
//# sourceMappingURL=proxyService.js.map