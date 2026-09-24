const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';
const TOKEN_KEY = 'nextpm.token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

/**
 * Fired when the API rejects the session mid-use — an expired token, or an account an
 * administrator deactivated or deleted while it was signed in.
 *
 * This module cannot touch React state, and must not import the auth store (that would be a
 * cycle), so it announces the rejection and `AuthProvider` is the one that clears the session.
 * Routing is then left to `RequireAuth`: dropping the user is what sends the app to /login.
 */
export const UNAUTHORIZED_EVENT = 'nextpm:unauthorized';

function rejectSession() {
  tokenStore.clear();
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = tokenStore.get();
  const isForm = init.body instanceof FormData;

  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 401) rejectSession();

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new ApiError(response.status, payload?.error?.message ?? response.statusText, payload?.error?.details);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
  /** Downloads a binary/text file (docx, html...) and saves it via the browser, bypassing JSON parsing. */
  download: async (path: string, fallbackFileName: string, method: 'GET' | 'POST' = 'GET') => {
    const token = tokenStore.get();
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      if (response.status === 401) rejectSession();
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      throw new ApiError(response.status, payload?.error?.message ?? response.statusText, payload?.error?.details);
    }
    // Prefer RFC 5987 `filename*` — it is the only form that carries a non-ASCII name intact,
    // since plain `filename` lives in a latin1 HTTP header.
    const disposition = response.headers.get('content-disposition') ?? '';
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const plain = /filename="([^"]+)"/.exec(disposition);
    const fileName = encoded ? decodeURIComponent(encoded[1]) : (plain?.[1] ?? fallbackFileName);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return { fileName, count: Number(response.headers.get('x-document-count')) || null };
  },
  /**
   * A `blob:` URL for a file behind the API, which an `<iframe>` or `<img>` can load directly.
   *
   * This exists because a file URL cannot simply be put in `src` or `href`. The API authenticates
   * with a Bearer token held in `localStorage`, and any plain browser-issued request — a link, an
   * iframe, an image — carries no headers, so it is answered
   * `{"error":{"message":"Authentication required"}}` instead of the file.
   *
   * The caller owns the URL and must `URL.revokeObjectURL` it when the view goes away.
   */
  objectUrl: async (path: string) => {
    const token = tokenStore.get();
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      if (response.status === 401) rejectSession();
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      throw new ApiError(response.status, payload?.error?.message ?? response.statusText, payload?.error?.details);
    }
    return URL.createObjectURL(await response.blob());
  },
  /**
   * Opens such a file in a new tab, for the browser's own viewer to render it.
   *
   * The tab is opened **before** the await on purpose: a `window.open` after an async gap has lost
   * the user's click and pop-up blockers stop it.
   */
  openInTab: async (path: string) => {
    const tab = window.open('', '_blank');
    try {
      const url = await api.objectUrl(path);
      if (tab) tab.location.href = url;
      else window.location.href = url;
      // Revoking straight away would pull the blob out from under the tab before it has loaded it;
      // the browser frees it with the page anyway, this just stops it leaking for the whole session.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      tab?.close();
      throw error;
    }
  },
};
