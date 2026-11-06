local expiredSelf = participants[command.participantId] and participants[command.participantId].presence == 'suspended'
  and deadlines[command.participantId] and command.now and deadlines[command.participantId] <= command.now
if command.now then expiryChanged, expiryEnded = expireOverdue(command.now) end
if expiryEnded or room.status == 'ENDED' or redis.call('GET', endingKey) == '1' then return reject('room_ended') end
if expiredSelf then return reject('resume_expired') end
local participant = participants[command.participantId]
if not participant then return reject('participant_not_found') end
if participant.userId ~= command.userId or participant.isSyntheticBot or not resumeDigests[command.participantId] or resumeDigests[command.participantId] ~= command.resumeDigest then return reject('invalid_resume') end
if participant.connectionGeneration ~= command.expectedGeneration then return reject('resume_lost') end
if participant.presence == 'connected' then return reject('already_connected') end
for _, member in pairs(participants) do if member.socketId == command.socketId then return reject('already_joined') end end
participant.presence = 'connected'
participant.socketId = command.socketId
participant.connectionGeneration = participant.connectionGeneration + 1
participant.isAudioMuted = true
participant.isVideoOff = true
participant.isScreenSharing = false
saveParticipant(command.participantId)
redis.call('HSET', transportsKey, command.socketId, command.participantId)
if deadlines[command.participantId] then deadlines[command.participantId] = nil; dirtyDeadlines[command.participantId] = true end
return finish(true)
