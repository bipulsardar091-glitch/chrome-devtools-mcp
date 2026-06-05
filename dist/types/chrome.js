"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SETTINGS_PATH = void 0;
exports.loadSettings = loadSettings;
exports.saveSettings = saveSettings;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
exports.DEFAULT_SETTINGS_PATH = node_path_1.default.resolve(process.cwd(), 'settings.json');
/**
 * Read the persisted settings. Returns `null` if the file is missing or
 * unparseable — callers should treat that as "no stored Chrome" and run the
 * full discovery + download flow.
 */
function loadSettings(settingsPath = exports.DEFAULT_SETTINGS_PATH) {
    try {
        const raw = node_fs_1.default.readFileSync(settingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.chromePath === 'string' &&
            typeof parsed.chromeSource === 'string' &&
            (parsed.chromeSource === 'system' || parsed.chromeSource === 'local') &&
            typeof parsed.lastValidatedAt === 'string') {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Write the settings file atomically. The caller is responsible for passing a
 * normalized absolute `chromePath`.
 */
function saveSettings(settings, settingsPath = exports.DEFAULT_SETTINGS_PATH) {
    const dir = node_path_1.default.dirname(settingsPath);
    node_fs_1.default.mkdirSync(dir, { recursive: true });
    const tmp = `${settingsPath}.tmp`;
    node_fs_1.default.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    node_fs_1.default.renameSync(tmp, settingsPath);
}
//# sourceMappingURL=chrome.js.map