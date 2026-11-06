-- Q&A owns its keys and does not use the stage common.lua prelude.
local command = cjson.decode(ARGV[1])
local seqKey, questionsKey, featuredKey, submissionsKey, submitRoomKey, submitUserKey, voteRoomKey, voteUserKey, participantsKey = unpack(KEYS)
local votesPrefix = string.sub(questionsKey, 1, -11) .. ':votes:'
local binding = command.binding
local rawParticipant = redis.call('HGET', participantsKey, binding.participantId)
if not rawParticipant then return cjson.encode({ ok = false, error = 'stale_transport' }) end
local participant = cjson.decode(rawParticipant)
if participant.presence ~= 'connected' or participant.socketId ~= binding.socketId or participant.connectionGeneration ~= binding.generation then
  return cjson.encode({ ok = false, error = 'stale_transport' })
end
if participant.role ~= 'HOST' then return cjson.encode({ ok = false, error = 'not_host' }) end
if participant.isSyntheticBot then return cjson.encode({ ok = false, error = 'qa_not_allowed' }) end

local function refreshTtl()
  for i = 1, 8 do redis.call('EXPIRE', KEYS[i], command.ttlSeconds) end
  for _, id in ipairs(redis.call('HKEYS', questionsKey)) do
    redis.call('EXPIRE', votesPrefix .. id, command.ttlSeconds)
  end
end

local function state()
  local questions, voted = {}, {}
  local entries = redis.call('HGETALL', questionsKey)
  for i = 1, #entries, 2 do
    local question = cjson.decode(entries[i + 1])
    question.voteCount = redis.call('SCARD', votesPrefix .. question.id)
    table.insert(questions, question)
  end
  table.sort(questions, function(a, b)
    if a.voteCount ~= b.voteCount then return a.voteCount > b.voteCount end
    if a.createdAt ~= b.createdAt then return a.createdAt < b.createdAt end
    -- Positive decimal strings compare numerically without losing 64-bit INCR precision.
    if #a.id ~= #b.id then return #a.id < #b.id end
    return a.id < b.id
  end)
  local encoded = {}
  for _, question in ipairs(questions) do
    table.insert(encoded, cjson.encode(question))
    if redis.call('SISMEMBER', votesPrefix .. question.id, binding.participantId) == 1 then
      table.insert(voted, cjson.encode(question.id))
    end
  end
  local featured = cjson.null
  local featuredId = redis.call('GET', featuredKey)
  if featuredId then
    local raw = redis.call('HGET', questionsKey, featuredId)
    if raw then
      local question = cjson.decode(raw)
      featured = { questionId = question.id, text = question.text, authorName = question.authorName }
    else
      redis.call('DEL', featuredKey)
    end
  end
  local metadata = cjson.encode({ submissionsOpen = redis.call('GET', submissionsKey) ~= '0', featured = featured })
  return '{"ok":true,"value":' .. string.sub(metadata, 1, -2) .. ',"questions":[' .. table.concat(encoded, ',') .. '],"votedQuestionIds":[' .. table.concat(voted, ',') .. ']}}'
end
if redis.call('HEXISTS', questionsKey, command.questionId) == 0 then return cjson.encode({ ok = false, error = 'qa_missing' }) end
redis.call('HDEL', questionsKey, command.questionId)
redis.call('DEL', votesPrefix .. command.questionId)
if redis.call('GET', featuredKey) == command.questionId then redis.call('DEL', featuredKey) end
refreshTtl()
return state()
