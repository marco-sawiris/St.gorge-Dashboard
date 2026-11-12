/**
 * API configuration utility
 * Supports external backend deployments (e.g. Render.com) when hosted on GitHub Pages
 */

export function getApiBaseUrl(): string {
  // Check Vite environment variable
  const envUrl = (import.meta as any).env?.VITE_API_BASE_URL;
  if (typeof envUrl === 'string' && envUrl.trim()) {
    return envUrl.trim().replace(/\/$/, '');
  }
  return '';
}

export function buildApiUrl(endpoint: string): string {
  const base = getApiBaseUrl();
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return base ? `${base}${normalizedEndpoint}` : normalizedEndpoint;
}

export function safeGetLocalStorage(key: string): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(key);
    }
  } catch {
    // Storage access blocked or restricted (e.g. private browsing, security sandbox)
  }
  return null;
}

export function getAuthHeaders(token?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };

  const authToken = token || safeGetLocalStorage('stgorge_jwt_token');
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  return headers;
}
