import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ChromeSource,
  Settings,
  loadSettings,
  saveSettings,
} from '../types/chrome';

export class ChromeManagerError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ChromeManagerError';
  }
}

let cachedChromePath: string | null = null;
let initPromise: Promise<string> | null = null;

const CHROME_REL_DIR = path.resolve(process.cwd(), 'bin', 'chrome');
const SETTINGS_LOG = '[chrome]';

/**
 * True iff the path points to a regular file that the OS can launch.
 *
 * - POSIX: the executable bit must be set (X_OK).
 * - Windows: the file must end in `.exe` (CreateProcess requires it; X_OK is a
 *   no-op on Win32 and would always succeed).
 */
function isValidChromePath(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') {
      return p.toLowerCase().endsWith('.exe');
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function recordSettings(chromePath: string, source: ChromeSource): Settings {
  const normalized = path.resolve(chromePath);
  const settings: Settings = {
    chromePath: normalized,
    chromeSource: source,
    lastValidatedAt: nowIso(),
  };
  saveSettings(settings);
  console.log(
    `${SETTINGS_LOG} saved settings (chromeSource=${source}, chromePath=${normalized})`,
  );
  return settings;
}

/**
 * Search the host filesystem for an installed Chrome/Chromium. Uses
 * @puppeteer/browsers' own candidate list (which knows about %ProgramFiles%,
 * %LOCALAPPDATA%, ~/Library, /Applications, etc.) — that list is maintained
 * upstream and covers more edge cases than we'd want to re-implement.
 */
async function findSystemChrome(): Promise<string | null> {
  // Dynamic import — @puppeteer/browsers is ESM-only and the project compiles
  // to CommonJS. The same pattern is used elsewhere in src/routes/mcp.ts.
  const browsers = await import('@puppeteer/browsers');
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
    } catch {
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
async function downloadChromeForTesting(): Promise<string> {
  console.log(`${SETTINGS_LOG} no system Chrome; downloading Chrome for Testing`);
  const browsers = await import('@puppeteer/browsers');

  const platform = browsers.detectBrowserPlatform();
  if (!platform) {
    throw new ChromeManagerError(
      `No Chrome-for-Testing binary available for ${os.platform()} (${os.arch()})`,
    );
  }

  const buildId = await browsers.resolveBuildId(
    browsers.Browser.CHROME,
    platform,
    browsers.BrowserTag.STABLE,
  );
  const downloadUrl = browsers.getDownloadUrl(
    browsers.Browser.CHROME,
    platform,
    buildId,
  );
  console.log(`${SETTINGS_LOG} resolved latest stable buildId=${buildId} from ${downloadUrl}`);

  const installDir = path.join(CHROME_REL_DIR, buildId);
  fs.mkdirSync(installDir, { recursive: true });

  let lastPct = -1;
  const onProgress = (downloaded: number, total: number) => {
    if (!total) return;
    const pct = Math.floor((downloaded / total) * 100);
    if (pct !== lastPct && pct % 10 === 0) {
      console.log(
        `${SETTINGS_LOG} download progress: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB)`,
      );
      lastPct = pct;
    }
  };

  // Hard cap on the whole install. The download itself is fast, but the
  // post-install `setup.exe` step on Windows can block on UAC in a
  // non-interactive process — we'd rather fail loudly than hang the server.
  const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
  const installPromise = browsers.install({
    browser: browsers.Browser.CHROME,
    buildId,
    platform,
    cacheDir: installDir,
    downloadProgressCallback: onProgress,
  });
  let installTimer: NodeJS.Timeout | undefined;
  const installTimeout = new Promise<never>((_, reject) => {
    installTimer = setTimeout(
      () =>
        reject(
          new ChromeManagerError(
            `browsers.install() did not complete within ${INSTALL_TIMEOUT_MS / 1000}s; ` +
              `this usually means the post-install setup.exe is waiting for UAC elevation ` +
              `in a non-interactive process. The bundle may already be extracted at ` +
              `${installDir} — try a fresh run, the discovery code will pick it up.`,
          ),
        ),
      INSTALL_TIMEOUT_MS,
    );
  });
  const result = await Promise.race([installPromise, installTimeout]);
  if (installTimer) clearTimeout(installTimer);

  // `result.executablePath` is the absolute path to the chrome binary inside
  // the cacheDir we passed. The structure is:
  //   <installDir>/chrome/<platform>-<buildId>/chrome-<platform>/chrome(.exe)
  const installedAbsolute = result.executablePath;
  if (!fs.existsSync(installedAbsolute)) {
    throw new ChromeManagerError(
      `Chrome for Testing install reported success but binary is missing at ${installedAbsolute}`,
    );
  }

  // Expose the binary under the spec-mandated name (chrome_binary / chrome_binary.exe).
  // It MUST live in the same directory as chrome.dll, *.pak, icudtl.dat, etc. —
  // Chrome resolves its module path with GetModuleFileName and looks up
  // supporting files relative to it. So we copy into the bundle dir, not up at
  // the buildId level.
  const bundleDir = path.dirname(installedAbsolute);
  const ext = process.platform === 'win32' ? '.exe' : '';
  const canonicalName = `chrome_binary${ext}`;
  const canonicalPath = path.join(bundleDir, canonicalName);
  fs.copyFileSync(installedAbsolute, canonicalPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(canonicalPath, 0o755);
  }

  console.log(`${SETTINGS_LOG} downloaded Chrome for Testing to ${canonicalPath}`);
  return canonicalPath;
}

/**
 * Look under bin/chrome/ for a Chrome-for-Testing bundle that was extracted
 * by a previous run. Returns the canonical binary path (chrome_binary[.exe])
 * if found, or `null` otherwise.
 *
 * Why this exists: `@puppeteer/browsers` calls `setup.exe
 * --configure-browser-in-directory=...` on Windows after extraction, and that
 * step blocks indefinitely on UAC elevation in a non-interactive child
 * process. If we already have the bundle on disk from a previous run, we'd
 * rather reuse it than re-run install() and hang forever.
 */
function findExistingLocalChrome(): string | null {
  if (!fs.existsSync(CHROME_REL_DIR)) return null;
  const ext = process.platform === 'win32' ? '.exe' : '';
  const targetName = `chrome_binary${ext}`;

  // bin/chrome/<buildId>/chrome-<platform>/chrome_binary[.exe] — the layout
  // produced by @puppeteer/browsers when cacheDir is set to bin/chrome/<buildId>.
  // We scan recursively and pick the most recently modified match.
  let best: { path: string; mtime: number } | null = null;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === targetName) {
        try {
          const st = fs.statSync(full);
          if (!best || st.mtimeMs > best.mtime) {
            best = { path: full, mtime: st.mtimeMs };
          }
        } catch {
          // unreadable — skip
        }
      }
    }
  };
  walk(CHROME_REL_DIR);
  return best?.path ?? null;
}

