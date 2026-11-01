local participant = participants[command.socketId]
if not participant then return reject('participant_not_found') end
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
return finish(changed)
