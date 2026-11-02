import { expect, it, vi } from 'vitest';
import type { JwtService } from '@nestjs/jwt';
import type { Repository } from 'typeorm';
import type { User } from '../users/user.entity';
import { SessionsService } from './sessions.service';
import { env } from '../config/env';

it('bounds in-flight guest creation even if callers close their HTTP connections', async () => {
  let release!: (user: User) => void;
  const gate = new Promise<User>((resolve) => {
    release = resolve;
  });
  const users = { create: vi.fn((value: unknown) => value), save: vi.fn(() => gate) };
  const jwt = { signAsync: vi.fn(async () => 'signed-token') };
  const service = new SessionsService(
    users as unknown as Repository<User>,
    jwt as unknown as JwtService,
  );
  const active = Array.from({ length: env.GUEST_PENDING_LIMIT }, () =>
    service.createGuest('Guest'),
  );
  await expect(service.createGuest('Excess')).rejects.toMatchObject({
    response: { statusCode: 503, error: 'server_busy' },
  });
  expect(users.create).toHaveBeenCalledTimes(env.GUEST_PENDING_LIMIT);
  release({ id: 'test-user', displayName: 'Guest' } as User);
  await Promise.all(active);
  expect(await service.createGuest('Next')).toMatchObject({ token: 'signed-token' });
});
