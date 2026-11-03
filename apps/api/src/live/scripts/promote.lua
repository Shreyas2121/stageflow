local target, error = hostTarget()
if error then return reject(error) end
if target.role ~= 'ATTENDEE' then return reject('not_attendee') end
if target.presence ~= 'connected' then return reject('not_connected') end
if stageCount() >= 4 then return reject('stage_full') end
target.role = 'SPEAKER'
target.isHandRaised = false
saveParticipant(target.participantId)
setHand(target.participantId, nil)
setStage(target.participantId, true)
return finish(true)
