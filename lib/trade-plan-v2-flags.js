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
 *   TRADE_PLAN_V2_LIQUIDITY_SWEEP_SHADOW_ENABLED  (default false)
 *     When true, callers MAY compute + attach the observable liquidity-sweep /
 *     candle-structure / gap-area shadow diagnostics and emit the sweep-policy
 *     comparison. It must NOT change any public output. This is an ADDITIVE flag
 *     layered on top of the shadow flag — it never enables public behaviour.
 *
 * All flags default to FALSE. A flag is only "on" for the explicit strings
 * "true"/"1"/"yes"/"on" (case-insensitive). Anything else — including unset,
 * empty, "false", "0" — is OFF. This guarantees production stays unchanged
 * unless the flag is explicitly enabled.
 */

const SHADOW_FLAG = 'TRADE_PLAN_V2_SHADOW_ENABLED';
const PUBLIC_FLAG = 'TRADE_PLAN_V2_PUBLIC_ENABLED';
const LIQUIDITY_SWEEP_SHADOW_FLAG = 'TRADE_PLAN_V2_LIQUIDITY_SWEEP_SHADOW_ENABLED';

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

/**
 * Observable liquidity-sweep shadow diagnostics enabled? Default false.
 * ADDITIVE: independent of getFlags() so the existing flag contract is unchanged.
 */
function isLiquiditySweepShadowEnabled(env) {
  return truthy(readEnv(env)[LIQUIDITY_SWEEP_SHADOW_FLAG]);
}

/**
 * Snapshot of the two ORIGINAL flags plus their resolved safe defaults. This
 * shape is intentionally kept backward-compatible (unchanged).
 */
function getFlags(env) {
  const e = readEnv(env);
  return {
    [SHADOW_FLAG]: isShadowEnabled(e),
    [PUBLIC_FLAG]: isPublicEnabled(e),
    defaults: { [SHADOW_FLAG]: false, [PUBLIC_FLAG]: false }
  };
}

/**
 * Extended snapshot including the additive liquidity-sweep shadow flag. Separate
 * from getFlags() so the original contract stays byte-compatible.
 */
function getAllFlags(env) {
  const e = readEnv(env);
  return {
    [SHADOW_FLAG]: isShadowEnabled(e),
    [PUBLIC_FLAG]: isPublicEnabled(e),
    [LIQUIDITY_SWEEP_SHADOW_FLAG]: isLiquiditySweepShadowEnabled(e),
    defaults: { [SHADOW_FLAG]: false, [PUBLIC_FLAG]: false, [LIQUIDITY_SWEEP_SHADOW_FLAG]: false }
  };
}

module.exports = {
  SHADOW_FLAG,
  PUBLIC_FLAG,
  LIQUIDITY_SWEEP_SHADOW_FLAG,
  truthy,
  isShadowEnabled,
  isPublicEnabled,
  isLiquiditySweepShadowEnabled,
  getFlags,
  getAllFlags
};
