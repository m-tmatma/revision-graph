// Build script for the extension host bundle and the webview bundles (main
// graph UI, its layout worker, the compare panel, the checkout dialog).
// Kept as a single script since all targets share the same watch/production
// flags.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function copyHtmlTemplates() {
  fs.mkdirSync(path.join(__dirname, 'dist', 'webview'), { recursive: true });
  for (const name of ['panel.html', 'comparePanel.html', 'checkoutDialog.html', 'logPanel.html']) {
    fs.copyFileSync(path.join(__dirname, 'src', 'webview', name), path.join(__dirname, 'dist', 'webview', name));
  }
}

// Baked into the extension bundle as __BUILD_COMMIT__ (see extension.ts) so
// the Activity Bar's log sidebar can show which exact commit is running —
// the point being to tell a stale Extension Development Host or installed
// build apart from a fresh one at a glance, which a package.json version
// number alone (bumped only at release time) can't do.
function getCommitHash() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
  } catch {
    return 'unknown';
  }
}

// GITHUB_RUN_NUMBER is only set when this build runs inside a GitHub Actions
// workflow (see .github/workflows/ci.yml, which already names its vsix
// artifact `...-build${{ github.run_number }}`) — empty for every local
// build (F5, npm run build/package), so the welcome view only shows a build
// number when one's actually meaningful.
const buildNumber = process.env.GITHUB_RUN_NUMBER ?? '';

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  define: {
    __BUILD_COMMIT__: JSON.stringify(getCommitHash()),
    __BUILD_NUMBER__: JSON.stringify(buildNumber),
  },
};

/** @type {import('esbuild').BuildOptions} */
const webviewMainConfig = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  outfile: 'dist/webview/main.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
};

/** @type {import('esbuild').BuildOptions} */
const layoutWorkerConfig = {
  entryPoints: ['src/webview/layoutWorker.ts'],
  bundle: true,
  outfile: 'dist/webview/layoutWorker.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
};

/** @type {import('esbuild').BuildOptions} */
const compareConfig = {
  entryPoints: ['src/webview/compare.ts'],
  bundle: true,
  outfile: 'dist/webview/compare.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
};

/** @type {import('esbuild').BuildOptions} */
const checkoutDialogConfig = {
  entryPoints: ['src/webview/checkoutDialog.ts'],
  bundle: true,
  outfile: 'dist/webview/checkoutDialog.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
};

/** @type {import('esbuild').BuildOptions} */
const logPanelConfig = {
  entryPoints: ['src/webview/log.ts'],
  bundle: true,
  outfile: 'dist/webview/log.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
};

async function main() {
  const configs = [
    extensionConfig,
    webviewMainConfig,
    layoutWorkerConfig,
    compareConfig,
    checkoutDialogConfig,
    logPanelConfig,
  ];
  copyHtmlTemplates();

  if (watch) {
    const contexts = await Promise.all(configs.map((cfg) => esbuild.context(cfg)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));

    // esbuild's own watch only rebuilds the bundled JS/TS entry points --
    // the HTML templates are a plain file copy with no build step, so
    // esbuild never notices one changed on disk while `npm run watch` is
    // running. Re-copy on any .html change in src/webview so editing a
    // template doesn't silently require restarting watch to take effect.
    fs.watch(path.join(__dirname, 'src', 'webview'), (_eventType, filename) => {
      if (!filename || !filename.endsWith('.html')) return;
      try {
        copyHtmlTemplates();
      } catch (err) {
        // An editor's atomic save (write-temp, then rename over the target)
        // can fire this event while the source is momentarily missing
        // (ENOENT) -- letting that throw out of an fs.watch callback would
        // crash `npm run watch` entirely. Leaving it uncopied here is safe:
        // the save's own follow-up event (or the next edit) retries it.
        console.warn(`esbuild.js: failed to re-copy HTML templates (${err.message}), will retry on the next change`);
      }
    });

    console.log('watching for changes...');
  } else {
    await Promise.all(configs.map((cfg) => esbuild.build(cfg)));
    console.log('build complete');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
