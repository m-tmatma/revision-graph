// Build script for the extension host bundle and the webview bundles (main
// graph UI, its layout worker, the compare panel, the checkout dialog).
// Kept as a single script since all targets share the same watch/production
// flags.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function copyHtmlTemplates() {
  fs.mkdirSync(path.join(__dirname, 'dist', 'webview'), { recursive: true });
  for (const name of ['panel.html', 'comparePanel.html', 'checkoutDialog.html']) {
    fs.copyFileSync(path.join(__dirname, 'src', 'webview', name), path.join(__dirname, 'dist', 'webview', name));
  }
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

async function main() {
  const configs = [extensionConfig, webviewMainConfig, layoutWorkerConfig, compareConfig, checkoutDialogConfig];
  copyHtmlTemplates();

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
