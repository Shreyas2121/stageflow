local participant = participants[command.participantId]
if not participant then return reject('participant_not_found') end
if not stage[command.participantId] then
  if command.patch.isAudioMuted == false or command.patch.isVideoOff == false or command.patch.isScreenSharing == true then return reject('not_on_stage') end
  local changed = participant.isAudioMuted ~= true or participant.isVideoOff ~= true or participant.isScreenSharing ~= false
  participant.isAudioMuted = true
  participant.isVideoOff = true
  participant.isScreenSharing = false
  if changed then saveParticipant(command.participantId) end
  return finish(changed)
end
if command.patch.isAudioMuted == false and participant.hostAudioLocked then return reject('audio_locked') end
if command.patch.isVideoOff == false and participant.hostVideoLocked then return reject('video_locked') end
local changed = false
for _, key in ipairs({ 'isAudioMuted', 'isVideoOff', 'isScreenSharing' }) do
  local value = command.patch[key]
  if value ~= nil and value ~= participant[key] then
    participant[key] = value
    changed = true
  end
end
if changed then saveParticipant(command.participantId) end
return finish(changed)
