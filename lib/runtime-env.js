'use strict';

// Central server-side environment selector. Staging deliberately has no
// canonical-name fallback: an absent STAGING_* value stays absent.
function runtimeEnvironment() {
  const value = typeof process.env.AUTO_CUAN_ENV === 'string' ? process.env.AUTO_CUAN_ENV.trim() : '';
  if (!value || value === 'production') return 'production';
  if (value === 'staging') return 'staging';
  throw new Error('runtime_environment_invalid');
}

function resolve(name) {
  const environment = runtimeEnvironment();
  return process.env[environment === 'staging' ? 'STAGING_' + name : name];
}

function optional(name) {
  const value = resolve(name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

module.exports = { runtimeEnvironment, resolve, optional };
