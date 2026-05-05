import { counterAtom, bumpCounter } from 'lib-writer';
import { readCounter } from 'lib-reader';

bumpCounter();
console.log('counter =', readCounter(counterAtom));
