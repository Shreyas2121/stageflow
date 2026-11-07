local participant, error = authorize(true)
if error then return cjson.encode({ ok = false, error = error }) end
if redis.call('HEXISTS', questionsKey, command.questionId) == 0 then return cjson.encode({ ok = false, error = 'qa_missing' }) end
redis.call('SET', featuredKey, command.questionId)
refreshTtl()
return state()
