export function serviceUrl(value: unknown, key: string): string {
  const message = `Set ${key} to an absolute HTTP(S) URL and restart the web app.`;
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(message);
  return url.href.replace(/\/$/, '');
}
export const apiUrl = () => serviceUrl(import.meta.env.VITE_API_BASE_URL, 'VITE_API_BASE_URL');
export const signalingUrl = () => serviceUrl(import.meta.env.VITE_WS_URL, 'VITE_WS_URL');
