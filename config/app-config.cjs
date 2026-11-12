const targets = require('./app-targets.json');

function getAppConfig(appKey) {
  if (!Object.hasOwn(targets, appKey)) throw new Error(`Unknown app target: ${appKey}`);
  const target = targets[appKey];
  return {
    name: target.name,
    slug: appKey,
    scheme: appKey,
    version: '0.1.0',
    ios: { bundleIdentifier: target.identifier },
    android: { package: target.identifier },
    web: { output: 'single' },
    extra: { businessId: target.businessId, audience: target.audience, appKey },
  };
}

module.exports = { getAppConfig };
