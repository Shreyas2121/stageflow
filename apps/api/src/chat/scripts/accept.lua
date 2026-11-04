-- Chat keys are independent of the stage scripts and their common.lua prelude.
local command = cjson.decode(ARGV[1])
local seqKey, messagesKey, pausedKey, dedupKey, roomRateKey, userRateKey, participantsKey = unpack(KEYS)
local binding = command.binding
local rawParticipant = redis.call('HGET', participantsKey, binding.participantId)
if not rawParticipant then return cjson.encode({ ok = false, error = 'stale_transport' }) end
local participant = cjson.decode(rawParticipant)
if participant.presence ~= 'connected' or participant.socketId ~= binding.socketId or participant.connectionGeneration ~= binding.generation then
  return cjson.encode({ ok = false, error = 'stale_transport' })
end

local paused = redis.call('GET', pausedKey) == '1'
local dedupId = binding.participantId .. ':' .. command.requestId
local duplicate = redis.call('HGET', dedupKey, dedupId)
if duplicate then return '{"ok":true,"value":' .. duplicate .. '}' end
if paused then return cjson.encode({ ok = false, error = 'chat_paused' }) end

local function rate(raw)
  if raw then
    local value = cjson.decode(raw)
    if command.now < value.startedAt + command.rateWindowMs then return value end
  end
  return { startedAt = command.now, count = 0 }
end
local roomRate = rate(redis.call('GET', roomRateKey))
local rawUserRate = redis.call('HGET', userRateKey, binding.participantId)
local userRate = rate(rawUserRate)
if userRate.count >= command.participantRateLimit or roomRate.count >= command.roomRateLimit then
  return cjson.encode({ ok = false, error = 'chat_rate_limited' })
end
if not rawUserRate and redis.call('HLEN', userRateKey) >= command.userRateMaxFields then
  -- Expired counters can be removed; a new sender never displaces an active counter.
  local fields = redis.call('HGETALL', userRateKey)
  for i = 1, #fields, 2 do
    local value = cjson.decode(fields[i + 1])
    if command.now >= value.startedAt + command.rateWindowMs then redis.call('HDEL', userRateKey, fields[i]) end
  end
  if redis.call('HLEN', userRateKey) >= command.userRateMaxFields then
    return cjson.encode({ ok = false, error = 'chat_busy' })
  end
end

local sequence = redis.call('INCR', seqKey)
local message = cjson.encode({
  sequence = sequence, participantId = binding.participantId,
  displayName = participant.displayName, role = participant.role,
  text = command.text, sentAt = command.now
})
redis.call('RPUSH', messagesKey, message)
redis.call('LTRIM', messagesKey, -command.retention, -1)
redis.call('HSET', dedupKey, dedupId, message)
if redis.call('HLEN', dedupKey) > command.dedupCapacity then
  local entries = redis.call('HGETALL', dedupKey)
  local oldestId, oldestSequence
  for i = 1, #entries, 2 do
    local entry = cjson.decode(entries[i + 1])
    if not oldestSequence or entry.sequence < oldestSequence then
      oldestId, oldestSequence = entries[i], entry.sequence
    end
  end
  redis.call('HDEL', dedupKey, oldestId)
end
roomRate.count, userRate.count = roomRate.count + 1, userRate.count + 1
redis.call('SET', roomRateKey, cjson.encode(roomRate))
redis.call('HSET', userRateKey, binding.participantId, cjson.encode(userRate))
for i = 1, 6 do redis.call('EXPIRE', KEYS[i], command.ttlSeconds) end
return '{"ok":true,"value":' .. message .. '}'
