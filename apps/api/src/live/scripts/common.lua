-- Prepended to each command by LiveRepository; all reads and writes are atomic.
local command = cjson.decode(ARGV[1])
local room = command.room
local revKey, participantsKey, stageKey, handsKey, endingKey = unpack(KEYS)
local revision = tonumber(redis.call('GET', revKey)) or 0
local participants = {}
local raw = redis.call('HGETALL', participantsKey)
for i = 1, #raw, 2 do participants[raw[i]] = cjson.decode(raw[i + 1]) end
local stage = {}
for _, id in ipairs(redis.call('SMEMBERS', stageKey)) do stage[id] = true end
local hands = {}
raw = redis.call('ZRANGE', handsKey, 0, -1, 'WITHSCORES')
for i = 1, #raw, 2 do hands[raw[i]] = tonumber(raw[i + 1]) end

local dirtyParticipants, dirtyStage, dirtyHands = {}, {}, {}
local clearRoom = false
local function saveParticipant(id)
  dirtyParticipants[id] = true
end
local function setStage(id, present)
  if (stage[id] or false) == present then return end
  stage[id] = present and true or nil
  dirtyStage[id] = true
end
local function setHand(id, raisedAt)
  if hands[id] == raisedAt then return end
  hands[id] = raisedAt
  dirtyHands[id] = true
end

local function reject(error)
  return cjson.encode({ ok = false, error = error, revision = revision })
end

local function stageCount()
  local count = 0
  for _ in pairs(stage) do count = count + 1 end
  return count
end

local function hostTarget()
  local actor = participants[command.actorSocketId]
  if not actor or actor.role ~= 'HOST' then return nil, 'not_host' end
  local target = participants[command.targetSocketId]
  if not target then return nil, 'participant_not_found' end
  return target, nil
end

-- Redis cjson encodes an empty Lua table as {}, so encode lists explicitly.
local function arrayJson(values)
  local encoded = {}
  for _, value in ipairs(values) do encoded[#encoded + 1] = cjson.encode(value) end
  return '[' .. table.concat(encoded, ',') .. ']'
end

local function finish(changed, roomEnded)
  if changed then
    if clearRoom then
      redis.call('DEL', participantsKey, stageKey, handsKey)
    else
      for id in pairs(dirtyParticipants) do
        if participants[id] then redis.call('HSET', participantsKey, id, cjson.encode(participants[id]))
        else redis.call('HDEL', participantsKey, id) end
      end
      for id in pairs(dirtyStage) do
        if stage[id] then redis.call('SADD', stageKey, id)
        else redis.call('SREM', stageKey, id) end
      end
      for id in pairs(dirtyHands) do
        if hands[id] then redis.call('ZADD', handsKey, hands[id], id)
        else redis.call('ZREM', handsKey, id) end
      end
    end
    revision = redis.call('INCR', revKey)
    local expiring = { revKey, participantsKey, stageKey, handsKey }
    if redis.call('EXISTS', endingKey) == 1 then expiring[#expiring + 1] = endingKey end
    for _, key in ipairs(expiring) do redis.call('EXPIRE', key, 86400) end
  end
  local participantList, stageList, handList = {}, {}, {}
  for _, participant in pairs(participants) do participantList[#participantList + 1] = participant end
  for id in pairs(stage) do stageList[#stageList + 1] = id end
  for id, raisedAt in pairs(hands) do handList[#handList + 1] = { socketId = id, raisedAt = raisedAt } end
  table.sort(participantList, function(a, b) return a.socketId < b.socketId end)
  table.sort(stageList)
  table.sort(handList, function(a, b)
    if a.raisedAt == b.raisedAt then return a.socketId < b.socketId end
    return a.raisedAt < b.raisedAt
  end)
  local state = '{"roomId":' .. cjson.encode(room.roomId)
    .. ',"hostId":' .. cjson.encode(room.hostId)
    .. ',"mode":' .. cjson.encode(room.mode)
    .. ',"status":' .. cjson.encode(roomEnded and 'ENDED' or room.status)
    .. ',"participants":' .. arrayJson(participantList)
    .. ',"stageSocketIds":' .. arrayJson(stageList)
    .. ',"hands":' .. arrayJson(handList) .. '}'
  return '{"ok":true,"revision":' .. revision
    .. ',"changed":' .. tostring(changed)
    .. ',"roomEnded":' .. tostring(roomEnded or false) .. ',"state":' .. state .. '}'
end