/**
 * Resolve a usable Chrome executable path. Idempotent — the first call runs
 * the full discovery flow; subsequent calls return the cached path. Concurrent
 * callers share the same in-flight promise so we don't race the download.
 */
export async function ensureChrome(): Promise<string> {
  if (cachedChromePath && isValidChromePath(cachedChromePath)) {
    return cachedChromePath;
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Step 1: load settings.
    const settings = loadSettings();
    if (settings) {
      console.log(
        `${SETTINGS_LOG} loading settings: chromePath=${settings.chromePath}, ` +
          `chromeSource=${settings.chromeSource}, lastValidatedAt=${settings.lastValidatedAt}`,
      );
    } else {
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
      console.log(
        `${SETTINGS_LOG} stored path ${settings.chromePath} is no longer valid; re-discovering`,
      );
    }

    // Step 2.5: scan bin/chrome/ for a previously-extracted Chrome-for-Testing
    // bundle. @puppeteer/browsers' post-install `setup.exe` step can hang
    // indefinitely on Windows (it triggers a UAC prompt that never resolves in
    // a non-interactive process), so we never want to re-enter `install()` if
    // the bundle is already on disk from a prior run.
    const existingLocal = findExistingLocalChrome();
    if (existingLocal) {
      console.log(
        `${SETTINGS_LOG} reusing already-extracted Chrome-for-Testing at ${existingLocal}`,
      );
      cachedChromePath = existingLocal;
      recordSettings(existingLocal, 'local');
      return cachedChromePath;
    }

    // Step 3: detect a system Chrome.
    if (process.platform === 'win32' || process.platform === 'darwin') {
      const sysPath = await findSystemChrome();
      if (sysPath) {
        cachedChromePath = sysPath;
        recordSettings(sysPath, 'system');
        return cachedChromePath;
      }
      console.log(
        `${SETTINGS_LOG} no system Chrome found on ${process.platform}; falling back to download`,
      );
    } else {
      console.log(
        `${SETTINGS_LOG} platform ${process.platform} has no system detection; downloading directly`,
      );
    }

    // Step 4: download.
    const dlPath = await downloadChromeForTesting();
    cachedChromePath = dlPath;
    recordSettings(dlPath, 'local');
    return cachedChromePath;
  })().catch((err) => {
    initPromise = null;
    throw new ChromeManagerError(
      `Could not locate or download Chrome for Testing after all recovery attempts: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  });

  return initPromise;
}

/**
 * Return the path resolved by the most recent successful `ensureChrome()`,
 * or `null` if `ensureChrome` hasn't been called yet (which the server startup
 * gate should prevent).
 */
export function getChromePath(): string | null {
  return cachedChromePath;
}
