import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '../../components/ui/button';
import type { ChatSession } from './chat-session';
import { formatChatTime } from './format-chat-time';

export function ChatPanel({ session, host }: { session: ChatSession; host: boolean }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const sendLimitReached = session.sendLimitReached;
  const textareaId = useId();
  const sendLimitId = useId();
  const logId = useId();
  const log = useRef<HTMLDivElement>(null);
  const atLatest = useRef(true);
  const lastSequence = useRef(0);
  const [unread, setUnread] = useState(0);

  useLayoutEffect(() => {
    const element = log.current;
    const latest = state.messages.at(-1)?.sequence ?? 0;
    const added = state.messages.filter(
      (message) => message.sequence > lastSequence.current,
    ).length;
    lastSequence.current = latest;
    if (!element || !added) return;
    if (atLatest.current) element.scrollTop = element.scrollHeight;
    else setUnread((count) => count + added);
  }, [state.messages]);

  if (!session.visible) return null;
  return (
    <aside
      className="min-w-0 rounded-panel border border-line bg-surface p-5"
      aria-label="Room chat"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-lg font-medium">Room chat</h2>
        {host && state.phase === 'joined' && (
          <Button
            type="button"
            disabled={state.pausePending}
            onClick={() => void session.setPaused(!state.paused)}
          >
            {state.paused ? 'Resume chat' : 'Pause chat'}
          </Button>
        )}
      </div>
      <p className="mt-3 text-xs text-muted">
        Chat is live. It is not synced to the delayed video.
      </p>
      {state.retentionGap && (
        <p className="text-sm text-muted">Earlier messages are no longer available.</p>
      )}
      {state.paused && (
        <p className="text-sm" role="status">
          The host paused chat.
        </p>
      )}
      {state.phase === 'recovering' && (
        <p className="text-sm text-muted" role="status">
          Reconnecting. Chat is read only.
        </p>
      )}
      {state.phase === 'closed' && (
        <p className="text-sm" role="status">
          This room has ended. Chat is closed.
        </p>
      )}
      {state.loading && (
        <p className="text-sm text-muted" role="status">
          Loading recent messages…
        </p>
      )}
      <div
        id={logId}
        ref={log}
        role="region"
        aria-label="Chat messages"
        tabIndex={0}
        className="mt-4 max-h-96 min-h-32 overflow-y-auto overscroll-contain"
        onScroll={() => {
          const element = log.current;
          if (!element) return;
          atLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
          if (atLatest.current) setUnread(0);
        }}
      >
        <ol className="m-0 list-none space-y-4 p-0">
          {state.messages.map((message) => {
            const time = formatChatTime(message.sentAt, Date.now());
            return (
              <li key={message.sequence}>
                <p className="m-0 text-xs text-muted wrap-anywhere">
                  <span className="font-semibold text-ink">{message.displayName}</span>{' '}
                  <span>
                    {message.role === 'HOST'
                      ? 'Host'
                      : message.role === 'SPEAKER'
                        ? 'Speaker'
                        : 'Attendee'}
                  </span>
                  {time && (
                    <>
                      {' '}
                      <time dateTime={time.dateTime}>{time.text}</time>
                    </>
                  )}
                </p>
                <p className="mt-1 mb-0 text-sm whitespace-pre-wrap wrap-anywhere">
                  {message.text}
                </p>
              </li>
            );
          })}
        </ol>
        {!state.loading && state.messages.length === 0 && (
          <p className="text-sm text-muted">No messages yet.</p>
        )}
      </div>
      <div role="status" aria-live="polite">
        {unread > 0 && (
          <Button
            type="button"
            className="mt-3"
            aria-controls={logId}
            onClick={() => {
              if (log.current) log.current.scrollTop = log.current.scrollHeight;
              atLatest.current = true;
              setUnread(0);
            }}
          >
            {unread} new {unread === 1 ? 'message' : 'messages'}
          </Button>
        )}
      </div>
      {state.attempts.map((attempt) => (
        <div key={attempt.requestId} className="mt-3 rounded-control border border-line p-3">
          <p className="m-0 text-sm whitespace-pre-wrap wrap-anywhere">{attempt.text}</p>
          <p className="mt-1 text-xs text-muted" role="status">
            {attempt.status === 'pending' ? 'Sending…' : `Not sent. ${attempt.error}`}
          </p>
          {attempt.status === 'failed' && (
            <div className="flex gap-2">
              <Button
                type="button"
                disabled={!session.canSend}
                onClick={() => session.retry(attempt.requestId)}
              >
                Retry
              </Button>
              <Button type="button" onClick={() => session.dismiss(attempt.requestId)}>
                Dismiss
              </Button>
            </div>
          )}
        </div>
      ))}
      {state.error && (
        <div className="mt-3 text-sm text-danger" role="alert">
          <p>{state.error}</p>
          {state.phase === 'joined' && (
            <Button type="button" disabled={state.loading} onClick={() => void session.refresh()}>
              Refresh chat
            </Button>
          )}
        </div>
      )}
      {sendLimitReached && (
        <p id={sendLimitId} className="mt-3 text-sm text-danger" role="status">
          Unsent message limit reached. Retry or dismiss a message before sending more. Your draft
          is kept.
        </p>
      )}
      <form
        className="mt-4"
        onSubmit={(event) => {
          event.preventDefault();
          session.sendDraft();
        }}
      >
        <label className="mb-2 block text-xs font-semibold" htmlFor={textareaId}>
          Message the room
        </label>
        <textarea
          id={textareaId}
          rows={3}
          value={state.draft}
          disabled={!session.canSend}
          aria-describedby={sendLimitReached ? sendLimitId : undefined}
          className="w-full resize-y rounded-control border border-input-line bg-control p-3 text-sm disabled:opacity-60"
          onChange={(event) => session.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              session.sendDraft();
            }
          }}
        />
        <Button
          type="submit"
          variant="primary"
          className="mt-2"
          disabled={!session.canSend || !state.draft.trim() || sendLimitReached}
        >
          Send
        </Button>
      </form>
    </aside>
  );
}
