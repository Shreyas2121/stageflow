local target, error = hostTarget()
if error then return reject(error) end
if target.role ~= 'ATTENDEE' then return reject('not_attendee') end
if stageCount() >= 4 then return reject('stage_full') end
target.role = 'SPEAKER'
target.isHandRaised = false
saveParticipant(target.socketId)
setHand(target.socketId, nil)
setStage(target.socketId, true)
return finish(true)
