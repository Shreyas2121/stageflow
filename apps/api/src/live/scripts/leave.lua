-- Ending intent outlives the host participant so a later leave can finish shutdown.
if redis.call('GET', endingKey) == '1' then
  redis.call('EXPIRE', endingKey, 86400)
  return finish(false, true)
end
if room.status == 'ENDED' then return finish(false, true) end
local participant = participants[command.participantId]
if not participant then return finish(false) end
if participant.role == 'HOST' and room.status ~= 'SCHEDULED' then
  endRoom()
  return finish(true, true)
end
local freed = stage[command.participantId]
removeMember(command.participantId)
if freed then fillWaiting() end
return finish(true)
