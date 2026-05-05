import { getDefaultStore } from 'jotai/vanilla';

export function readCounter(atom) {
  return getDefaultStore().get(atom);
}
