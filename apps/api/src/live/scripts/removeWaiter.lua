local actor = participants[command.actorParticipantId]
if not actor or actor.role ~= 'HOST' or actor.presence ~= 'connected' then return reject('not_host') end
local target = participants[command.targetParticipantId]
if not target or not waiting[target.participantId] then return reject('not_waiting') end
removeMember(target.participantId)
return finish(true)
