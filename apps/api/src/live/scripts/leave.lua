-- Ending intent outlives the host participant so a later leave can finish shutdown.
if redis.call('EXISTS', endingKey) == 1 then
  redis.call('EXPIRE', endingKey, 86400)
  return finish(false, true)
end
if room.status == 'ENDED' then return finish(false, true) end
local participant = participants[command.socketId]
if not participant then return finish(false) end
if participant.role == 'HOST' then
  redis.call('SET', endingKey, '1', 'EX', 86400)
  participants, stage, hands = {}, {}, {}
  clearRoom = true
  return finish(true, true)
end
participants[command.socketId] = nil
saveParticipant(command.socketId)
setStage(command.socketId, false)
setHand(command.socketId, nil)
return finish(true)
