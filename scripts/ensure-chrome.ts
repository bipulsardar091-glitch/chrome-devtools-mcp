import { execSync, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { get } from "node:https";
import { get as httpGet } from "node:http";
import type { IncomingMessage } from "node:http";

export function findChromePath(): string | null {
  try {
    const result = execSync("where chrome", { stdio: "pipe", encoding: "utf-8" });
    const line = result.trim().split("\n")[0]?.trim();
    if (line) return line;
  } catch {
    // not found in PATH
  }

  try {
    const result = execSync("where google-chrome", {
      stdio: "pipe",
      encoding: "utf-8",
    });
    const line = result.trim().split("\n")[0]?.trim();
    if (line) return line;
  } catch {
    // not found in PATH
  }

  const paths = [
    join(process.env.ProgramFiles ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];

  for (const p of paths) {
    if (existsSync(p)) return p;
  }

  return null;
}

export function isChromeAvailable(): boolean {
  return findChromePath() !== null;
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const proto = url.startsWith("https") ? get : httpGet;
    function handle(res: IncomingMessage): void {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        file.close();
        rmSync(dest);
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
      file.on("error", reject);
    }
    proto(url, handle).on("error", reject);
  });
}

export async function downloadChrome(destDir?: string): Promise<string> {
  if (!destDir) {
    destDir = resolve(import.meta.dirname!, "..", "chrome");
  }
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

  const plat = platform();
  let osPart: string;

  if (plat === "win32") {
    osPart = "win64";
  } else if (plat === "darwin") {
    osPart = arch() === "arm64" ? "mac-arm64" : "mac-x64";
  } else {
    osPart = "linux64";
  }

  const version = "131.0.6778.85";
  const zipUrl = `https://storage.googleapis.com/chrome-for-testing-public/${version}/${osPart}/chrome-${osPart}.zip`;
  const zipPath = join(destDir, "chrome.zip");

  console.log(`Downloading ${zipUrl}...`);
  await download(zipUrl, zipPath);
  console.log("Extracting...");

  if (plat === "win32") {
    spawnSync(
      "PowerShell",
      [
        "-Command",
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
      { stdio: "inherit" },
    );
  } else {
    const child = spawnSync("unzip", ["-o", zipPath, "-d", destDir], {
      stdio: "inherit",
    });
    if (child.status !== 0) {
      throw new Error("unzip failed");
    }
  }

  rmSync(zipPath);

  if (plat === "win32") {
    return join(destDir, "chrome-win64", "chrome.exe");
  }
  if (plat === "darwin") {
    const dir = arch() === "arm64" ? "mac-arm64" : "mac-x64";
    return join(
      destDir,
      `chrome-${dir}`,
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    );
  }
  return join(destDir, "chrome-linux64", "chrome");
}

export async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

// Run as CLI
const isMain =
  process.argv[1]?.replace(/\\/g, "/").includes("ensure-chrome");

if (isMain) {
  const path = findChromePath();
  if (path) {
    console.log(path);
    process.exit(0);
  }

  console.log("Chrome not found.");
  const wantsDownload = await promptYesNo(
    "Chrome is required to run the MCP server. Would you like to download Chrome for Testing? (y/n): ",
  );
  if (!wantsDownload) {
    console.error("Chrome is required. Exiting.");
    process.exit(1);
  }

  const chromePath = await downloadChrome();
  console.log(chromePath);
  process.exit(0);
}
