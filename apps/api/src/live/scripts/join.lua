if room.status == 'ENDED' or redis.call('EXISTS', endingKey) == 1 then return reject('room_ended') end
for id, participant in pairs(participants) do
  if participant.userId == command.userId or id == command.socketId then return reject('already_joined') end
end
local isHost = command.userId == room.hostId
if room.mode == 'MEETING' and not isHost then
  local hostPresent = false
  for _, participant in pairs(participants) do
    if participant.role == 'HOST' then hostPresent = true end
  end
  if not hostPresent then return reject('host_not_present') end
end
local onStage = isHost or room.mode == 'MEETING'
if onStage and stageCount() >= 4 then return reject('stage_full') end
participants[command.socketId] = {
  socketId = command.socketId, userId = command.userId, displayName = command.displayName,
  role = isHost and 'HOST' or (onStage and 'SPEAKER' or 'ATTENDEE'),
  isAudioMuted = command.isAudioMuted, isVideoOff = command.isVideoOff,
  isSyntheticBot = command.isSyntheticBot, joinedAt = command.joinedAt,
  isScreenSharing = false, isHandRaised = false, hostAudioLocked = false, hostVideoLocked = false
}
saveParticipant(command.socketId)
if onStage then setStage(command.socketId, true) end
return finish(true)
