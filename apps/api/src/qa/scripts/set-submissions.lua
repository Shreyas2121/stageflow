local participant, error = authorize(true)
if error then return cjson.encode({ ok = false, error = error }) end
redis.call('SET', submissionsKey, command.open and '1' or '0')
refreshTtl()
return state()
