import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QaPanel, QaBanner } from './qa-panel';
import { QaSession } from './qa-session';
import { ack, board, question, transport } from './qa-test-fixtures';

async function setup() {
  const session = new QaSession();
  const wire = transport();
  session.connect(wire, 'self');
  await Promise.resolve();
  await Promise.resolve();
  return { session, wire };
}
describe('question panel', () => {
  it('omits pre-join and waiting sessions and uses the exact mode sentences', async () => {
    const idle = new QaSession();
    expect(renderToStaticMarkup(<QaPanel session={idle} host={false} mode="MEETING" />)).toBe('');
    const { session } = await setup();
    for (const [mode, sentence] of [
      [
        'WEBINAR',
        'Questions in this list are live. The question on the webinar video follows the broadcast delay.',
      ],
      ['MEETING', 'Questions in this list are live. A meeting does not record them.'],
    ] as const)
      expect(
        renderToStaticMarkup(<QaPanel session={session} host={false} mode={mode} />),
      ).toContain(sentence);
    session.suspend(false);
    expect(renderToStaticMarkup(<QaPanel session={session} host={false} mode="WEBINAR" />)).toBe(
      '',
    );
  });
  it('renders literal text and counts, a featured marker and banner, and host-only controls', async () => {
    const { session } = await setup();
    session.receive({
      ...board,
      featured: { questionId: '1', text: question.text, authorName: question.authorName },
    });
    const member = renderToStaticMarkup(<QaPanel session={session} host={false} mode="WEBINAR" />);
    expect(member).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(member).toContain('&lt;Sam&gt;');
    expect(member).not.toContain('<b>');
    expect(member).toContain('Featured');
    expect(member).toContain('Upvote (0)');
    for (const label of ['Close questions', 'Clear feature', '>Feature<', 'Dismiss'])
      expect(member).not.toContain(label);
    const host = renderToStaticMarkup(<QaPanel session={session} host mode="MEETING" />);
    for (const label of ['Close questions', 'Clear feature', '>Feature<', 'Dismiss'])
      expect(host).toContain(label);
    const banner = renderToStaticMarkup(<QaBanner session={session} />);
    expect(banner).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(banner).toContain('&lt;Sam&gt;');
    expect(banner).not.toContain('Upvote');
  });
  it('disables Ask for a pending ack and a closed board, marks voted rows, and stops controls after end', async () => {
    const { session, wire } = await setup();
    session.setDraft('Question');
    let finish!: (value: ReturnType<typeof ack>) => void;
    wire.qaSubmit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const sending = session.ask();
    expect(renderToStaticMarkup(<QaPanel session={session} host mode="MEETING" />)).toMatch(
      /<button[^>]*disabled=""[^>]*>Ask/,
    );
    finish(ack());
    await sending;
    await session.vote('1');
    const voted = renderToStaticMarkup(<QaPanel session={session} host mode="MEETING" />);
    expect(voted).toMatch(/<button[^>]*disabled=""[^>]*aria-pressed="true"/);
    session.receive({ ...board, submissionsOpen: false });
    const closed = renderToStaticMarkup(<QaPanel session={session} host mode="MEETING" />);
    expect(closed).toContain('Open questions');
    expect(closed).toContain('The host closed new questions.');
    expect(closed).toMatch(/<button[^>]*disabled=""[^>]*>Ask/);
    session.end();
    const ended = renderToStaticMarkup(<QaPanel session={session} host mode="MEETING" />);
    expect(ended).toContain('This room has ended. Questions are closed.');
    expect(ended).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(ended).not.toContain('>Ask<');
    expect(ended).not.toContain('>Dismiss<');
    expect(ended).not.toContain('>Clear feature<');
  });
});
