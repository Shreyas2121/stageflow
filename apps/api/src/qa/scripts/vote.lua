local participant, error = authorize(false)
if error then return cjson.encode({ ok = false, error = error }) end
if redis.call('HEXISTS', questionsKey, command.questionId) == 0 then return cjson.encode({ ok = false, error = 'qa_missing' }) end
local votesKey = votesPrefix .. command.questionId
if redis.call('SISMEMBER', votesKey, binding.participantId) == 1 then
  refreshTtl()
  return state()
end
local error = acceptRate(voteRoomKey, voteUserKey, command.voteParticipantLimit, command.voteRoomLimit, 'qa_vote_rate_limited')
if error then return cjson.encode({ ok = false, error = error }) end
redis.call('SADD', votesKey, binding.participantId)
refreshTtl()
return state()
