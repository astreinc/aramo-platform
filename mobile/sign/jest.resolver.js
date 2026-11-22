// Client Rule Consolidation C2-3 — Jest resolution for libs/sign-client, mirroring
// metro.config.js: the library's `.js`-suffixed relative imports (the repo's nodenext
// rule) resolve to their `.ts` source. Scoped to files inside the repo libraries the app
// imports (libs/sign-client and, FIELD-PARITY-1 P1-1, libs/sign-fields), so no other module
// (app code, node_modules) resolves differently. Everything is then handed to the React
// Native preset resolver, unchanged.
const path = require('path');

const presetResolver = require('@react-native/jest-preset/jest/resolver.js');

const libRoots = [
  path.resolve(__dirname, '../../libs/sign-client') + path.sep,
  path.resolve(__dirname, '../../libs/sign-fields') + path.sep,
];

module.exports = (request, options) => {
  const inLib = typeof options.basedir === 'string' && libRoots.some((root) => (options.basedir + path.sep).startsWith(root));
  const req = inLib && request.startsWith('.') && request.endsWith('.js') ? request.slice(0, -'.js'.length) : request;
  return presetResolver(req, options);
};
