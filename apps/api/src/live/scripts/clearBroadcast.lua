if ARGV[1] and redis.call('GET', KEYS[6]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[6])
