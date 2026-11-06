local actor = participants[command.actorParticipantId]
if not actor or actor.role ~= 'HOST' or actor.presence ~= 'connected' then return reject('not_host') end
if catalogStatus ~= 'SCHEDULED' then return reject('already_started') end
if lifecycle == 'started' then return finish(false) end
if room.status == 'ENDED' or lifecycle == '1' then return reject('room_ended') end
room.status = 'LIVE'
setStage(actor.participantId, true)
redis.call('SET', endingKey, 'started', 'EX', 86400)
if room.mode == 'WEBINAR' then
  for id in pairs(waiting) do
    participants[id].role = 'ATTENDEE'
    saveParticipant(id)
    setWaiting(id, nil)
  end
else fillWaiting() end
return finish(true)
