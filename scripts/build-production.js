#!/usr/bin/env node
/* eslint-disable no-console */
//
// Build a production-only copy of the project under ./prod_build/.
//
// The prod_build/ directory contains everything needed to run the service
// (`npm run start` -> `node dist/server.js`) but no source code:
//   - package.json (rewritten, with only production deps and a `start`
//     script that installs dependencies in-place on first run)
//   - dist/                  (compiled JS from `tsc`)
//   - chrome-devtools-mcp/   (LICENSE, package.json, and build/ only — the
//                             build/ folder is the pre-built stdio server;
//                             its inner node_modules is pruned because the
//                             top-level node_modules in prod_build will
//                             resolve them via Node's standard upward walk)
//   - bin/                   (downloaded Chrome for Testing, if present)
//   - README.md
//
// Source files, .claude/, tsconfig.json, and the root node_modules/ are
// intentionally NOT copied. After staging, the user runs:
//
//     cd prod_build
//     npm run start        # installs node_modules in prod_build/ then starts
//

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve('E:\\Experiments\\Mendix-Testing-MCP\\chrome-devtools-mcp-development');

const SRC_PKG = require(path.join(ROOT, 'package.json'));
const CDM_PKG_PATH = path.join(ROOT, 'chrome-devtools-mcp', 'package.json');

// ---- helpers --------------------------------------------------------------

function rimraf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest, opts = {}) {
  if (!fs.existsSync(src)) {
    if (opts.optional) return;
    throw new Error(`copyDir: source does not exist: ${src}`);
  }
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (opts.skip && opts.skip.includes(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d, opts);
    } else if (entry.isFile()) {
      ensureDir(path.dirname(d));
      fs.copyFileSync(s, d);
    } else if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(s);
      ensureDir(path.dirname(d));
      try {
        fs.symlinkSync(link, d);
      } catch {
        const stat = fs.statSync(s);
        if (stat.isDirectory()) copyDir(s, d, opts);
        else fs.copyFileSync(s, d);
      }
    }
  }
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

// ---- preflight ------------------------------------------------------------

function preflight() {
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) {
    console.error(
      '[build:production] dist/ is missing. Run `npm run build` first.',
    );
    process.exit(1);
  }
  const cdmBuild = path.join(ROOT, 'chrome-devtools-mcp', 'build', 'src', 'index.js');
  if (!fs.existsSync(cdmBuild)) {
    console.error(
      `[build:production] chrome-devtools-mcp build artifact missing: ${cdmBuild}`,
    );
    console.error(
      '  The bundled stdio server must be built before staging.',
    );
    process.exit(1);
  }
}

// ---- staging --------------------------------------------------------------

function stage() {
  console.log(`[build:production] staging into ${path.relative(ROOT, OUT) || '.'}`);

  rimraf(OUT);
  ensureDir(OUT);

  // 1) package.json — production-only deps + start script + prestart install.
  const prodPkg = buildProdPackageJson();
  fs.writeFileSync(
    path.join(OUT, 'package.json'),
    JSON.stringify(prodPkg, null, 2) + '\n',
    'utf8',
  );
  console.log('  + package.json');

  // 2) dist/ — compiled output.
  copyDir(path.join(ROOT, 'dist'), path.join(OUT, 'dist'));
  console.log('  + dist/');

  // 3) chrome-devtools-mcp/ — build artifacts + package.json + LICENSE.
  //    IMPORTANT: keep the inner build/node_modules/chrome-devtools-frontend
  //    directory. third_party/index.js (and the two worker files) import
  //    it via a *relative* path: '../../node_modules/chrome-devtools-frontend/mcp/mcp.js'.
  //    Relative imports bypass Node's upward node_modules walk, so the file
  //    MUST physically exist at that path. The bundle is ~12 MB.
  //    Everything else in build/node_modules (if any) is dropped — bare
  //    specifiers used by the stdio child are resolved via the upward walk
  //    into prod_build/node_modules.
  const cdmOut = path.join(OUT, 'chrome-devtools-mcp');
  ensureDir(cdmOut);
  copyFile(CDM_PKG_PATH, path.join(cdmOut, 'package.json'));
  const cdmLicense = path.join(ROOT, 'chrome-devtools-mcp', 'LICENSE');
  if (fs.existsSync(cdmLicense)) {
    copyFile(cdmLicense, path.join(cdmOut, 'LICENSE'));
  }
  copyDir(
    path.join(ROOT, 'chrome-devtools-mcp', 'build'),
    path.join(cdmOut, 'build'),
    { skip: ['node_modules'] },
  );
  // Re-attach the vendored chrome-devtools-frontend bundle the stdio child
  // imports via a relative path.
  const cdmFrontendSrc = path.join(
    ROOT,
    'chrome-devtools-mcp',
    'build',
    'node_modules',
    'chrome-devtools-frontend',
  );
  if (fs.existsSync(cdmFrontendSrc)) {
    copyDir(
      cdmFrontendSrc,
      path.join(cdmOut, 'build', 'node_modules', 'chrome-devtools-frontend'),
    );
    console.log('  + chrome-devtools-mcp/  (build/, package.json, LICENSE, build/node_modules/chrome-devtools-frontend/)');
  } else {
    console.log('  + chrome-devtools-mcp/  (build/, package.json, LICENSE)');
  }

  // 4) bin/ — downloaded Chrome for Testing (optional, gitignored).
  const binSrc = path.join(ROOT, 'bin');
  if (fs.existsSync(binSrc)) {
    copyDir(binSrc, path.join(OUT, 'bin'));
    console.log('  + bin/');
  }

  // 5) README — same user-facing docs.
  const readme = path.join(ROOT, 'README.md');
  if (fs.existsSync(readme)) {
    copyFile(readme, path.join(OUT, 'README.md'));
    console.log('  + README.md');
  }

  // 6) .gitignore — keeps prod_build's own bin/chrome/ etc. out of VCS.
  const gitignore = [
    'node_modules/',
    'bin/chrome/',
    '.env',
    '.env.local',
    '*.log',
    'settings.json',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, '.gitignore'), gitignore, 'utf8');
  console.log('  + .gitignore');
}

