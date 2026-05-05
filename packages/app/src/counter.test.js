import { test, expect } from 'vitest';
import { counterAtom, bumpCounter } from 'lib-writer';
import { readCounter } from 'lib-reader';

test('counter is shared across packages', () => {
  bumpCounter();
  expect(readCounter(counterAtom)).toBe(1);
});
