import { useId, useSyncExternalStore } from 'react';
import type { RoomMode } from '@stageflow/shared';
import { Button } from '../../components/ui/button';
import type { QaSession } from './qa-session';

export function QaBanner({ session }: { session: QaSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  if (!session.visible || !state.featured) return null;
  return (
    <aside
      aria-label="Featured question"
      className="mb-5 rounded-control border border-line p-4 wrap-anywhere"
    >
      <p className="text-xs text-muted">Featured · {state.featured.authorName}</p>
      <p>{state.featured.text}</p>
    </aside>
  );
}

export function QaPanel({
  session,
  host,
  mode,
}: {
  session: QaSession;
  host: boolean;
  mode: RoomMode;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const inputId = useId();
  if (!session.visible) return null;
  const active = session.canAct;
  const closed = state.phase === 'closed';
  return (
    <aside
      aria-label="Questions"
      className="mt-5 min-w-0 rounded-panel border border-line bg-surface p-5"
    >
      <h2 className="text-lg font-medium">Questions</h2>
      <p className="text-xs text-muted">
        {mode === 'WEBINAR'
          ? 'Questions in this list are live. The question on the webinar video follows the broadcast delay.'
          : 'Questions in this list are live. A meeting does not record them.'}
      </p>
      {closed ? (
        <p role="status">This room has ended. Questions are closed.</p>
      ) : (
        <>
          {state.phase === 'recovering' && <p role="status">Reconnecting questions.</p>}
          {!state.ready && !state.pending && (
            <Button type="button" onClick={() => void session.refresh()}>
              Retry questions
            </Button>
          )}
          <form
            className="my-4 grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void session.ask();
            }}
          >
            <label htmlFor={inputId}>Your question</label>
            <input
              id={inputId}
              value={state.draft}
              onChange={(event) => session.setDraft(event.target.value)}
              disabled={!active || !state.submissionsOpen}
              className="min-w-0 rounded-control border border-line bg-control p-3"
            />
            <Button type="submit" disabled={!active || !state.submissionsOpen}>
              Ask
            </Button>
          </form>
          {!state.submissionsOpen && <p>The host closed new questions.</p>}
          {host && (
            <div className="my-3 flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={!active}
                onClick={() => void session.setSubmissions(!state.submissionsOpen)}
              >
                {state.submissionsOpen ? 'Close questions' : 'Open questions'}
              </Button>
              <Button type="button" disabled={!active} onClick={() => void session.clearFeature()}>
                Clear feature
              </Button>
            </div>
          )}
        </>
      )}
      {state.error && <p role="alert">{state.error}</p>}
      <ul className="grid list-none gap-4 p-0">
        {state.questions.map((question) => (
          <li key={question.id} className="rounded-control border border-line p-3 wrap-anywhere">
            <p className="text-xs text-muted">{question.authorName}</p>
            <p>{question.text}</p>
            {state.featured?.questionId === question.id && (
              <p className="text-xs font-semibold">Featured</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={!active || state.votedQuestionIds.includes(question.id)}
                aria-pressed={state.votedQuestionIds.includes(question.id)}
                onClick={() => void session.vote(question.id)}
              >
                Upvote ({question.voteCount})
              </Button>
              {host && !closed && (
                <>
                  <Button
                    type="button"
                    disabled={!active}
                    onClick={() => void session.feature(question.id)}
                  >
                    Feature
                  </Button>
                  <Button
                    type="button"
                    disabled={!active}
                    onClick={() => void session.dismiss(question.id)}
                  >
                    Dismiss
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
