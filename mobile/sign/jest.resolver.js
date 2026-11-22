// Client Rule Consolidation C2-3 — Jest resolution for libs/sign-client, mirroring
// metro.config.js: the library's `.js`-suffixed relative imports (the repo's nodenext
// rule) resolve to their `.ts` source. Scoped to files inside libs/sign-client, so no
// other module (app code, node_modules) resolves differently. Everything is then handed
// to the React Native preset resolver, unchanged.
const path = require('path');

const presetResolver = require('@react-native/jest-preset/jest/resolver.js');

const signClientRoot = path.resolve(__dirname, '../../libs/sign-client') + path.sep;

module.exports = (request, options) => {
  const inLib = typeof options.basedir === 'string' && (options.basedir + path.sep).startsWith(signClientRoot);
  const req = inLib && request.startsWith('.') && request.endsWith('.js') ? request.slice(0, -'.js'.length) : request;
  return presetResolver(req, options);
};
