import fs from 'node:fs';
import path from 'node:path';

export type ChromeSource = 'system' | 'local';

export interface Settings {
  chromePath: string;
  chromeSource: ChromeSource;
  lastValidatedAt: string;
}

export const DEFAULT_SETTINGS_PATH = path.resolve(process.cwd(), 'settings.json');

/**
 * Read the persisted settings. Returns `null` if the file is missing or
 * unparseable — callers should treat that as "no stored Chrome" and run the
 * full discovery + download flow.
 */
export function loadSettings(settingsPath: string = DEFAULT_SETTINGS_PATH): Settings | null {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    if (
      typeof parsed.chromePath === 'string' &&
      typeof parsed.chromeSource === 'string' &&
      (parsed.chromeSource === 'system' || parsed.chromeSource === 'local') &&
      typeof parsed.lastValidatedAt === 'string'
    ) {
      return parsed as Settings;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write the settings file atomically. The caller is responsible for passing a
 * normalized absolute `chromePath`.
 */
export function saveSettings(settings: Settings, settingsPath: string = DEFAULT_SETTINGS_PATH): void {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${settingsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, settingsPath);
}
