import { expect, it } from 'vitest';
import { WindowBudget } from './window-budget';
it('bounds bursts and identities without evicting active counters; expiry permits reuse', () => {
  let now = 0;
  const budget = new WindowBudget(2, 1000, 2, () => now);
  expect(budget.consume('a')).toBe(true);
  expect(budget.consume('a')).toBe(true);
  expect(budget.consume('a')).toBe(false);
  expect(budget.consume('b')).toBe(true);
  expect(budget.consume('c')).toBe(false);
  expect(budget.consume('a')).toBe(false);
  now = 1000;
  expect(budget.consume('c')).toBe(true);
  expect(budget.consume('a')).toBe(true);
});
