import { existsSync } from 'node:fs';

/** Chrome/Chromium used by the browser-driven scripts. Override with CHROME_PATH. */
export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    win32: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  }[process.platform] || [];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH to your Chrome or Chromium executable.');
  return found;
}
