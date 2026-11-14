/**
 * API & Google Sheets Relay configuration utility.
 * Supports:
 * 1. Private Google Apps Script Web App Relay (VITE_APPS_SCRIPT_URL or runtime settings)
 * 2. Hosted HTTPS Express Proxy (VITE_API_BASE_URL or web same-origin /api)
 * Zero localhost or secret keys hardcoded for native Android APK builds.
 */

export function isNativeCapacitorRuntime(): boolean {
  try {
    if (typeof window !== 'undefined') {
      const cap = (window as any).Capacitor;
      if (cap && typeof cap.isNativePlatform === 'function') {
        return Boolean(cap.isNativePlatform());
      }
      if (window.location?.protocol === 'capacitor:' || window.location?.protocol === 'file:') {
        return true;
      }
    }
  } catch {
    // Ignore access errors
  }
  return false;
}

export function safeGetLocalStorage(key: string): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(key);
    }
  } catch {
    // Storage access blocked or restricted
  }
  return null;
}

export function safeSetLocalStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch {
    // Storage access blocked or restricted
  }
}

export function safeRemoveLocalStorage(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
    }
  } catch {
    // Storage access blocked or restricted
  }
}

export function isLocalhostUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(url.trim());
}

export function getApiBaseUrl(): string {
  const runtimeUrl = safeGetLocalStorage('stgorge_api_base_url');
  if (runtimeUrl && runtimeUrl.trim()) {
    const cleaned = runtimeUrl.trim().replace(/\/$/, '');
    if (!isNativeCapacitorRuntime() || !isLocalhostUrl(cleaned)) {
      return cleaned;
    }
  }

  const envUrl = (import.meta as any).env?.VITE_API_BASE_URL;
  if (typeof envUrl === 'string' && envUrl.trim()) {
    const cleaned = envUrl.trim().replace(/\/$/, '');
    if (!isNativeCapacitorRuntime() || !isLocalhostUrl(cleaned)) {
      return cleaned;
    }
  }

  return '';
}

export function setApiBaseUrl(url: string): boolean {
  const cleaned = url.trim().replace(/\/$/, '');
  if (!cleaned) {
    safeRemoveLocalStorage('stgorge_api_base_url');
    return true;
  }
  if (isLocalhostUrl(cleaned) || !/^https:\/\//i.test(cleaned)) {
    return false;
  }
  safeSetLocalStorage('stgorge_api_base_url', cleaned);
  return true;
}

export function getAppsScriptUrl(): string {
  const runtimeUrl = safeGetLocalStorage('stgorge_apps_script_url');
  if (runtimeUrl && /^https:\/\/script\.google\.com\/macros\/s\/[^\s]+\/exec(?:\?.*)?$/i.test(runtimeUrl.trim())) {
    return runtimeUrl.trim();
  }

  const envUrl = (import.meta as any).env?.VITE_APPS_SCRIPT_URL;
  if (typeof envUrl === 'string' && /^https:\/\/script\.google\.com\/macros\/s\/[^\s]+\/exec(?:\?.*)?$/i.test(envUrl.trim())) {
    return envUrl.trim();
  }

  return '';
}

export function setAppsScriptUrl(url: string): boolean {
  const cleaned = url.trim();
  if (!cleaned) {
    safeRemoveLocalStorage('stgorge_apps_script_url');
    return true;
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^\s]+\/exec(?:\?.*)?$/i.test(cleaned)) {
    return false;
  }
  safeSetLocalStorage('stgorge_apps_script_url', cleaned);
  return true;
}

export function getRelayKey(): string {
  return (safeGetLocalStorage('stgorge_relay_key') || '').trim();
}

export function setRelayKey(key: string): void {
  const cleaned = key.trim();
  if (!cleaned) {
    safeRemoveLocalStorage('stgorge_relay_key');
  } else {
    safeSetLocalStorage('stgorge_relay_key', cleaned);
  }
}

export function hasConfiguredRemoteBackend(): boolean {
  if (getAppsScriptUrl()) return true;
  if (getApiBaseUrl()) return true;
  if (!isNativeCapacitorRuntime()) {
    if (typeof window !== 'undefined' && /^https?:$/i.test(window.location?.protocol || '')) {
      return true;
    }
  }
  return false;
}

export function buildApiUrl(endpoint: string): string {
  const base = getApiBaseUrl();
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return base ? `${base}${normalizedEndpoint}` : normalizedEndpoint;
}

export function getAuthHeaders(token?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // The shared Apps Script relay key is sent only in the Apps Script request
  // body. It is not an Express identity and must never be forwarded as auth.
  return headers;
}
