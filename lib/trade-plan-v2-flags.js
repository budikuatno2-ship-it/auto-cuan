'use strict';

/**
 * Trade Plan V2 — Feature Flags (safe defaults)
 * =============================================
 *
 * Two independent flags gate the rollout of the shared trade-plan engine:
 *
 *   TRADE_PLAN_V2_SHADOW_ENABLED  (default false)
 *     When true, callers MAY compute + attach a shadow trade_plan_v2 payload
 *     and emit comparison diagnostics. It must NOT change any public output.
 *
 *   TRADE_PLAN_V2_PUBLIC_ENABLED  (default false)
 *     When true, presentation code (website + Telegram) MAY display the
 *     trade_plan_v2 values instead of the legacy plan. Public output MUST remain
 *     unchanged while this flag is false.
 *
 * Both default to FALSE. A flag is only "on" for the explicit strings
 * "true"/"1"/"yes"/"on" (case-insensitive). Anything else — including unset,
 * empty, "false", "0" — is OFF. This guarantees production stays unchanged
 * unless the flag is explicitly enabled.
 */

const SHADOW_FLAG = 'TRADE_PLAN_V2_SHADOW_ENABLED';
const PUBLIC_FLAG = 'TRADE_PLAN_V2_PUBLIC_ENABLED';

function truthy(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

function readEnv(env) {
  return env || (typeof process !== 'undefined' ? process.env : {}) || {};
}

/** Shadow computation/diagnostics enabled? Default false. */
function isShadowEnabled(env) {
  return truthy(readEnv(env)[SHADOW_FLAG]);
}

/** Public (website + Telegram) display of trade_plan_v2 enabled? Default false. */
function isPublicEnabled(env) {
  return truthy(readEnv(env)[PUBLIC_FLAG]);
}

/** Snapshot of both flags plus the resolved safe defaults. */
function getFlags(env) {
  const e = readEnv(env);
  return {
    [SHADOW_FLAG]: isShadowEnabled(e),
    [PUBLIC_FLAG]: isPublicEnabled(e),
    defaults: { [SHADOW_FLAG]: false, [PUBLIC_FLAG]: false }
  };
}

module.exports = {
  SHADOW_FLAG,
  PUBLIC_FLAG,
  truthy,
  isShadowEnabled,
  isPublicEnabled,
  getFlags
};
