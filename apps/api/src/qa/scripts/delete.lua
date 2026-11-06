local votesPrefix = string.sub(KEYS[2], 1, -11) .. ':votes:'
for _, id in ipairs(redis.call('HKEYS', KEYS[2])) do redis.call('DEL', votesPrefix .. id) end
for i = 1, 8 do redis.call('DEL', KEYS[i]) end
return '{"ok":true}'
