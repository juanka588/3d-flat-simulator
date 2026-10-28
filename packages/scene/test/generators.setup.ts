// Temporary (docs/architecture/modules.md step A1, removed in step 11): core modules no longer import the generators, so
// importing e.g. `./commands` directly would leave the GENERATORS registry empty. Scene tests still run against the real ones.
import '../src/assets';
