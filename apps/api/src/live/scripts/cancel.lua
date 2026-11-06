local actor = participants[command.actorParticipantId]
if not actor or actor.role ~= 'HOST' or actor.presence ~= 'connected' then return reject('not_host') end
if room.status ~= 'SCHEDULED' then return reject('not_scheduled') end
endRoom()
return finish(true, true)
