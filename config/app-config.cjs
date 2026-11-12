const targets = require('./app-targets.json');

function optionalProjectId() {
  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  if (projectId === undefined || projectId === '') return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new Error('EXPO_PUBLIC_EAS_PROJECT_ID must be a UUID.');
  }
  return projectId;
}

function optionalOwner() {
  const owner = process.env.EXPO_OWNER;
  if (owner === undefined || owner === '') return undefined;
  if (!/^[a-z0-9][a-z0-9_-]{0,38}$/i.test(owner)) throw new Error('EXPO_OWNER has an invalid format.');
  return owner;
}

function optionalWebBasePath() {
  const basePath = process.env.EXPO_PUBLIC_WEB_BASE_PATH;
  if (basePath === undefined || basePath === '') return undefined;
  if (basePath.length > 256 || !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?|)$/.test(basePath) ||
      basePath.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('EXPO_PUBLIC_WEB_BASE_PATH must be a safe absolute URL path.');
  }
  return basePath;
}

function getAppConfig(appKey) {
  if (!Object.hasOwn(targets, appKey)) throw new Error(`Unknown app target: ${appKey}`);
  const target = targets[appKey];
  const config = {
    name: target.name,
    slug: appKey,
    scheme: appKey,
    version: '0.1.0',
    ios: { bundleIdentifier: target.identifier },
    android: { package: target.identifier },
    web: { output: 'single' },
    extra: { businessId: target.businessId, audience: target.audience, appKey },
  };
  const projectId = optionalProjectId();
  const owner = optionalOwner();
  const basePath = optionalWebBasePath();
  if (projectId) config.extra.eas = { projectId };
  if (owner) config.owner = owner;
  if (basePath) config.experiments = { baseUrl: basePath };
  return config;
}

module.exports = { getAppConfig };
