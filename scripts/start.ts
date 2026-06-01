import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { findChromePath, downloadChrome, promptYesNo } from "./ensure-chrome.ts";

async function main(): Promise<void> {
  console.log("Installing dependencies...");
  const install = spawnSync("npm install", {
    stdio: "inherit",
    shell: true,
    cwd: resolve(import.meta.dirname!, ".."),
  });
  if (install.status !== 0) {
    console.error("npm install failed.");
    process.exit(1);
  }

  console.log("Building project...");
  const build = spawnSync("npm run build", {
    stdio: "inherit",
    shell: true,
    cwd: resolve(import.meta.dirname!, ".."),
  });
  if (build.status !== 0) {
    console.error("Build failed.");
    process.exit(1);
  }

  // Import from build output after build is complete
  const [{ parseArguments }, { createMcpServer }, { VERSION }] =
    await Promise.all([
      import("../build/src/bin/chrome-devtools-mcp-cli-options.js"),
      import("../build/src/index.js"),
      import("../build/src/version.js"),
    ]);

  const serverArgs = parseArguments(VERSION);

  // Check Chrome: if system Chrome is found and user didn't download custom, let Puppeteer auto-detect
  const systemChrome = findChromePath();
  if (!systemChrome) {
    console.log("Chrome not found.");
    const wantsDownload = await promptYesNo(
      "Chrome is required. Would you like to download Chrome for Testing? (y/n): ",
    );
    if (!wantsDownload) {
      console.error("Chrome is required. Exiting.");
      process.exit(1);
    }
    const chromePath = await downloadChrome();
    serverArgs.executablePath = chromePath;
  } else {
    console.log(`Chrome found at: ${systemChrome}`);
    // Don't set executablePath — let Puppeteer auto-discover
  }

  console.log("Starting MCP server on port 4520...");
  const { server } = await createMcpServer(serverArgs, {});

  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const httpServer = createServer(async (req, res) => {
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("Request error:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  await server.connect(transport);

  httpServer.listen(4520, () => {
    console.log("MCP server listening on http://localhost:4520/mcp");
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await transport.close();
    httpServer.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    console.log("\nShutting down...");
    await transport.close();
    httpServer.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
