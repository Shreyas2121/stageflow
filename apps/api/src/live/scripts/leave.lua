-- Ending intent outlives the host participant so a later leave can finish shutdown.
if redis.call('EXISTS', endingKey) == 1 then
  redis.call('EXPIRE', endingKey, 86400)
  return finish(false, true)
end
if room.status == 'ENDED' then return finish(false, true) end
local participant = participants[command.participantId]
if not participant then return finish(false) end
if participant.role == 'HOST' then
  redis.call('SET', endingKey, '1', 'EX', 86400)
  participants, stage, hands = {}, {}, {}
  clearRoom = true
  return finish(true, true)
end
participants[command.participantId] = nil
if participant.socketId ~= cjson.null then redis.call('HDEL', transportsKey, participant.socketId) end
saveParticipant(command.participantId)
setStage(command.participantId, false)
setHand(command.participantId, nil)
return finish(true)
