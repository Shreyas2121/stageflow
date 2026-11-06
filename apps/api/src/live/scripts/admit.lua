local actor = participants[command.actorParticipantId]
if not actor or actor.role ~= 'HOST' or actor.presence ~= 'connected' then return reject('not_host') end
if room.status ~= 'LIVE' or room.mode ~= 'MEETING' or room.requireAdmission ~= true then return reject('admission_off') end
local target = participants[command.targetParticipantId]
if not target or not waiting[target.participantId] then return reject('not_waiting') end
if stageCount() >= 4 then return reject('stage_full') end
target.role = 'SPEAKER'
saveParticipant(target.participantId)
setWaiting(target.participantId, nil)
setStage(target.participantId, true)
return finish(true)
