'use strict';

/**
 * SDK event  ->  flat { column_name: scalar } map for the PostgreSQL
 * login_events / session_events / payment_events tables.
 *
 * Nothing is stored as JSON. Every SDK field becomes its own typed column:
 *
 *   camelCase key            -> snake_case column      (holdTimeMs   -> hold_time_ms)
 *   nested object            -> prefixed columns       (parts.canvas -> parts_canvas)
 *   small numeric array (<=4) -> numbered columns      (intervalMs[1] -> interval_ms_2)
 *   any other array          -> one TEXT column, items joined with ' | '
 *                                (fonts -> 'Arial | Calibri | ...')
 *
 * The same rules are used by the static column catalog (sdk-event-columns.js),
 * by the runtime auto-column logic and by scripts/pg-sdk-columns.js, so the
 * column a value lands in is always predictable.
 */

const crypto = require('crypto');

const LIST_SEPARATOR = ' | ';
const MAX_SPLIT_NUMERIC_ARRAY = 4; // numeric arrays up to this length get one column per item
const MAX_DEPTH = 4;
const PG_IDENTIFIER_MAX = 63;

// SDK envelope keys: these are mapped onto fixed envelope columns instead of
// becoming SDK feature columns (see ENVELOPE_COLUMNS in sdk-event-columns.js).
const ENVELOPE_SDK_KEYS = new Set(['type', 'name', 't', 'sessionId', 'userId', 'page', 'pageType']);

// Column names the envelope owns. An SDK field that would map onto one of
// these (e.g. a custom prop called "id") is prefixed with "sdk_".
const RESERVED_COLUMNS = new Set([
  'id', 'tenant_id', 'app_id', 'session_id', 'user_id', 'device_fingerprint', 'client_ip',
  'event_type', 'event_name', 'event_category', 'page', 'page_type', 'sdk_t_ms',
  'batch_id', 'batch_seq', 'received_at',
]);

function snakeCase(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Turn a path of SDK keys into a safe, deterministic PostgreSQL column name. */
function columnNameFor(pathParts) {
  let name = pathParts
    .map((p) => snakeCase(p))
    .join('_')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) name = 'field';
  if (!/^[a-z]/.test(name)) name = `f_${name}`;
  if (RESERVED_COLUMNS.has(name)) name = `sdk_${name}`;
  if (name.length > PG_IDENTIFIER_MAX) {
    const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
    name = `${name.slice(0, PG_IDENTIFIER_MAX - 9)}_${hash}`;
  }
  return name;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function primitiveToText(v) {
  if (v === null || v === undefined) return '';
  if (isPlainObject(v)) {
    // Arrays of objects never occur in the current SDK; keep them readable
    // without falling back to JSON: "k=v;k=v".
    return Object.entries(v).map(([k, x]) => `${k}=${primitiveToText(x)}`).join(';');
  }
  if (Array.isArray(v)) return v.map(primitiveToText).join(',');
  return String(v);
}

/**
 * Flatten one SDK event (minus the envelope keys) into a column map.
 * Values are JS scalars: number | boolean | string | null.
 */
function flattenEvent(evt) {
  return flattenObject(evt, [], ENVELOPE_SDK_KEYS);
}

/**
 * Flatten any plain object with the rules above. `basePath` prefixes every
 * column (e.g. ['metadata'] -> metadata_<key>); keys in `skipKeys` are ignored.
 */
function flattenObject(obj, basePath = [], skipKeys = null) {
  const out = {};

  const visit = (value, path, depth) => {
    if (value === undefined) return;
    const col = columnNameFor(path);

    if (value === null) {
      if (!(col in out)) out[col] = null;
      return;
    }
    if (typeof value === 'number') {
      out[col] = Number.isFinite(value) ? value : null;
      return;
    }
    if (typeof value === 'boolean' || typeof value === 'string') {
      out[col] = value;
      return;
    }
    if (typeof value === 'bigint') {
      out[col] = Number(value);
      return;
    }
    if (value instanceof Date) {
      out[col] = value.toISOString();
      return;
    }
    if (Array.isArray(value)) {
      const numeric = value.length > 0 && value.every((x) => x === null || typeof x === 'number');
      if (numeric && value.length <= MAX_SPLIT_NUMERIC_ARRAY) {
        value.forEach((x, i) => {
          out[columnNameFor([...path, String(i + 1)])] = typeof x === 'number' && Number.isFinite(x) ? x : null;
        });
      } else {
        out[col] = value.length ? value.map(primitiveToText).join(LIST_SEPARATOR) : '';
      }
      return;
    }
    if (isPlainObject(value)) {
      if (depth >= MAX_DEPTH) {
        out[col] = primitiveToText(value);
        return;
      }
      for (const [k, v] of Object.entries(value)) visit(v, [...path, k], depth + 1);
      return;
    }
    out[col] = String(value);
  };

  for (const [key, value] of Object.entries(obj || {})) {
    if (skipKeys && skipKeys.has(key)) continue;
    visit(value, [...basePath, key], 1);
  }
  return out;
}

/** snake_case column suffix -> camelCase key (used to rebuild API objects). */
function camelCase(snake) {
  return String(snake).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** PostgreSQL type for a JS value seen for the first time. */
function inferSqlType(value) {
  if (typeof value === 'number') return 'DOUBLE PRECISION';
  if (typeof value === 'boolean') return 'BOOLEAN';
  return 'TEXT';
}

module.exports = {
  flattenEvent,
  flattenObject,
  camelCase,
  columnNameFor,
  snakeCase,
  inferSqlType,
  ENVELOPE_SDK_KEYS,
  RESERVED_COLUMNS,
  LIST_SEPARATOR,
  MAX_SPLIT_NUMERIC_ARRAY,
};
