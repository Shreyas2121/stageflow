-- Prepended to each command by LiveRepository; all reads and writes are atomic.
local command = cjson.decode(ARGV[1])
local room = command.room
local revKey, participantsKey, stageKey, handsKey, endingKey = unpack(KEYS)
local transportsKey = KEYS[7]
local resumeKey, deadlinesKey = KEYS[8], KEYS[9]
local revision = tonumber(redis.call('GET', revKey)) or 0
local participants = {}
local raw = redis.call('HGETALL', participantsKey)
for i = 1, #raw, 2 do participants[raw[i]] = cjson.decode(raw[i + 1]) end
local stage = {}
for _, id in ipairs(redis.call('SMEMBERS', stageKey)) do stage[id] = true end
local hands = {}
raw = redis.call('ZRANGE', handsKey, 0, -1, 'WITHSCORES')
for i = 1, #raw, 2 do hands[raw[i]] = tonumber(raw[i + 1]) end
local resumeDigests, deadlines = {}, {}
raw = redis.call('HGETALL', resumeKey)
for i = 1, #raw, 2 do resumeDigests[raw[i]] = raw[i + 1] end
raw = redis.call('ZRANGE', deadlinesKey, 0, -1, 'WITHSCORES')
for i = 1, #raw, 2 do deadlines[raw[i]] = tonumber(raw[i + 1]) end

local dirtyParticipants, dirtyStage, dirtyHands = {}, {}, {}
local dirtyResume, dirtyDeadlines = {}, {}
local clearRoom = false
local expiryChanged, expiryEnded = false, false
local finish
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
  if expiryChanged then
    local expiry = finish(true, expiryEnded)
    return '{"ok":false,"error":' .. cjson.encode(error) .. ',"revision":' .. revision .. ',"expiry":' .. expiry .. '}'
  end
  return cjson.encode({ ok = false, error = error, revision = revision })
end

local function stageCount()
  local count = 0
  for _ in pairs(stage) do count = count + 1 end
  return count
end

local function hostTarget()
  local actor = participants[command.actorParticipantId]
  if not actor or actor.role ~= 'HOST' then return nil, 'not_host' end
  local target = participants[command.targetParticipantId]
  if not target then return nil, 'participant_not_found' end
  return target, nil
end

-- Redis cjson encodes an empty Lua table as {}, so encode lists explicitly.
local function arrayJson(values)
  local encoded = {}
  for _, value in ipairs(values) do encoded[#encoded + 1] = cjson.encode(value) end
  return '[' .. table.concat(encoded, ',') .. ']'
end

finish = function(changed, roomEnded)
  changed = changed or expiryChanged
  roomEnded = roomEnded or expiryEnded
  if changed then
    if clearRoom then
      redis.call('DEL', participantsKey, stageKey, handsKey, transportsKey, resumeKey, deadlinesKey)
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
      for id in pairs(dirtyResume) do
        if resumeDigests[id] then redis.call('HSET', resumeKey, id, resumeDigests[id])
        else redis.call('HDEL', resumeKey, id) end
      end
      for id in pairs(dirtyDeadlines) do
        if deadlines[id] then redis.call('ZADD', deadlinesKey, deadlines[id], id)
        else redis.call('ZREM', deadlinesKey, id) end
      end
    end
    revision = redis.call('INCR', revKey)
    local expiring = { revKey, participantsKey, stageKey, handsKey, transportsKey, resumeKey, deadlinesKey }
    if redis.call('EXISTS', endingKey) == 1 then expiring[#expiring + 1] = endingKey end
    for _, key in ipairs(expiring) do redis.call('EXPIRE', key, 86400) end
  end
  local participantList, stageList, handList = {}, {}, {}
  for _, participant in pairs(participants) do participantList[#participantList + 1] = participant end
  for id in pairs(stage) do stageList[#stageList + 1] = id end
  for id, raisedAt in pairs(hands) do handList[#handList + 1] = { participantId = id, raisedAt = raisedAt } end
  table.sort(participantList, function(a, b) return a.participantId < b.participantId end)
  table.sort(stageList)
  table.sort(handList, function(a, b)
    if a.raisedAt == b.raisedAt then return a.participantId < b.participantId end
    return a.raisedAt < b.raisedAt
  end)
  local state = '{"roomId":' .. cjson.encode(room.roomId)
    .. ',"hostId":' .. cjson.encode(room.hostId)
    .. ',"mode":' .. cjson.encode(room.mode)
    .. ',"status":' .. cjson.encode(roomEnded and 'ENDED' or room.status)
    .. ',"participants":' .. arrayJson(participantList)
    .. ',"stageParticipantIds":' .. arrayJson(stageList)
    .. ',"hands":' .. arrayJson(handList)
    .. ',"resumeDigests":' .. cjson.encode(resumeDigests)
    .. ',"deadlines":' .. cjson.encode(deadlines) .. '}'
  return '{"ok":true,"revision":' .. revision
    .. ',"changed":' .. tostring(changed)
    .. ',"roomEnded":' .. tostring(roomEnded or false) .. ',"state":' .. state .. '}'
end

local function removeMember(id)
  local participant = participants[id]
  if participant and participant.socketId ~= cjson.null then redis.call('HDEL', transportsKey, participant.socketId) end
  participants[id] = nil
  saveParticipant(id)
  setStage(id, false)
  setHand(id, nil)
  if resumeDigests[id] then resumeDigests[id] = nil; dirtyResume[id] = true end
  if deadlines[id] then deadlines[id] = nil; dirtyDeadlines[id] = true end
end

local function endRoom()
  redis.call('SET', endingKey, '1', 'EX', 86400)
  participants, stage, hands, resumeDigests, deadlines = {}, {}, {}, {}, {}
  clearRoom = true
end

-- Shared by the sweeper and the atomic join/resume paths, including delayed timers.
local function expireOverdue(now)
  if room.status == 'ENDED' or redis.call('EXISTS', endingKey) == 1 then return false, true end
  local overdue = {}
  for id, deadline in pairs(deadlines) do
    local participant = participants[id]
    if participant and participant.presence == 'suspended' and deadline <= now then
      if participant.role == 'HOST' then endRoom(); return true, true end
      overdue[#overdue + 1] = id
    end
  end
  for _, id in ipairs(overdue) do removeMember(id) end
  return #overdue > 0, false
end

if command.transport then
  local binding = command.transport
  local actor = participants[binding.participantId]
  if (not actor and command.type ~= 'leave') or (actor and (actor.connectionGeneration ~= binding.generation or actor.socketId ~= binding.socketId or actor.presence ~= 'connected')) then
    return reject('stale_transport')
  end
end
