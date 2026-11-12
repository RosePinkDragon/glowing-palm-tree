// Node's TypeScript stripping does not resolve Metro's extensionless platform imports.
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === './storage' && context.parentURL?.endsWith('/services/src/index.ts')) {
    return nextResolve('./storage.ts', context);
  }
  return nextResolve(specifier, context);
} });
