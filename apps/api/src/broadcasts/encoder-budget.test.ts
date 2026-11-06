import { expect, it } from 'vitest';
import { EncoderBudget } from './encoder-budget';

it('keeps global and per-host slots and forgets a host after release', () => {
  const budget = new EncoderBudget(2, 1);
  const ava = budget.tryAcquire('ava');
  const avaAgain = budget.tryAcquire('ava');
  const sam = budget.tryAcquire('sam');
  expect(ava).not.toBeNull();
  expect(avaAgain).toBeNull();
  expect(sam).not.toBeNull();
  expect(budget.tryAcquire('lee')).toBeNull();
  expect(budget.active).toBe(2);
  ava?.();
  ava?.();
  expect(budget.active).toBe(1);
  expect(budget.principals).toBe(1);
  expect(budget.tryAcquire('ava')).not.toBeNull();
  expect(budget.tryAcquire('')).toBeNull();
});
