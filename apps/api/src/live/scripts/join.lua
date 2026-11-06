if command.now then expiryChanged, expiryEnded = expireOverdue(command.now) end
if expiryEnded then return reject('room_ended') end
if room.status == 'ENDED' or redis.call('GET', endingKey) == '1' then return reject('room_ended') end
for id, participant in pairs(participants) do
  if participant.userId == command.userId or id == command.participantId or participant.socketId == command.socketId then return reject('already_joined') end
end
local isHost = command.userId == room.hostId
local scheduled = room.status == 'SCHEDULED'
if command.isSyntheticBot then
  local hostOnStage = false
  for id, p in pairs(participants) do if p.role == 'HOST' and stage[id] then hostOnStage = true end end
  if scheduled or not hostOnStage then return reject('demo_not_ready') end
end
if not scheduled and room.mode == 'MEETING' and not isHost then
  local hostPresent = false
  for _, participant in pairs(participants) do
    if participant.role == 'HOST' then hostPresent = true end
  end
  if not hostPresent then return reject('host_not_present') end
end
local isWaiting = not isHost and (scheduled or (room.mode == 'MEETING' and room.requireAdmission == true and not command.isSyntheticBot))
if isWaiting then
  local count = 0
  for _ in pairs(waiting) do count = count + 1 end
  if count >= 100 then return reject('waiting_full') end
end
expiryChanged = fillWaiting() or expiryChanged
local onStage = not scheduled and not isWaiting and (isHost or room.mode == 'MEETING')
if onStage and stageCount() >= 4 then return reject('stage_full') end
participants[command.participantId] = {
  participantId = command.participantId, userId = command.userId, displayName = command.displayName,
  socketId = command.socketId, connectionGeneration = 1, presence = 'connected',
  role = isHost and 'HOST' or (isWaiting and 'WAITING' or (onStage and 'SPEAKER' or 'ATTENDEE')),
  isAudioMuted = not onStage or command.isAudioMuted, isVideoOff = not onStage or command.isVideoOff,
  isSyntheticBot = command.isSyntheticBot, joinedAt = command.joinedAt,
  isScreenSharing = false, isHandRaised = false, hostAudioLocked = false, hostVideoLocked = false
}
saveParticipant(command.participantId)
redis.call('HSET', transportsKey, command.socketId, command.participantId)
if not scheduled and not isWaiting and not command.isSyntheticBot and command.resumeDigest then
  resumeDigests[command.participantId] = command.resumeDigest
  dirtyResume[command.participantId] = true
end
if onStage then setStage(command.participantId, true) end
if isWaiting then setWaiting(command.participantId, command.joinedAt) end
return finish(true)
