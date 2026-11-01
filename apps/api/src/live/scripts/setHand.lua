local participant = participants[command.socketId]
if not participant then return reject('participant_not_found') end
if participant.role ~= 'ATTENDEE' then return reject('not_attendee') end
if participant.isHandRaised == command.raised then return finish(false) end
participant.isHandRaised = command.raised
saveParticipant(command.socketId)
setHand(command.socketId, command.raised and command.raisedAt or nil)
return finish(true)