// Runtime deps of the bundled chrome-devtools-mcp stdio child.
//
// These are NOT imported by localProxy itself — they live in the dev
// project's root node_modules/ as transitive deps of mcp-proxy / express
// / @modelcontextprotocol/sdk. The vendored build/ inside prod_build
// imports them by bare specifier (see build/src/third_party/index.js),
// so the staged prod_build/package.json must declare them directly.
// Otherwise, copying prod_build/ to a fresh machine and running
// `npm run start` would fail with MODULE_NOT_FOUND when the stdio child
// boots.
//
// Versions are pinned to what the dev project's package-lock.json has
// resolved, so the production tree is reproducible.
//
// Why an explicit list rather than "follow what dev has installed":
// the user may run `npm prune --omit=dev` in the dev project at any
// point, which would not delete these (they're transitive) — but it's
// still brittle. Declaring them as direct deps in prod_build/ is
// self-documenting and survives any prune / dedupe in the dev project.
const CHROME_DEVTOOLS_MCP_RUNTIME_DEPS = Object.freeze({
  '@modelcontextprotocol/sdk': '1.29.0',
  '@puppeteer/browsers': '3.0.4',
  'puppeteer-core': '25.1.0',
  yargs: '18.0.0',
  semver: '7.8.2',
  debug: '4.4.3',
  zod: '4.4.3',
  ajv: '8.20.0',
  'urlpattern-polyfill': '10.1.0',
  'core-js': '3.49.0',
});

function buildProdPackageJson() {
  // localProxy's own runtime deps + chrome-devtools-mcp's runtime deps.
  // devDependencies and the explanatory comment key are dropped.
  const prodDeps = {
    ...SRC_PKG.dependencies,
    ...CHROME_DEVTOOLS_MCP_RUNTIME_DEPS,
  };

  return {
    name: SRC_PKG.name || 'local-proxy',
    version: SRC_PKG.version || '1.0.0',
    private: true,
    description:
      'Production build of localProxy. Generated by `npm run build:production` from the dev project. Contains compiled output only — no source code.',
    main: 'dist/server.js',
    scripts: {
      // Install production deps inside prod_build/ on first run, then start
      // the compiled server. Re-running `npm run start` skips install when
      // node_modules/ is already present.
      prestart:
        "node -e \"const fs=require('fs');if(!fs.existsSync('node_modules')){console.log('[start] installing production dependencies in prod_build/...');require('child_process').execSync('npm install --omit=dev --no-audit --no-fund',{stdio:'inherit'})}else{console.log('[start] node_modules/ already present, skipping install.')}\"",
      start: 'node dist/server.js',
    },
    engines: SRC_PKG.engines || { node: '>=22.12' },
    dependencies: prodDeps,
  };
}

// ---- entrypoint -----------------------------------------------------------

function main() {
  preflight();
  stage();
  console.log('');
  console.log('[build:production] done.');
  console.log('  To run the production build:');
  console.log('    cd prod_build');
  console.log('    npm run start');
}

main();
