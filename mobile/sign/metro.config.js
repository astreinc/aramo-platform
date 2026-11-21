// Metro config for Aramo Sign mobile.
//
// Aramo-Sign-Client-Rule-Consolidation-Directive-v1_0-LOCKED §1 G-3 / §4 C2-3 — the app
// imports ONE repo library, libs/sign-client (`@aramo/sign-client`): pure TypeScript Sign
// rules shared with apps/sign-web and the server. This package sits outside the root npm
// workspaces, so Metro is told about the library explicitly:
//   - watchFolders  adds libs/sign-client (only that folder, not the web monorepo);
//   - resolveRequest maps `@aramo/sign-client` to the library's source entry, and maps the
//                   library's own `.js`-suffixed relative imports (the repo's nodenext rule)
//                   to their `.ts` source. Anything else resolves exactly as before.
// The library imports no npm package (nx boundary type:client-shared), so it can never
// pull the web monorepo's React 18 into the app bundle.
const path = require('path');

const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const signClientRoot = path.resolve(projectRoot, '../../libs/sign-client');
const signClientEntry = path.join(signClientRoot, 'src', 'index.ts');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders ?? []), signClientRoot];

const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstreamResolveRequest ?? context.resolveRequest;
  if (moduleName === '@aramo/sign-client') {
    return { type: 'sourceFile', filePath: signClientEntry };
  }
  if (
    context.originModulePath.startsWith(signClientRoot + path.sep) &&
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js')
  ) {
    // './lib/sign-date.js' → './lib/sign-date', which Metro resolves through sourceExts (.ts).
    return resolve(context, moduleName.slice(0, -'.js'.length), platform);
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
