import os from 'node:os';
import { resolve } from 'node:path';

export interface AppPaths {
  desktop: boolean;
  dataDir: string;
  certsDir: string;
  diagnosticsDir: string;
  distDir: string;
}

export interface ResolveAppPathsOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  cwd?: string;
}

/**
 * Resolves runtime paths for both CLI/repo launches (default `./certs`, `./diagnostics`, `./dist`)
 * and packaged desktop mode (`LENSPIPE_DESKTOP=1`, writing mutable data under the OS app-data folder).
 */
export function resolveAppPaths(options: ResolveAppPathsOptions = {}): AppPaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();

  const desktop = env.LENSPIPE_DESKTOP === '1' || env.LENSPIPE_DESKTOP === 'true';
  const distDir = env.LENSPIPE_DIST_DIR ? resolve(env.LENSPIPE_DIST_DIR) : resolve(cwd, 'dist');

  let dataDir: string;
  if (env.LENSPIPE_DATA_DIR) {
    dataDir = resolve(env.LENSPIPE_DATA_DIR);
  } else if (desktop) {
    if (platform === 'win32') {
      dataDir = resolve(env.APPDATA || resolve(homeDir, 'AppData', 'Roaming'), 'LensPipe');
    } else if (platform === 'darwin') {
      dataDir = resolve(homeDir, 'Library', 'Application Support', 'LensPipe');
    } else {
      dataDir = resolve(env.XDG_DATA_HOME || resolve(homeDir, '.local', 'share'), 'lenspipe');
    }
  } else {
    dataDir = resolve(cwd);
  }

  return {
    desktop,
    dataDir,
    certsDir: resolve(dataDir, 'certs'),
    diagnosticsDir: resolve(dataDir, 'diagnostics'),
    distDir,
  };
}
