import { useEffect, useState } from 'react';
import { apiUrl } from '../../config/env';
import { useSessionStore } from '../session/session-store';

function thumbnailRequestUrl(path: string): string | null {
  if (!path.startsWith('/api/broadcasts/') || /[\\?#]/.test(path)) return null;
  const base = new URL(apiUrl());
  const target = new URL(path, base.origin);
  if (
    target.origin !== base.origin ||
    target.pathname !== path ||
    target.search ||
    target.hash ||
    target.username ||
    target.password
  )
    return null;
  return target.href;
}

export function Thumbnail({
  url,
  token,
  status,
}: {
  url: string | null;
  token: string;
  status: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSrc(null);
    setFailed(false);
    if (!url) return;
    let requestUrl: string | null;
    try {
      requestUrl = thumbnailRequestUrl(url);
    } catch {
      requestUrl = null;
    }
    if (!requestUrl) {
      setFailed(true);
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(requestUrl, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (response.status === 401) useSessionStore.getState().clearSession(token);
        if (!response.ok) throw new Error('thumbnail');
        const blob = await response.blob();
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, token]);

  if (!url || failed || !src) {
    return (
      <span className="flex size-16 shrink-0 items-center justify-center rounded-control border border-line bg-surface px-1 text-center text-[10px] font-semibold tracking-wide">
        {status}
      </span>
    );
  }
  return <img src={src} alt="" className="size-16 shrink-0 rounded-control object-cover" />;
}
