// Build script for the extension host bundle and the two webview bundles
// (main UI thread + the layout worker). Kept as a single script since the
// three targets share the same watch/production flags.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function copyPanelHtml() {
  fs.mkdirSync(path.join(__dirname, 'dist', 'webview'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, 'src', 'webview', 'panel.html'),
    path.join(__dirname, 'dist', 'webview', 'panel.html'),
  );
}

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

async function main() {
  const configs = [extensionConfig, webviewMainConfig, layoutWorkerConfig];
  copyPanelHtml();

  if (watch) {
    const contexts = await Promise.all(configs.map((cfg) => esbuild.context(cfg)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
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
