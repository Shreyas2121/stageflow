-- Ending intent outlives the host participant so a later leave can finish shutdown.
if redis.call('EXISTS', endingKey) == 1 then
  redis.call('EXPIRE', endingKey, 86400)
  return finish(false, true)
end
if room.status == 'ENDED' then return finish(false, true) end
local participant = participants[command.participantId]
if not participant then return finish(false) end
if participant.role == 'HOST' then
  endRoom()
  return finish(true, true)
end
removeMember(command.participantId)
return finish(true)
