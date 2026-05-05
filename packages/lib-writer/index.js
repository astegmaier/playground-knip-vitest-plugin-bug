import { atom, getDefaultStore } from 'jotai/vanilla';

export const counterAtom = atom(0);

export function bumpCounter() {
  const store = getDefaultStore();
  store.set(counterAtom, store.get(counterAtom) + 1);
}
