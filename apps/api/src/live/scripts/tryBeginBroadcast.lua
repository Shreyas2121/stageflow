if redis.call('EXISTS', KEYS[6]) == 1 then return 0 end
redis.call('SET', KEYS[6], ARGV[1])
return 1
