local target, error = hostTarget()
if error then return reject(error) end
if target.role == 'HOST' then return reject('cannot_demote_host') end
if target.role ~= 'SPEAKER' then return reject('not_speaker') end
target.role = 'ATTENDEE'
target.isAudioMuted = true
target.isVideoOff = true
target.isScreenSharing = false
target.isHandRaised = false
saveParticipant(target.participantId)
setHand(target.participantId, nil)
setStage(target.participantId, false)
return finish(true)
