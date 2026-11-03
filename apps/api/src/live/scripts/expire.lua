local changed, ended = expireOverdue(command.now)
return finish(changed, ended)
