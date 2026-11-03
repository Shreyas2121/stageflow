local target, error = hostTarget()
if error then return reject(error) end
local lock = command.kind == 'audio' and 'hostAudioLocked' or 'hostVideoLocked'
local flag = command.kind == 'audio' and 'isAudioMuted' or 'isVideoOff'
local changed = target[lock] ~= command.locked or (command.locked and not target[flag])
target[lock] = command.locked
if command.locked then target[flag] = true end
if changed then saveParticipant(target.participantId) end
return finish(changed)
