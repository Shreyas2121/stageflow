local participant, error = authorize(false)
if error then return cjson.encode({ ok = false, error = error }) end
if redis.call('GET', submissionsKey) == '0' then return cjson.encode({ ok = false, error = 'qa_closed' }) end
if redis.call('HLEN', questionsKey) >= command.boardMax then return cjson.encode({ ok = false, error = 'qa_full' }) end
local error = acceptRate(submitRoomKey, submitUserKey, command.submitParticipantLimit, command.submitRoomLimit, 'qa_rate_limited')
if error then return cjson.encode({ ok = false, error = error }) end
redis.call('INCR', seqKey)
local id = redis.call('GET', seqKey)
redis.call('HSET', questionsKey, id, cjson.encode({
  id = id, text = command.text, authorName = participant.displayName,
  authorParticipantId = binding.participantId, createdAt = command.now
}))
refreshTtl()
return state()
