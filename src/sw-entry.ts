import { registerHandlers, SwScope } from './sw-handlers';
import { IdbStore } from './storage';

registerHandlers(self as unknown as SwScope, { store: new IdbStore() });
