/**
 * Pairing key for devices other than the PC running the server. QR codes and the OBS URL carry it in the
 * fragment (`#k=…`), which never reaches the server or the Referer; it is kept per device so reloading
 * the bare URL keeps working, and removed from the address bar.
 */
const STORAGE_KEY = 'lenspipe.pairing-token';
const LEGACY_STORAGE_KEY = 'camera-link.pairing-token';
let cached: string | null | undefined;

export function pairingToken(): string | null {
  if (cached !== undefined) return cached;
  const fromUrl = new URLSearchParams((globalThis.location?.hash || '').slice(1)).get('k');
  if (fromUrl) {
    try { localStorage.setItem(STORAGE_KEY, fromUrl); } catch { /* private mode: the URL still works */ }
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* keep the URL as is */ }
    cached = fromUrl;
    return cached;
  }
  try {
    cached = localStorage.getItem(STORAGE_KEY);
    if (!cached) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        cached = legacy;
        try { localStorage.setItem(STORAGE_KEY, legacy); } catch { /* ignore */ }
      }
    }
  } catch { cached = null; }
  return cached;
}

/** Remember a key learned from the server (pages opened on the PC itself). */
export function rememberPairingToken(token: string): void {
  cached = token;
  try { localStorage.setItem(STORAGE_KEY, token); } catch { /* not persisted */ }
}

export function withPairingToken(url: string): string {
  const token = pairingToken();
  return token ? `${url}#k=${encodeURIComponent(token)}` : url;
}

/** Close code the server uses for an unpaired device (see server/pairing.ts). */
export const PAIRING_REQUIRED_CLOSE_CODE = 4401;
