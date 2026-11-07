local participant, error = authorize(true)
if error then return cjson.encode({ ok = false, error = error }) end
redis.call('DEL', featuredKey)
refreshTtl()
return state()
