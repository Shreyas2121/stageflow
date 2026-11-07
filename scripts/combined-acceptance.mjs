import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Real HTTP/Socket.IO workflow, using only the caller's disposable API/database/namespace. */
export async function verifyCombinedRoomFlows({ json, io, address, ack, eventually, guest }) {
  const sockets = [];
  const email = `acceptance-${randomUUID()}@example.test`;
  const password = 'acceptance-fixture-password-123';
  const owner = await json('/sessions/register', undefined, {
    displayName: 'Acceptance host',
    email,
    password,
  });
  const signedIn = await json('/sessions/login', undefined, { email, password });
  assert.equal(signedIn.userId, owner.userId);
  const connect = async (token) => {
    const socket = io(address, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
      forceNew: true,
    });
    sockets.push(socket);
    const state = { socket, snapshot: undefined, credential: undefined, publicBoards: [] };
    socket.on('room:state', (snapshot) => {
      state.snapshot = snapshot;
    });
    socket.on('room:resume-credential', (payload) => {
      state.credential = payload.resumeCredential;
    });
    socket.on('qa:state', (board) => state.publicBoards.push(board));
    await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Acceptance socket connection timed out.')),
        5000,
      );
      socket.once('connect', () => {
        clearTimeout(timer);
        done();
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.connect();
    });
    return state;
  };
  const join = async (state, room, synthetic = false) => {
    const result = await ack(state.socket, 'room:join', {
      roomId: room.id,
      isAudioMuted: false,
      isVideoOff: false,
      isSyntheticBot: synthetic,
    });
    assert.equal(result.ok, true);
    state.participantId = result.participantId;
    state.credential ??= result.resumeCredential;
    await eventually(() =>
      state.snapshot?.participants.some((p) => p.participantId === result.participantId),
    );
    return result;
  };
  const schedule = (mode, requireAdmission = false) =>
    json('/rooms', signedIn.token, {
      title: `Acceptance ${mode}`,
      mode,
      status: 'SCHEDULED',
      scheduledStartAt: new Date(Date.now() - 60000).toISOString(),
      requireAdmission,
    });
  const current = (state) =>
    state.snapshot.participants.find((p) => p.participantId === state.participantId);
  try {
    const meeting = await schedule('MEETING', true);
    assert.equal(meeting.status, 'SCHEDULED');
    const host = await connect(signedIn.token),
      member = await connect(guest.token);
    await join(host, meeting);
    await join(member, meeting);
    assert.equal(current(member).role, 'WAITING');
    assert.deepEqual(member.snapshot.stageParticipantIds, []);
    assert.equal(member.credential, undefined);
    assert.equal(
      (await ack(member.socket, 'qa:submit', { text: 'Not admitted' })).error,
      'qa_not_allowed',
    );
    assert.equal((await ack(host.socket, 'room:start')).ok, true);
    await eventually(() => host.snapshot?.status === 'LIVE');
    assert.equal(host.snapshot.stageParticipantIds.length, 1);
    assert.equal(
      (await ack(host.socket, 'stage:admit', { targetParticipantId: member.participantId })).ok,
      true,
    );
    await eventually(() => current(member)?.role === 'SPEAKER' && Boolean(member.credential));

    const chat = { requestId: randomUUID(), text: 'Combined acceptance chat' };
    assert.equal((await ack(member.socket, 'chat:send', chat)).ok, true);
    assert.equal((await ack(member.socket, 'chat:send', chat)).ok, true);
    assert.equal((await ack(member.socket, 'chat:history')).messages.length, 1);
    assert.equal((await ack(host.socket, 'chat:set-paused', { paused: true })).ok, true);
    assert.equal(
      (await ack(member.socket, 'chat:send', { requestId: randomUUID(), text: 'Paused' })).error,
      'chat_paused',
    );
    assert.equal((await ack(host.socket, 'chat:set-paused', { paused: false })).ok, true);
    const submitted = await ack(member.socket, 'qa:submit', { text: 'Keep my vote on resume?' });
    assert.equal(submitted.ok, true);
    const questionId = submitted.questions[0].id;
    const voted = await ack(member.socket, 'qa:vote', { questionId });
    assert.deepEqual(voted.votedQuestionIds, [questionId]);
    assert.equal((await ack(member.socket, 'qa:vote', { questionId })).questions[0].voteCount, 1);
    assert.equal(
      (await ack(host.socket, 'qa:feature', { questionId })).featured.questionId,
      questionId,
    );
    assert.equal((await ack(host.socket, 'broadcast:start')).error, 'broadcast_not_available');

    for (let i = 0; i < 2; i++) {
      const bot = await json('/sessions/guest', undefined, {
        displayName: `Acceptance demo ${i + 1}`,
      });
      await join(await connect(bot.token), meeting, true);
    }
    const extra = await json('/sessions/guest', undefined, {
      displayName: 'Acceptance waiting user',
    });
    const waiting = await connect(extra.token);
    await join(waiting, meeting);
    assert.equal(current(waiting).role, 'WAITING');
    assert.equal(
      (await ack(host.socket, 'stage:admit', { targetParticipantId: waiting.participantId })).error,
      'stage_full',
    );
    const resumeCredential = member.credential;
    member.socket.disconnect();
    await eventually(() =>
      host.snapshot?.participants.some(
        (p) => p.participantId === member.participantId && p.presence === 'suspended',
      ),
    );
    assert.equal(host.snapshot.stageParticipantIds.length, 4);
    assert.equal(
      (await ack(host.socket, 'stage:admit', { targetParticipantId: waiting.participantId })).error,
      'stage_full',
    );
    const resumed = await connect(guest.token);
    const response = await ack(resumed.socket, 'room:resume', {
      roomId: meeting.id,
      participantId: member.participantId,
      resumeCredential,
    });
    assert.equal(response.ok, true);
    assert.equal(response.connectionGeneration, 2);
    assert.equal(response.snapshot.stageParticipantIds.length, 4);
    assert.deepEqual((await ack(resumed.socket, 'qa:state')).votedQuestionIds, [questionId]);
    const restoredHistory = await ack(resumed.socket, 'chat:history');
    assert.equal(restoredHistory.messages.length, 1);
    assert.equal(restoredHistory.messages[0].text, chat.text);
    assert(host.publicBoards.every((board) => !('votedQuestionIds' in board)));
    assert.deepEqual(
      (await json('/rooms', signedIn.token)).items.map((room) => room.id),
      [meeting.id],
    );
    assert.equal((await ack(host.socket, 'room:leave')).ok, true);
    await eventually(
      async () => (await json(`/rooms/${meeting.slug}`, signedIn.token)).status === 'ENDED',
    );

    const cancelled = await schedule('WEBINAR');
    const cancelHost = await connect(signedIn.token),
      cancelGuest = await connect(guest.token);
    await join(cancelHost, cancelled);
    await join(cancelGuest, cancelled);
    assert.equal(current(cancelGuest).role, 'WAITING');
    assert.equal((await ack(cancelHost.socket, 'room:cancel')).ok, true);
    assert.equal((await json(`/rooms/${cancelled.slug}`, signedIn.token)).status, 'ENDED');
    assert.deepEqual((await json(`/rooms/${cancelled.slug}/broadcasts`, signedIn.token)).items, []);

    const webinar = await schedule('WEBINAR');
    const webinarHost = await connect(signedIn.token),
      attendee = await connect(guest.token);
    await join(webinarHost, webinar);
    await join(attendee, webinar);
    assert.equal((await ack(webinarHost.socket, 'room:start')).ok, true);
    await eventually(() => current(attendee)?.role === 'ATTENDEE');
    assert.equal(current(attendee).isAudioMuted, true);
    assert.equal(current(attendee).isVideoOff, true);
    assert.equal(attendee.snapshot.stageParticipantIds.length, 1);
    assert.equal(
      (
        await ack(attendee.socket, 'webrtc:ice-candidate', {
          toParticipantId: webinarHost.participantId,
          candidate: null,
        })
      ).ok,
      false,
    );
    const q = await ack(attendee.socket, 'qa:submit', { text: 'Featured webinar question' });
    assert.equal(q.ok, true);
    assert.equal(
      (await ack(webinarHost.socket, 'qa:feature', { questionId: q.questions[0].id })).featured
        .text,
      'Featured webinar question',
    );
    assert.deepEqual((await json(`/rooms/${webinar.slug}/broadcasts`, signedIn.token)).items, []);
    assert.equal((await ack(webinarHost.socket, 'room:leave')).ok, true);
    console.log(
      'Combined protocol acceptance passed: registered login/library, scheduled meeting Start/wait/admit, four seats including suspension and demo peers, chat dedup/pause/history, private Q&A votes across resume, meeting broadcast refusal, scheduled Cancel, webinar attendee isolation and feature without recording.',
    );
  } finally {
    for (const socket of sockets) socket.disconnect();
  }
}
