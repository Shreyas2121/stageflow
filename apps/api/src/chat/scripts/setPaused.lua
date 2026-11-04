local command = cjson.decode(ARGV[1])
local binding = command.binding
local rawParticipant = redis.call('HGET', KEYS[7], binding.participantId)
if not rawParticipant then return cjson.encode({ ok = false, error = 'stale_transport' }) end
local participant = cjson.decode(rawParticipant)
if participant.presence ~= 'connected' or participant.socketId ~= binding.socketId or participant.connectionGeneration ~= binding.generation then
  return cjson.encode({ ok = false, error = 'stale_transport' })
end
if participant.role ~= 'HOST' then return cjson.encode({ ok = false, error = 'not_host' }) end

redis.call('SET', KEYS[3], command.paused and '1' or '0')
for i = 1, 6 do redis.call('EXPIRE', KEYS[i], command.ttlSeconds) end
return cjson.encode({ ok = true, value = { paused = command.paused } })
