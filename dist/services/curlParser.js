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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CurlParseError = void 0;
exports.parseCurlRequest = parseCurlRequest;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class CurlParseError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CurlParseError';
    }
}
exports.CurlParseError = CurlParseError;
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
const SUPPORTED_METHODS = new Set([
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'HEAD',
    'OPTIONS',
]);
/**
 * Tokenize a curl command into an array of arguments, similar to Python's
 * shlex.split with posix=True. Supports single and double quoted strings.
 */
function tokenize(command) {
    const tokens = [];
    let current = '';
    let quote = null;
    let escaped = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\' && quote !== "'") {
            // In double quotes backslash only escapes special chars; treat all as escape
            escaped = true;
            continue;
        }
        if (quote) {
            if (ch === quote) {
                quote = null;
            }
            else {
                current += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (current.length > 0) {
        tokens.push(current);
    }
    if (quote) {
        throw new CurlParseError(`Unterminated ${quote} quote in curl command.`);
    }
    return tokens;
}
function normalizeCurlCommand(curlCommand) {
    // Undo backslash-newline line continuations (with optional spaces between
    // the backslash, newline, and the following line).
    return curlCommand
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\\\s*\n\s*/g, ' ')
        .trim();
}
function splitCurlCommand(curlCommand) {
    let parts;
    try {
        parts = tokenize(normalizeCurlCommand(curlCommand));
    }
    catch (err) {
        if (err instanceof CurlParseError) {
            throw err;
        }
        throw new CurlParseError(`Unable to parse curl command: ${err.message}`);
    }
    if (parts.length === 0) {
        throw new CurlParseError('Curl command cannot be empty.');
    }
    if (parts[0].toLowerCase() === 'curl') {
        return parts.slice(1);
    }
    if (parts[0].toLowerCase().endsWith('curl')) {
        return parts.slice(1);
    }
    throw new CurlParseError('Command must start with curl.');
}
function nextValue(args, index, option) {
    if (index + 1 >= args.length) {
        throw new CurlParseError(`${option} requires a value.`);
    }
    return [args[index + 1], index + 2];
}
function parseHeader(value) {
    if (!value.includes(':')) {
        throw new CurlParseError(`Invalid header: ${value}`);
    }
    const idx = value.indexOf(':');
    return [value.slice(0, idx).trim(), value.slice(idx + 1).trim()];
}
function parseCookieString(cookieString) {
    const cookies = {};
    for (const cookie of cookieString.split(';')) {
        if (cookie.includes('=')) {
            const eq = cookie.indexOf('=');
            const key = cookie.slice(0, eq).trim();
            const value = cookie.slice(eq + 1).trim();
            if (key) {
                cookies[key] = value;
            }
        }
    }
    return cookies;
}
function parseTimeout(value, option) {
    const timeout = Number(value);
    if (!Number.isFinite(timeout) || Number.isNaN(timeout)) {
        throw new CurlParseError(`${option} must be a number of seconds.`);
    }
    if (timeout <= 0) {
        throw new CurlParseError(`${option} must be greater than zero.`);
    }
    return timeout;
}
function parseFormPart(value, openedFiles) {
    if (!value.includes('=')) {
        throw new CurlParseError(`Invalid form part: ${value}`);
    }
    const eq = value.indexOf('=');
    const fieldName = value.slice(0, eq);
    let fieldValue = value.slice(eq + 1);
    if (fieldValue.startsWith('@')) {
        const fileSpec = fieldValue.slice(1);
        const filePath = fileSpec.split(';', 1)[0];
        let data;
        try {
            data = fs.readFileSync(filePath);
        }
        catch (err) {
            throw new CurlParseError(`Unable to open upload file '${filePath}': ${err.message}`);
        }
        const filename = path.basename(filePath);
        openedFiles.push({
            path: filePath,
            close: () => {
                // fs.readFileSync has no handle to close; placeholder for future
            },
        });
        return [fieldName, [fieldName, filename, data]];
    }
    return [fieldName, [fieldName, null, fieldValue]];
}
function readDataValue(value) {
    if (value.startsWith('@')) {
        const filePath = value.slice(1);
        try {
            return fs.readFileSync(filePath);
        }
        catch (err) {
            throw new CurlParseError(`Unable to read data file '${filePath}': ${err.message}`);
        }
    }
    return value;
}
function parseCurlRequest(curlCommand) {
    const args = splitCurlCommand(curlCommand);
    let method = null;
    let url = null;
    const headers = {};
    const cookies = {};
    let auth = null;
    const dataParts = [];
    const files = [];
    const openedFiles = [];
    let followRedirects = false;
    let verifySSL = true;
    let timeout = 30;
    let paramsFromData = false;
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        let value = null;
        // ---- Method ----
        if (arg === '-X' || arg === '--request') {
            [value, i] = nextValue(args, i, arg);
            method = value.toUpperCase();
            continue;
        }
        if (arg.startsWith('-X') && arg !== '-X') {
            method = arg.slice(2).toUpperCase();
            i++;
            continue;
        }
        if (arg.startsWith('--request=')) {
            method = arg.split('=', 2)[1].toUpperCase();
            i++;
            continue;
        }
        // ---- Headers ----
        if (arg === '-H' || arg === '--header') {
            [value, i] = nextValue(args, i, arg);
            const [k, v] = parseHeader(value);
            if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) {
                headers[k] = v;
            }
            continue;
        }
        if (arg.startsWith('-H') && arg !== '-H') {
            const [k, v] = parseHeader(arg.slice(2));
            if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) {
                headers[k] = v;
            }
            i++;
            continue;
        }
        if (arg.startsWith('--header=')) {
            const [k, v] = parseHeader(arg.split('=', 2)[1]);
            if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) {
                headers[k] = v;
            }
            i++;
            continue;
        }
        // ---- Data ----
        if (arg === '-d' ||
            arg === '--data' ||
            arg === '--data-raw' ||
            arg === '--data-binary' ||
            arg === '--data-ascii' ||
            arg === '--data-urlencode') {
            [value, i] = nextValue(args, i, arg);
            dataParts.push(readDataValue(value));
            continue;
        }
        if (arg.startsWith('-d') && arg !== '-d') {
            dataParts.push(readDataValue(arg.slice(2)));
            i++;
            continue;
        }
        if (arg.startsWith('--data=') ||
            arg.startsWith('--data-raw=') ||
            arg.startsWith('--data-binary=') ||
            arg.startsWith('--data-ascii=') ||
            arg.startsWith('--data-urlencode=')) {
            dataParts.push(readDataValue(arg.split('=', 2)[1]));
            i++;
            continue;
        }
        // ---- Form / multipart ----
        if (arg === '-F' || arg === '--form' || arg === '--form-string') {
            [value, i] = nextValue(args, i, arg);
            const [name, formValue] = parseFormPart(value, openedFiles);
            files.push(formValue);
            // Keep name on the tuple for reference; form-data uses index 1
            void name;
            continue;
        }
        if (arg.startsWith('-F') && arg !== '-F') {
            const [, formValue] = parseFormPart(arg.slice(2), openedFiles);
            files.push(formValue);
            i++;
            continue;
        }
        if (arg.startsWith('--form=')) {
            const [, formValue] = parseFormPart(arg.split('=', 2)[1], openedFiles);
            files.push(formValue);
            i++;
            continue;
        }
        // ---- Cookies ----
        if (arg === '-b' || arg === '--cookie') {
            [value, i] = nextValue(args, i, arg);
            const parsed = parseCookieString(value);
            if (Object.keys(parsed).length > 0) {
                Object.assign(cookies, parsed);
            }
            else {
                headers['Cookie'] = value;
            }
            continue;
        }
        if (arg.startsWith('-b') && arg !== '-b') {
            Object.assign(cookies, parseCookieString(arg.slice(2)));
            i++;
            continue;
        }
        if (arg.startsWith('--cookie=')) {
            Object.assign(cookies, parseCookieString(arg.split('=', 2)[1]));
            i++;
            continue;
        }
        if (arg === '--cookie-jar') {
            [, i] = nextValue(args, i, arg);
            continue;
        }
        // ---- Auth ----
        if (arg === '-u' || arg === '--user') {
            [value, i] = nextValue(args, i, arg);
            const [username, , password] = value.partition(':');
            auth = [username, password];
            continue;
        }
        if (arg.startsWith('-u') && arg !== '-u') {
            const [username, , password] = arg.slice(2).partition(':');
            auth = [username, password];
            i++;
            continue;
        }
        if (arg.startsWith('--user=')) {
            const [username, , password] = arg.split('=', 2)[1].partition(':');
            auth = [username, password];
            i++;
            continue;
        }
        // ---- Redirects / SSL ----
        if (arg === '-L' || arg === '--location' || arg === '--location-trusted') {
            followRedirects = true;
            i++;
            continue;
        }
        if (arg === '-k' || arg === '--insecure') {
            verifySSL = false;
            i++;
            continue;
        }
        if (arg === '-I' || arg === '--head') {
            method = 'HEAD';
            i++;
            continue;
        }
        if (arg === '-G' || arg === '--get') {
            paramsFromData = true;
            i++;
            continue;
        }
        // ---- Timeout ----
        if (arg === '--connect-timeout' || arg === '--max-time' || arg === '-m') {
            [value, i] = nextValue(args, i, arg);
            timeout = parseTimeout(value, arg);
            continue;
        }
        if (arg.startsWith('-m') && arg !== '-m') {
            timeout = parseTimeout(arg.slice(2), '-m');
            i++;
            continue;
        }
        if (arg.startsWith('--max-time=') || arg.startsWith('--connect-timeout=')) {
            const [full, val] = arg.split('=', 2);
            timeout = parseTimeout(val, full);
            i++;
            continue;
        }
        // ---- User-Agent ----
        if (arg === '-A' || arg === '--user-agent') {
            [value, i] = nextValue(args, i, arg);
            headers['User-Agent'] = value;
            continue;
        }
        if (arg.startsWith('-A') && arg !== '-A') {
            headers['User-Agent'] = arg.slice(2);
            i++;
            continue;
        }
        if (arg.startsWith('--user-agent=')) {
            headers['User-Agent'] = arg.split('=', 2)[1];
            i++;
            continue;
        }
        // ---- URL ----
        if (arg === '--url') {
            [url, i] = nextValue(args, i, arg);
            continue;
        }
        if (arg.startsWith('--url=')) {
            url = arg.split('=', 2)[1];
            i++;
            continue;
        }
        // ---- Ignored output-related flags ----
        if (arg === '--compressed' ||
            arg === '-s' ||
            arg === '--silent' ||
            arg === '-i' ||
            arg === '--include' ||
            arg === '-v' ||
            arg === '--verbose' ||
            arg === '-o' ||
            arg === '--output') {
            if (arg === '-o' || arg === '--output') {
                [, i] = nextValue(args, i, arg);
            }
            else {
                i++;
            }
            continue;
        }
        // ---- Positional URL ----
        if (arg.startsWith('http://') || arg.startsWith('https://')) {
            url = arg;
            i++;
            continue;
        }
        throw new CurlParseError(`Unsupported or invalid curl option: ${arg}`);
    }
    if (!url) {
        throw new CurlParseError('Curl command must include a target URL.');
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new CurlParseError('URL must start with http:// or https://');
    }
    if (!method) {
        method = dataParts.length > 0 || files.length > 0 ? 'POST' : 'GET';
    }
    if (!SUPPORTED_METHODS.has(method)) {
        throw new CurlParseError(`Unsupported HTTP method: ${method}`);
    }
    let data = null;
    let params = null;
    if (dataParts.length > 0) {
        if (paramsFromData) {
            params = dataParts
                .map((p) => (Buffer.isBuffer(p) ? p.toString() : String(p)))
                .join('&');
        }
        else if (dataParts.every((p) => typeof p === 'string')) {
            data = dataParts.join('&');
        }
        else if (dataParts.length === 1) {
            data = dataParts[0];
        }
        else {
            data = Buffer.concat(dataParts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(String(p)))));
        }
        headers['Content-Type'] =
            headers['Content-Type'] ?? 'application/x-www-form-urlencoded';
    }
    return {
        method: method,
        url,
        headers,
        cookies,
        auth,
        data,
        params,
        files: files.length > 0 ? files : null,
        followRedirects,
        verifySSL,
        timeout,
        openedFiles,
    };
}
if (!String.prototype.partition) {
    String.prototype.partition = function (separator) {
        const idx = this.indexOf(separator);
        if (idx === -1) {
            return [this, '', ''];
        }
        return [this.slice(0, idx), separator, this.slice(idx + separator.length)];
    };
}
//# sourceMappingURL=curlParser.js.map