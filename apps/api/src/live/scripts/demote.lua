local target, error = hostTarget()
if error then return reject(error) end
if target.role == 'HOST' then return reject('cannot_demote_host') end
if target.role ~= 'SPEAKER' then return reject('not_speaker') end
target.role = 'ATTENDEE'
target.isHandRaised = false
hands[target.socketId] = nil
stage[target.socketId] = nil
return finish(true)
