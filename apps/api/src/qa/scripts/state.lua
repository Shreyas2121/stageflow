local participant, error = authorize(false)
if error then return cjson.encode({ ok = false, error = error }) end
return state()
