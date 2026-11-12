const assert = require('node:assert/strict');
const test = require('node:test');
const { getAppConfig } = require('./app-config.cjs');

const keys = [
  'ammu-sammu-customer',
  'ammu-sammu-admin',
  'konkan-fine-dine-customer',
  'konkan-fine-dine-admin',
];
const envNames = ['EXPO_PUBLIC_EAS_PROJECT_ID', 'EXPO_OWNER', 'EXPO_PUBLIC_WEB_BASE_PATH'];

function withEnv(values, callback) {
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return callback();
  } finally {
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test('app targets retain distinct native identifiers and business audiences', () => {
  withEnv({}, () => {
    const configs = keys.map(getAppConfig);
    assert.deepEqual(configs.map((config) => config.slug), keys);
    assert.equal(new Set(configs.map((config) => config.ios.bundleIdentifier)).size, keys.length);
    assert.deepEqual(configs.map((config) => config.extra.audience), ['customer', 'admin', 'customer', 'admin']);
    for (const config of [configs[0], configs[2]]) {
      assert.match(config.ios.infoPlist.NSLocationWhenInUseUsageDescription, /delivery area/);
      assert.deepEqual(config.android.permissions, [
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_FINE_LOCATION',
      ]);
    }
    for (const config of [configs[1], configs[3]]) {
      assert.equal(config.ios.infoPlist, undefined);
      assert.equal(config.android.permissions, undefined);
    }
  });
});

test('optional EAS owner, project id, and web base path are validated and mapped', () => {
  withEnv({
    EXPO_PUBLIC_EAS_PROJECT_ID: '00000000-0000-4000-8000-000000000001',
    EXPO_OWNER: 'example-owner',
    EXPO_PUBLIC_WEB_BASE_PATH: '/glowing-palm-tree/ammu-sammu-customer/',
  }, () => {
    const config = getAppConfig(keys[0]);
    assert.deepEqual(config.extra.eas, { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID });
    assert.equal(config.owner, 'example-owner');
    assert.equal(config.experiments.baseUrl, process.env.EXPO_PUBLIC_WEB_BASE_PATH);
  });
});

test('invalid EAS project ids, owners, and unsafe URL paths are rejected', () => {
  for (const projectId of ['not-a-uuid', '00000000-0000-0000-0000-000000000001/other']) {
    withEnv({ EXPO_PUBLIC_EAS_PROJECT_ID: projectId }, () => {
      assert.throws(() => getAppConfig(keys[0]), /EXPO_PUBLIC_EAS_PROJECT_ID must be a UUID/);
    });
  }
  withEnv({ EXPO_OWNER: 'owner with spaces' }, () => {
    assert.throws(() => getAppConfig(keys[0]), /EXPO_OWNER has an invalid format/);
  });
  for (const basePath of ['https://example.com/', '/foo/../bar/', '/foo?x=1', '//evil/path']) {
    withEnv({ EXPO_PUBLIC_WEB_BASE_PATH: basePath }, () => {
      assert.throws(() => getAppConfig(keys[0]), /safe absolute URL path/);
    });
  }
});
