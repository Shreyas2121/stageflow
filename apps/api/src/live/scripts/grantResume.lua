-- Server-only credential metadata: never changes membership or stage revision.
local command = cjson.decode(ARGV[1])
local raw = redis.call('HGET', KEYS[2], command.participantId)
if not raw then return 0 end
local p = cjson.decode(raw)
if p.role ~= 'ATTENDEE' and redis.call('SISMEMBER', KEYS[3], command.participantId) ~= 1 then return 0 end
if p.presence ~= 'connected' or p.isSyntheticBot or p.connectionGeneration ~= command.generation then return 0 end
local previous = redis.call('HGET', KEYS[8], command.participantId)
if previous and previous ~= command.digest then return 0 end
redis.call('HSET', KEYS[8], command.participantId, command.digest)
redis.call('EXPIRE', KEYS[8], 86400)
return 1
