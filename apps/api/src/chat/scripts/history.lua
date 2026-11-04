local command = cjson.decode(ARGV[1])
local binding = command.binding
local rawParticipant = redis.call('HGET', KEYS[7], binding.participantId)
if not rawParticipant then return cjson.encode({ ok = false, error = 'stale_transport' }) end
local participant = cjson.decode(rawParticipant)
if participant.presence ~= 'connected' or participant.socketId ~= binding.socketId or participant.connectionGeneration ~= binding.generation then
  return cjson.encode({ ok = false, error = 'stale_transport' })
end

local retained = redis.call('LRANGE', KEYS[2], 0, -1)
local oldest, latest = cjson.null, cjson.null
if #retained > 0 then
  oldest = cjson.decode(retained[1]).sequence
  latest = cjson.decode(retained[#retained]).sequence
end
local page = {}
for i = #retained, 1, -1 do
  if not command.beforeSequence or cjson.decode(retained[i]).sequence < command.beforeSequence then
    table.insert(page, 1, retained[i])
    if #page == command.limit then break end
  end
end
local gap = command.beforeSequence ~= nil and oldest ~= cjson.null and command.beforeSequence < oldest
local metadata = cjson.encode({
  paused = redis.call('GET', KEYS[3]) == '1',
  oldestSequence = oldest, latestSequence = latest, retentionGap = gap
})
-- Encode the list explicitly: Redis cjson otherwise turns an empty Lua table into {}.
return '{"ok":true,"value":' .. string.sub(metadata, 1, -2) .. ',"messages":[' .. table.concat(page, ',') .. ']}}'
