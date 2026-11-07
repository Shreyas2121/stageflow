local participant, error = authorize(true)
if error then return cjson.encode({ ok = false, error = error }) end
if redis.call('HEXISTS', questionsKey, command.questionId) == 0 then return cjson.encode({ ok = false, error = 'qa_missing' }) end
redis.call('HDEL', questionsKey, command.questionId)
redis.call('DEL', votesPrefix .. command.questionId)
if redis.call('GET', featuredKey) == command.questionId then redis.call('DEL', featuredKey) end
refreshTtl()
return state()
