'use strict';

function toNonNegativeInteger(value) {
  var parsed = Number(value);

  if (!isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.floor(parsed);
}

function normalizeReason(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function classifyTelegramResult(result) {
  var row = result || {};

  var chunksSent =
    toNonNegativeInteger(row.chunks_sent);

  var chunksTotal =
    toNonNegativeInteger(row.chunks_total);

  var reason = normalizeReason(row.reason);
  var status = Number(row.status) || null;

  if (row.sent === true) {
    return {
      state: 'delivered',
      delivered: true,
      attempted: true,
      skipped: false,
      uncertain: false,
      retryable: false,
      permanent: false,
      partial: false,
      reason: null,
      status: status,
      chunks_sent: chunksSent || 1,
      chunks_total:
        chunksTotal || chunksSent || 1
    };
  }

  /*
   * At least one chunk was confirmed sent, but the complete
   * multi-part message did not finish. Retrying from part one
   * could duplicate already-delivered chunks.
   */
  if (chunksSent > 0) {
    return {
      state: 'delivery_uncertain',
      delivered: false,
      attempted: true,
      skipped: false,
      uncertain: true,
      retryable: false,
      permanent: false,
      partial: true,
      reason: reason || 'partial_delivery',
      status: status,
      chunks_sent: chunksSent,
      chunks_total: chunksTotal
    };
  }

  /*
   * A timeout or fetch/network exception may occur after
   * Telegram accepted the request but before the response
   * reached this process. Automatic resend is therefore unsafe.
   */
  if (
    reason === 'telegram_timeout' ||
    reason === 'fetch_error'
  ) {
    return {
      state: 'delivery_uncertain',
      delivered: false,
      attempted: true,
      skipped: false,
      uncertain: true,
      retryable: false,
      permanent: false,
      partial: false,
      reason: reason,
      status: status,
      chunks_sent: 0,
      chunks_total: chunksTotal
    };
  }

  /*
   * Disabled or missing configuration means no request was
   * attempted, so a later configured run may retry safely.
   */
  if (row.skipped === true) {
    return {
      state: 'retryable_failure',
      delivered: false,
      attempted: false,
      skipped: true,
      uncertain: false,
      retryable: true,
      permanent: false,
      partial: false,
      reason: reason || 'skipped',
      status: status,
      chunks_sent: 0,
      chunks_total: chunksTotal
    };
  }

  if (reason === 'api_error') {
    var permanent =
      status === 400 ||
      status === 401 ||
      status === 403 ||
      status === 404;

    return {
      state: permanent
        ? 'permanent_failure'
        : 'retryable_failure',
      delivered: false,
      attempted: true,
      skipped: false,
      uncertain: false,
      retryable: !permanent,
      permanent: permanent,
      partial: false,
      reason: reason,
      status: status,
      chunks_sent: 0,
      chunks_total: chunksTotal
    };
  }

  return {
    state: 'retryable_failure',
    delivered: false,
    attempted: true,
    skipped: false,
    uncertain: false,
    retryable: true,
    permanent: false,
    partial: false,
    reason: reason || 'telegram_send_failed',
    status: status,
    chunks_sent: 0,
    chunks_total: chunksTotal
  };
}

function summarizeTelegramResults(results) {
  var rows = Array.isArray(results)
    ? results
    : [];

  var classified =
    rows.map(classifyTelegramResult);

  var summary = {
    attempted_count: 0,
    sent_count: 0,
    failed_count: 0,
    skipped_count: 0,
    uncertain_count: 0,
    retryable_count: 0,
    permanent_failure_count: 0,
    partial_count: 0,
    chunks_sent: 0,
    chunks_total: 0,
    delivery_state: 'skipped',
    results: classified
  };

  classified.forEach(function(item) {
    if (item.attempted) {
      summary.attempted_count++;
    }

    if (item.delivered) {
      summary.sent_count++;
    }

    if (item.skipped) {
      summary.skipped_count++;
    }

    if (!item.delivered && !item.skipped) {
      summary.failed_count++;
    }

    if (item.uncertain) {
      summary.uncertain_count++;
    }

    if (item.retryable) {
      summary.retryable_count++;
    }

    if (item.permanent) {
      summary.permanent_failure_count++;
    }

    if (item.partial) {
      summary.partial_count++;
    }

    summary.chunks_sent +=
      item.chunks_sent || 0;

    summary.chunks_total +=
      item.chunks_total || 0;
  });

  if (
    summary.sent_count > 0 &&
    summary.sent_count < classified.length
  ) {
    summary.delivery_state =
      'delivery_uncertain';
  } else if (summary.uncertain_count > 0) {
    summary.delivery_state =
      'delivery_uncertain';
  } else if (
    summary.permanent_failure_count > 0
  ) {
    summary.delivery_state =
      'permanent_failure';
  } else if (summary.failed_count > 0) {
    summary.delivery_state =
      'retryable_failure';
  } else if (
    summary.sent_count > 0 &&
    summary.sent_count === classified.length
  ) {
    summary.delivery_state = 'delivered';
  }

  return summary;
}

function getRawPayload(row) {
  if (
    row &&
    row.raw_payload &&
    typeof row.raw_payload === 'object'
  ) {
    return row.raw_payload;
  }

  return {};
}

function rowWasDelivered(row) {
  var raw = getRawPayload(row);

  return !!(
    row &&
    (
      row.first_sent_at ||
      raw.telegram_daily_sent_at ||
      raw.telegram_sent_at ||
      raw.sent_to_telegram_at ||
      raw.telegram_delivery_status ===
        'DELIVERED'
    )
  );
}

function normalizeDeliveryStatus(row) {
  var raw = getRawPayload(row);

  return String(
    row && row.status ||
    raw.telegram_delivery_status ||
    ''
  )
    .trim()
    .toUpperCase();
}

function rowBlocksRetry(row) {
  var status =
    normalizeDeliveryStatus(row);

  return (
    status === 'DELIVERY_PENDING' ||
    status === 'DELIVERY_IN_PROGRESS' ||
    status === 'DELIVERY_UNCERTAIN' ||
    status === 'DELIVERY_FAILED'
  );
}

function isSilentMonitorSource(row) {
  if (!row) {
    return false;
  }
  var raw = getRawPayload(row);
  var source = String(
    row.monitor_source ||
    raw.monitor_source ||
    row.category ||
    raw.category ||
    ''
  )
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  return source === 'daytrade' || source === 'day_trade';
}

function monitorRowIsTrackable(row) {
  if (!row) {
    return false;
  }

  var raw = getRawPayload(row);

  /*
   * Silent background screener registers ('daytrade') are for internal
   * outcome tracking only and MUST be tracked in the DB.
   */
  if (isSilentMonitorSource(row)) {
    return true;
  }

  if (rowWasDelivered(row)) {
    return true;
  }

  var status =
    normalizeDeliveryStatus(row);

  if (
    status.indexOf('DELIVERY_') === 0
  ) {
    return false;
  }

  var raw = getRawPayload(row);

  var lockSource =
    String(raw.lock_source || '')
      .toLowerCase();

  /*
   * A lock-only Top 5 row has not been publicly sent yet
   * and therefore must not receive entry/TP/SL updates.
   */
  if (
    lockSource.indexOf('lock_only') >= 0 &&
    !raw.telegram_daily_sent_at &&
    !raw.telegram_sent_at &&
    !raw.sent_to_telegram_at
  ) {
    return false;
  }

  /*
   * Preserve old monitor rows created before delivery-state
   * metadata existed.
   */
  return true;
}

function monitorRowIsPublicNotificationEligible(row) {
  if (!monitorRowIsTrackable(row)) {
    return false;
  }

  if (isSilentMonitorSource(row)) {
    return false;
  }

  return true;
}


async function prepareCandidatesForDelivery(options) {
  options = options || {};

  var supabase = options.supabase;
  var candidates = Array.isArray(options.candidates)
    ? options.candidates
    : [];

  var date = options.date;
  var source = options.source;
  var buildIdentity = options.build_identity;
  var buildRow = options.build_row;

  var result = {
    ready: false,
    reason: null,
    error: null,
    input_count: candidates.length,
    prepared_count: 0,
    inserted_count: 0,
    duplicate_count: 0,
    blocked_count: 0,
    invalid_candidate_count: 0,
    missing_identity_count: 0,
    reused_retryable_count: 0,
    row_ids: [],
    send_candidates: [],
    legacy_fallback: false
  };

  if (!candidates.length) {
    result.reason = 'no_candidates';
    return result;
  }

  if (
    options.allow_test_fallback === true &&
    process.env.NODE_TEST_CONTEXT
  ) {
    result.ready = true;
    result.prepared_count = candidates.length;
    result.send_candidates = candidates.slice();
    result.legacy_fallback = true;
    return result;
  }

  if (
    !supabase ||
    typeof supabase.from !== 'function' ||
    typeof buildIdentity !== 'function' ||
    typeof buildRow !== 'function'
  ) {
    result.reason = 'delivery_store_unavailable';
    return result;
  }

  try {
    var query = await supabase
      .from('telegram_daily_picks')
      .select(
        'id,date,ticker,monitor_source,plan_lock_id,status,first_sent_at,raw_payload'
      )
      .eq('date', date);

    if (query.error) {
      result.reason = 'delivery_store_read_failed';
      result.error = query.error.message;
      return result;
    }

    var existing = {};
    var existingById = {};

    (query.data || []).forEach(function(row) {
      var raw = row.raw_payload || {};

      if (row.id != null) {
        existingById[String(row.id)] = row;
      }
      var rowSource =
        row.monitor_source ||
        raw.monitor_source ||
        null;

      var rowPlanId =
        row.plan_lock_id ||
        raw.plan_lock_id ||
        raw.locked_plan_lock_id ||
        null;

      if (row.ticker && rowSource && rowPlanId) {
        var key =
          String(row.ticker).toUpperCase() +
          '|' + String(rowSource) +
          '|' + String(rowPlanId);

        existing[key] = row;
      }
    });

    var prepared = [];
    var toInsert = [];
    var seen = {};
    var nowIso = new Date().toISOString();

    candidates.forEach(function(candidate) {
      var identity =
        buildIdentity(candidate, date, source);

      if (!identity || !identity.valid) {
        if (
          identity &&
          identity.reason === 'missing_plan_identity'
        ) {
          result.missing_identity_count++;
        } else {
          result.invalid_candidate_count++;
        }
        return;
      }

      var key =
        identity.ticker +
        '|' + identity.monitor_source +
        '|' + identity.plan_lock_id;

      if (seen[key]) {
        result.duplicate_count++;
        return;
      }

      seen[key] = true;

      var directRowId =
        candidate &&
        candidate._daily_pick_row_id != null
          ? String(candidate._daily_pick_row_id)
          : null;

      var current =
        directRowId && existingById[directRowId]
          ? existingById[directRowId]
          : existing[key];

      if (current) {
        if (rowWasDelivered(current)) {
          result.duplicate_count++;
          return;
        }

        var currentStatus =
          normalizeDeliveryStatus(current);

        var reusableRetry =
          currentStatus ===
          'DELIVERY_RETRYABLE';

        var reusableLocked =
          options.allow_existing_unsent === true &&
          currentStatus === 'WAITING';

        if (reusableRetry || reusableLocked) {
          prepared.push({
            row: current,
            candidate: candidate
          });

          if (reusableRetry) {
            result.reused_retryable_count++;
          }

          return;
        }

        result.blocked_count++;
        return;
      }

      var row = buildRow(candidate, date, null);

      row.status = 'DELIVERY_PENDING';
      row.first_sent_at = null;
      row.monitor_source = identity.monitor_source;
      row.plan_lock_id = identity.plan_lock_id;

      row.raw_payload = Object.assign(
        {},
        row.raw_payload || {},
        {
          monitor_source: identity.monitor_source,
          plan_lock_id: identity.plan_lock_id,
          trade_plan_source:
            identity.trade_plan_source || null,
          telegram_delivery_status:
            'DELIVERY_PENDING',
          telegram_delivery_prepared_at:
            nowIso
        }
      );

      toInsert.push({
        key: key,
        candidate: candidate,
        row: row
      });
    });

    if (toInsert.length) {
      var insert = await supabase
        .from('telegram_daily_picks')
        .insert(
          toInsert.map(function(item) {
            return item.row;
          })
        )
        .select('*');

      if (insert.error) {
        result.reason =
          insert.error.code === '23505'
            ? 'concurrent_delivery_claim'
            : 'delivery_store_insert_failed';

        result.error = insert.error.message;
        return result;
      }

      var inserted = insert.data || [];

      if (inserted.length !== toInsert.length) {
        result.reason =
          'delivery_store_missing_row_ids';
        return result;
      }

      inserted.forEach(function(row, index) {
        prepared.push({
          row: row,
          candidate: toInsert[index].candidate
        });
      });

      result.inserted_count = inserted.length;
    }

    if (!prepared.length) {
      result.reason =
        result.blocked_count > 0
          ? 'delivery_state_blocks_retry'
          : (
              result.duplicate_count > 0
                ? 'already_delivered'
                : 'no_valid_candidates'
            );

      return result;
    }

    var rowIds = prepared.map(function(item) {
      return item.row.id;
    });

    if (
      rowIds.some(function(id) {
        return id == null;
      })
    ) {
      result.reason =
        'delivery_store_missing_row_ids';
      return result;
    }

    var claim = await supabase
      .from('telegram_daily_picks')
      .update({
        status: 'DELIVERY_IN_PROGRESS',
        updated_at: nowIso
      })
      .in('id', rowIds)
      .in(
        'status',
        [
          'DELIVERY_PENDING',
          'DELIVERY_RETRYABLE',
          'WAITING'
        ]
      )
      .select('id');

    if (claim.error) {
      result.reason =
        'delivery_store_claim_failed';
      result.error = claim.error.message;
      return result;
    }

    if (
      (claim.data || []).length !==
      rowIds.length
    ) {
      result.reason =
        'delivery_claim_conflict';
      result.blocked_count +=
        rowIds.length -
        (claim.data || []).length;
      return result;
    }

    result.ready = true;
    result.row_ids = rowIds;

    result.send_candidates =
      prepared.map(function(item) {
        return item.candidate;
      });

    result.prepared_count =
      prepared.length;

    return result;
  } catch (error) {
    result.reason = 'delivery_prepare_exception';
    result.error = String(
      error && error.message || error
    ).slice(0, 180);

    return result;
  }
}

async function finalizePreparedDelivery(options) {
  options = options || {};

  var supabase = options.supabase;
  var preparation = options.preparation || {};
  var sendResults =
    Array.isArray(options.send_results)
      ? options.send_results
      : [options.send_result || {}];

  var summary =
    summarizeTelegramResults(sendResults);

  var classified = {
    state: summary.delivery_state,
    delivered:
      summary.delivery_state === 'delivered',
    uncertain:
      summary.delivery_state ===
        'delivery_uncertain',
    permanent:
      summary.delivery_state ===
        'permanent_failure'
  };

  if (preparation.legacy_fallback) {
    return {
      summary: summary,
      delivery_state: classified.state,
      persistence_ok: true,
      monitor_registered_count: 0,
      error: null
    };
  }

  var ids = preparation.row_ids || [];

  if (!ids.length) {
    return {
      summary: summary,
      delivery_state: 'delivery_uncertain',
      persistence_ok: false,
      monitor_registered_count: 0,
      error: 'missing_delivery_row_ids'
    };
  }

  var status = 'DELIVERY_RETRYABLE';

  if (classified.delivered) {
    status = 'WAITING';
  } else if (classified.uncertain) {
    status = 'DELIVERY_UNCERTAIN';
  } else if (classified.permanent) {
    status = 'DELIVERY_FAILED';
  }

  var update = {
    status: status,
    updated_at: new Date().toISOString()
  };

  if (classified.delivered) {
    update.first_sent_at =
      new Date().toISOString();
  }

  try {
    var saved = await supabase
      .from('telegram_daily_picks')
      .update(update)
      .in('id', ids);

    if (saved.error) {
      return {
        summary: summary,
        delivery_state: 'delivery_uncertain',
        persistence_ok: false,
        monitor_registered_count: 0,
        error: saved.error.message
      };
    }

    return {
      summary: summary,
      delivery_state: classified.state,
      persistence_ok: true,
      monitor_registered_count:
        classified.delivered ? ids.length : 0,
      error: null
    };
  } catch (error) {
    return {
      summary: summary,
      delivery_state: 'delivery_uncertain',
      persistence_ok: false,
      monitor_registered_count: 0,
      error: String(
        error && error.message || error
      ).slice(0, 180)
    };
  }
}

function attachDeliveryTelemetry(
  target,
  preparation,
  finalization
) {
  target = target || {};
  preparation = preparation || {};
  finalization = finalization || {};

  var summary =
    finalization.summary || {
      attempted_count: 0,
      sent_count: 0,
      failed_count: 0,
      skipped_count: 0,
      uncertain_count: 0,
      retryable_count: 0,
      permanent_failure_count: 0,
      partial_count: 0,
      chunks_sent: 0,
      chunks_total: 0
    };

  target.telegram_delivery_state =
    finalization.delivery_state ||
    preparation.reason ||
    'not_attempted';

  target.telegram_delivery_attempted_count =
    summary.attempted_count || 0;

  target.telegram_delivery_sent_count =
    summary.sent_count || 0;

  target.telegram_delivery_failed_count =
    summary.failed_count || 0;

  target.telegram_delivery_skipped_count =
    summary.skipped_count || 0;

  target.telegram_delivery_uncertain_count =
    summary.uncertain_count || 0;

  target.telegram_delivery_partial_count =
    summary.partial_count || 0;

  target.telegram_delivery_chunks_sent =
    summary.chunks_sent || 0;

  target.telegram_delivery_chunks_total =
    summary.chunks_total || 0;

  target.delivery_prepared_count =
    preparation.prepared_count || 0;

  target.delivery_inserted_count =
    preparation.inserted_count || 0;

  target.delivery_duplicate_count =
    preparation.duplicate_count || 0;

  target.delivery_blocked_count =
    preparation.blocked_count || 0;

  target.delivery_persistence_ok =
    finalization.persistence_ok === true;

  if (!preparation.legacy_fallback) {
    target.monitor_registered =
      finalization.monitor_registered_count || 0;
  }

  if (finalization.error) {
    target.monitor_error = finalization.error;
  }

  return target;
}

module.exports = {
  prepareCandidatesForDelivery:
    prepareCandidatesForDelivery,

  finalizePreparedDelivery:
    finalizePreparedDelivery,

  attachDeliveryTelemetry:
    attachDeliveryTelemetry,

  classifyTelegramResult:
    classifyTelegramResult,

  summarizeTelegramResults:
    summarizeTelegramResults,

  rowWasDelivered:
    rowWasDelivered,

  rowBlocksRetry:
    rowBlocksRetry,

  isSilentMonitorSource:
    isSilentMonitorSource,

  monitorRowIsTrackable:
    monitorRowIsTrackable,

  monitorRowIsPublicNotificationEligible:
    monitorRowIsPublicNotificationEligible,

  normalizeDeliveryStatus:
    normalizeDeliveryStatus
};
