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
exports.ChromeManagerError = void 0;
exports.ensureChrome = ensureChrome;
exports.getChromePath = getChromePath;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const chrome_1 = require("../types/chrome");
class ChromeManagerError extends Error {
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'ChromeManagerError';
    }
}
exports.ChromeManagerError = ChromeManagerError;
let cachedChromePath = null;
let initPromise = null;
const CHROME_REL_DIR = node_path_1.default.resolve(process.cwd(), 'bin', 'chrome');
const SETTINGS_LOG = '[chrome]';
/**
 * True iff the path points to a regular file that the OS can launch.
 *
 * - POSIX: the executable bit must be set (X_OK).
 * - Windows: the file must end in `.exe` (CreateProcess requires it; X_OK is a
 *   no-op on Win32 and would always succeed).
 */
function isValidChromePath(p) {
    try {
        const st = node_fs_1.default.statSync(p);
        if (!st.isFile())
            return false;
        if (process.platform === 'win32') {
            return p.toLowerCase().endsWith('.exe');
        }
        node_fs_1.default.accessSync(p, node_fs_1.default.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function nowIso() {
    return new Date().toISOString();
}
function recordSettings(chromePath, source) {
    const normalized = node_path_1.default.resolve(chromePath);
    const settings = {
        chromePath: normalized,
        chromeSource: source,
        lastValidatedAt: nowIso(),
    };
    (0, chrome_1.saveSettings)(settings);
    console.log(`${SETTINGS_LOG} saved settings (chromeSource=${source}, chromePath=${normalized})`);
    return settings;
}
/**
 * Search the host filesystem for an installed Chrome/Chromium. Uses
 * @puppeteer/browsers' own candidate list (which knows about %ProgramFiles%,
 * %LOCALAPPDATA%, ~/Library, /Applications, etc.) — that list is maintained
 * upstream and covers more edge cases than we'd want to re-implement.
 */
async function findSystemChrome() {
    // Dynamic import — @puppeteer/browsers is ESM-only and the project compiles
    // to CommonJS. The same pattern is used elsewhere in src/routes/mcp.ts.
    const browsers = await Promise.resolve().then(() => __importStar(require('@puppeteer/browsers')));
    const channels = [
        browsers.ChromeReleaseChannel.STABLE,
        browsers.ChromeReleaseChannel.BETA,
        browsers.ChromeReleaseChannel.CANARY,
        browsers.ChromeReleaseChannel.DEV,
    ];
    for (const channel of channels) {
        try {
            const p = browsers.computeSystemExecutablePath({
                browser: browsers.Browser.CHROME,
                channel,
            });
            if (isValidChromePath(p)) {
                console.log(`${SETTINGS_LOG} found system Chrome (channel=${channel}) at ${p}`);
                return p;
            }
        }
        catch {
            // Channel not installed on this host — try the next one.
        }
    }
    return null;
}
/**
 * Download the latest stable Chrome-for-Testing into ./bin/chrome/<buildId>/,
 * then expose it as ./bin/chrome/<buildId>/chrome_binary(.exe). The native
 * archive filename (chrome-win64/, chrome-mac-x64/, …) is kept alongside so
 * the rest of the bundle (DLLs, *.pak, locales, etc.) is right there.
 */
async function downloadChromeForTesting() {
    console.log(`${SETTINGS_LOG} no system Chrome; downloading Chrome for Testing`);
    const browsers = await Promise.resolve().then(() => __importStar(require('@puppeteer/browsers')));
    const platform = browsers.detectBrowserPlatform();
    if (!platform) {
        throw new ChromeManagerError(`No Chrome-for-Testing binary available for ${node_os_1.default.platform()} (${node_os_1.default.arch()})`);
    }
    const buildId = await browsers.resolveBuildId(browsers.Browser.CHROME, platform, browsers.BrowserTag.STABLE);
    const downloadUrl = browsers.getDownloadUrl(browsers.Browser.CHROME, platform, buildId);
    console.log(`${SETTINGS_LOG} resolved latest stable buildId=${buildId} from ${downloadUrl}`);
    const installDir = node_path_1.default.join(CHROME_REL_DIR, buildId);
    node_fs_1.default.mkdirSync(installDir, { recursive: true });
    let lastPct = -1;
    const onProgress = (downloaded, total) => {
        if (!total)
            return;
        const pct = Math.floor((downloaded / total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
            console.log(`${SETTINGS_LOG} download progress: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB)`);
            lastPct = pct;
        }
    };
    const result = await browsers.install({
        browser: browsers.Browser.CHROME,
        buildId,
        platform,
        cacheDir: installDir,
        downloadProgressCallback: onProgress,
    });
    // `result.executablePath` is the absolute path to the chrome binary inside
    // the cacheDir we passed. The structure is:
    //   <installDir>/chrome/<platform>-<buildId>/chrome-<platform>/chrome(.exe)
    const installedAbsolute = result.executablePath;
    if (!node_fs_1.default.existsSync(installedAbsolute)) {
        throw new ChromeManagerError(`Chrome for Testing install reported success but binary is missing at ${installedAbsolute}`);
    }
    // Expose the binary under the spec-mandated name (chrome_binary / chrome_binary.exe).
    // It MUST live in the same directory as chrome.dll, *.pak, icudtl.dat, etc. —
    // Chrome resolves its module path with GetModuleFileName and looks up
    // supporting files relative to it. So we copy into the bundle dir, not up at
    // the buildId level.
    const bundleDir = node_path_1.default.dirname(installedAbsolute);
    const ext = process.platform === 'win32' ? '.exe' : '';
    const canonicalName = `chrome_binary${ext}`;
    const canonicalPath = node_path_1.default.join(bundleDir, canonicalName);
    node_fs_1.default.copyFileSync(installedAbsolute, canonicalPath);
    if (process.platform !== 'win32') {
        node_fs_1.default.chmodSync(canonicalPath, 0o755);
    }
    console.log(`${SETTINGS_LOG} downloaded Chrome for Testing to ${canonicalPath}`);
    return canonicalPath;
}
/**
 * Resolve a usable Chrome executable path. Idempotent — the first call runs
 * the full discovery flow; subsequent calls return the cached path. Concurrent
 * callers share the same in-flight promise so we don't race the download.
 */
async function ensureChrome() {
    if (cachedChromePath && isValidChromePath(cachedChromePath)) {
        return cachedChromePath;
    }
    if (initPromise)
        return initPromise;
    initPromise = (async () => {
        // Step 1: load settings.
        const settings = (0, chrome_1.loadSettings)();
        if (settings) {
            console.log(`${SETTINGS_LOG} loading settings: chromePath=${settings.chromePath}, ` +
                `chromeSource=${settings.chromeSource}, lastValidatedAt=${settings.lastValidatedAt}`);
        }
        else {
            console.log(`${SETTINGS_LOG} no stored settings; running full discovery`);
        }
        // Step 2: validate the stored path.
        if (settings?.chromePath && isValidChromePath(settings.chromePath)) {
            console.log(`${SETTINGS_LOG} stored path is valid, reusing ${settings.chromePath}`);
            cachedChromePath = settings.chromePath;
            // Refresh the last-validated stamp so a healthy re-run is recorded.
            recordSettings(settings.chromePath, settings.chromeSource);
            return cachedChromePath;
        }
        if (settings?.chromePath) {
            console.log(`${SETTINGS_LOG} stored path ${settings.chromePath} is no longer valid; re-discovering`);
        }
        // Step 3: detect a system Chrome.
        if (process.platform === 'win32' || process.platform === 'darwin') {
            const sysPath = await findSystemChrome();
            if (sysPath) {
                cachedChromePath = sysPath;
                recordSettings(sysPath, 'system');
                return cachedChromePath;
            }
            console.log(`${SETTINGS_LOG} no system Chrome found on ${process.platform}; falling back to download`);
        }
        else {
            console.log(`${SETTINGS_LOG} platform ${process.platform} has no system detection; downloading directly`);
        }
        // Step 4: download.
        const dlPath = await downloadChromeForTesting();
        cachedChromePath = dlPath;
        recordSettings(dlPath, 'local');
        return cachedChromePath;
    })().catch((err) => {
        initPromise = null;
        throw new ChromeManagerError(`Could not locate or download Chrome for Testing after all recovery attempts: ${err instanceof Error ? err.message : String(err)}`, err);
    });
    return initPromise;
}
/**
 * Return the path resolved by the most recent successful `ensureChrome()`,
 * or `null` if `ensureChrome` hasn't been called yet (which the server startup
 * gate should prevent).
 */
function getChromePath() {
    return cachedChromePath;
}
//# sourceMappingURL=chromeManager.js.map