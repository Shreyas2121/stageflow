import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@stageflow/shared';
import { Button } from '../../components/ui/button';
import { formatChatTime, getChatTimeContext } from './format-chat-time';

type TimeContext = ReturnType<typeof getChatTimeContext>;

function useChatTimeContext(): TimeContext {
  const [context, setContext] = useState(getChatTimeContext);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      const next = getChatTimeContext();
      setContext((previous) =>
        previous.day === next.day &&
        previous.locale === next.locale &&
        previous.timeZone === next.timeZone
          ? previous
          : next,
      );
      clearTimeout(timer);
      // Minute boundaries include local midnight, without rerendering on every clock tick.
      timer = setTimeout(refresh, 60_000 - (Date.now() % 60_000));
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('languagechange', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('languagechange', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return context;
}

const ChatLine = memo(function ChatLine({
  message,
  context,
}: {
  message: ChatMessage;
  context: TimeContext;
}) {
  const time = formatChatTime(message.sentAt, context.now, context.locale, context.timeZone);
  return (
    <li>
      <p className="m-0 text-xs text-muted wrap-anywhere">
        <span className="font-semibold text-ink">{message.displayName}</span>{' '}
        <span>
          {message.role === 'HOST' ? 'Host' : message.role === 'SPEAKER' ? 'Speaker' : 'Attendee'}
        </span>
        {time && (
          <>
            {' '}
            <time dateTime={time.dateTime}>{time.text}</time>
          </>
        )}
      </p>
      <p className="mt-1 mb-0 text-sm whitespace-pre-wrap wrap-anywhere">{message.text}</p>
    </li>
  );
});

export const ChatTranscript = memo(function ChatTranscript({
  messages,
  loading,
}: {
  messages: ChatMessage[];
  loading: boolean;
}) {
  const context = useChatTimeContext();
  const logId = useId();
  const log = useRef<HTMLDivElement>(null);
  const atLatest = useRef(true);
  const lastSequence = useRef(0);
  const [unread, setUnread] = useState(0);

  useLayoutEffect(() => {
    const element = log.current;
    const latest = messages.at(-1)?.sequence ?? 0;
    const added = messages.filter((message) => message.sequence > lastSequence.current).length;
    lastSequence.current = latest;
    if (!element || !added) return;
    if (atLatest.current) element.scrollTop = element.scrollHeight;
    else setUnread((count) => count + added);
  }, [messages]);

  return (
    <>
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
          {messages.map((message) => (
            <ChatLine key={message.sequence} message={message} context={context} />
          ))}
        </ol>
        {!loading && messages.length === 0 && (
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
    </>
  );
});
