import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveAppPaths } from '../server/paths.js';

const cwd = resolve('/repo/lenspipe');
const homeDir = resolve('/users/alice');

// CLI/dev mode keeps repo-local certs, diagnostics, and dist.
const cli = resolveAppPaths({ env: {}, platform: 'win32', homeDir, cwd });
assert.equal(cli.desktop, false);
assert.equal(cli.dataDir, cwd);
assert.equal(cli.certsDir, resolve(cwd, 'certs'));
assert.equal(cli.diagnosticsDir, resolve(cwd, 'diagnostics'));
assert.equal(cli.distDir, resolve(cwd, 'dist'));

// Windows desktop mode uses APPDATA/LensPipe, or falls back to homeDir/AppData/Roaming/LensPipe.
const winAppData = resolve('/users/alice/AppData/Roaming');
const winDesktop = resolveAppPaths({ env: { LENSPIPE_DESKTOP: '1', APPDATA: winAppData }, platform: 'win32', homeDir, cwd });
assert.equal(winDesktop.desktop, true);
assert.equal(winDesktop.dataDir, resolve(winAppData, 'LensPipe'));
assert.equal(winDesktop.certsDir, resolve(winAppData, 'LensPipe', 'certs'));
assert.equal(winDesktop.diagnosticsDir, resolve(winAppData, 'LensPipe', 'diagnostics'));

const winFallback = resolveAppPaths({ env: { LENSPIPE_DESKTOP: 'true' }, platform: 'win32', homeDir, cwd });
assert.equal(winFallback.desktop, true);
assert.equal(winFallback.dataDir, resolve(homeDir, 'AppData', 'Roaming', 'LensPipe'));

// macOS desktop mode uses ~/Library/Application Support/LensPipe.
const macDesktop = resolveAppPaths({ env: { LENSPIPE_DESKTOP: 'true' }, platform: 'darwin', homeDir, cwd });
assert.equal(macDesktop.desktop, true);
assert.equal(macDesktop.dataDir, resolve(homeDir, 'Library', 'Application Support', 'LensPipe'));
assert.equal(macDesktop.certsDir, resolve(homeDir, 'Library', 'Application Support', 'LensPipe', 'certs'));

// Linux desktop mode honors XDG_DATA_HOME and falls back to ~/.local/share/lenspipe.
const xdgData = resolve('/custom/xdg');
const linuxXdg = resolveAppPaths({ env: { LENSPIPE_DESKTOP: '1', XDG_DATA_HOME: xdgData }, platform: 'linux', homeDir, cwd });
assert.equal(linuxXdg.desktop, true);
assert.equal(linuxXdg.dataDir, resolve(xdgData, 'lenspipe'));

const linuxFallback = resolveAppPaths({ env: { LENSPIPE_DESKTOP: '1' }, platform: 'linux', homeDir, cwd });
assert.equal(linuxFallback.dataDir, resolve(homeDir, '.local', 'share', 'lenspipe'));

// Explicit LENSPIPE_DATA_DIR and LENSPIPE_DIST_DIR overrides apply in both CLI and desktop mode.
const customData = resolve('/tmp/lenspipe-data');
const customDist = resolve('/tmp/lenspipe-dist');
const override = resolveAppPaths({
  env: { LENSPIPE_DESKTOP: '1', LENSPIPE_DATA_DIR: customData, LENSPIPE_DIST_DIR: customDist },
  platform: 'win32',
  homeDir,
  cwd,
});
assert.equal(override.dataDir, customData);
assert.equal(override.certsDir, resolve(customData, 'certs'));
assert.equal(override.diagnosticsDir, resolve(customData, 'diagnostics'));
assert.equal(override.distDir, customDist);

console.log('Paths test passed: CLI defaults, Windows/macOS/Linux desktop user data folders, and env overrides resolve cleanly.');
