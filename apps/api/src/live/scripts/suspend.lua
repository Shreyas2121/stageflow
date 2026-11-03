local participant = participants[command.participantId]
if not participant then return reject('participant_not_found') end
if participant.isSyntheticBot then removeMember(command.participantId); return finish(true) end
if participant.presence == 'suspended' then return finish(false) end
redis.call('HDEL', transportsKey, participant.socketId)
participant.presence = 'suspended'
participant.socketId = cjson.null
participant.isAudioMuted = true
participant.isVideoOff = true
participant.isScreenSharing = false
deadlines[command.participantId] = (command.now or 0) + 20000
dirtyDeadlines[command.participantId] = true
saveParticipant(command.participantId)
if participant.role == 'HOST' then
  local bots = {}
  for id, member in pairs(participants) do if member.isSyntheticBot then bots[#bots + 1] = id end end
  for _, id in ipairs(bots) do removeMember(id) end
end
return finish(true)
