local participant = participants[command.socketId]
if not participant then return finish(false) end
if participant.role == 'HOST' then
  participants, stage, hands = {}, {}, {}
  return finish(true, true)
end
participants[command.socketId] = nil
stage[command.socketId] = nil
hands[command.socketId] = nil
return finish(true)
