import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const BASE_DIR = process.cwd();
const LOCAL_STATS_PATH = process.env.USAGE_STATS_JSON_PATH
  ? path.resolve(BASE_DIR, process.env.USAGE_STATS_JSON_PATH)
  : path.resolve(BASE_DIR, '.usage-stats.json');
const DEBUG_JSONL_PATH = process.env.USAGE_DEBUG_JSONL_PATH
  ? path.resolve(BASE_DIR, process.env.USAGE_DEBUG_JSONL_PATH)
  : null;
const NEWAPI_INGEST_ENABLED = process.env.NEWAPI_INGEST_ENABLED === 'true';
const NEWAPI_INGEST_URL = process.env.NEWAPI_INGEST_URL || '';
const NEWAPI_INGEST_SECRET = process.env.NEWAPI_INGEST_SECRET || '';
const NEWAPI_INGEST_USER_ID = Number(process.env.NEWAPI_INGEST_USER_ID || 0);

function readJsonFile(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallbackValue;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error('Stats read error:', error);
    return fallbackValue;
  }
}

function writeJsonFile(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function appendJsonl(filePath, value) {
  if (!filePath) return;
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function fingerprintApiKey(apiKey) {
  if (!apiKey) return null;
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

function getHeader(request, name) {
  const headers = request?.headers || {};
  if (typeof headers.get === 'function') {
    return headers.get(name) || headers.get(name.toLowerCase()) || headers.get(name.toUpperCase()) || '';
  }

  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function extractSourceApp(request) {
  return (
    getHeader(request, 'x-source-app') ||
    getHeader(request, 'x-client-app') ||
    getHeader(request, 'x-app-id') ||
    getHeader(request, 'origin') ||
    getHeader(request, 'referer') ||
    'unknown'
  );
}

function extractApiKey(request) {
  const headerKey = getHeader(request, 'x-api-key');
  const authHeader = getHeader(request, 'authorization');
  const bearerKey = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';
  return headerKey || bearerKey || '';
}

function buildAggregateKey(record) {
  return [
    record.provider,
    record.model,
    record.source_app || 'unknown',
    record.api_key_fingerprint || 'no-key',
    record.request_path || 'unknown',
  ].join('::');
}

function emptyStatsStore(warning) {
  return {
    meta: {
      warning,
      updated_at: null,
    },
    aggregates: {},
    recent_events: [],
  };
}

export function writeUsageRecord(record) {
  const statsStore = readJsonFile(
    LOCAL_STATS_PATH,
    emptyStatsStore('Serverless environment only. This JSON file is for local validation, not production persistence.'),
  );

  const aggregateKey = buildAggregateKey(record);
  const currentAggregate = statsStore.aggregates[aggregateKey] || {
    provider: record.provider,
    model: record.model,
    source_app: record.source_app || 'unknown',
    api_key_fingerprint: record.api_key_fingerprint || null,
    request_path: record.request_path || null,
    request_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cached_input_tokens: 0,
    cache_miss_tokens: 0,
    reasoning_tokens: 0,
    success_count: 0,
    error_count: 0,
    last_seen_at: null,
  };

  currentAggregate.request_count += record.request_count || 1;
  currentAggregate.input_tokens += record.input_tokens || 0;
  currentAggregate.output_tokens += record.output_tokens || 0;
  currentAggregate.total_tokens += record.total_tokens || 0;
  currentAggregate.cached_input_tokens += record.cached_input_tokens || 0;
  currentAggregate.cache_miss_tokens += record.cache_miss_tokens || 0;
  currentAggregate.reasoning_tokens += record.reasoning_tokens || 0;
  currentAggregate.success_count += record.success ? 1 : 0;
  currentAggregate.error_count += record.success ? 0 : 1;
  currentAggregate.last_seen_at = record.created_at;

  statsStore.aggregates[aggregateKey] = currentAggregate;
  statsStore.recent_events.unshift(record);
  statsStore.recent_events = statsStore.recent_events.slice(0, 200);
  statsStore.meta.updated_at = record.created_at;

  writeJsonFile(LOCAL_STATS_PATH, statsStore);
  appendJsonl(DEBUG_JSONL_PATH, record);
  return forwardUsageRecordToNewApi(record);
}

export function createUsageRecord({
  request,
  normalizedUsage,
  requestPath,
  isStreaming = false,
  success = true,
  statusCode = 200,
  errorCode = null,
  createdAt = new Date().toISOString(),
}) {
  return {
    ...normalizedUsage,
    request_count: 1,
    request_path: requestPath || null,
    source_app: extractSourceApp(request),
    api_key_fingerprint: fingerprintApiKey(extractApiKey(request)),
    is_streaming: Boolean(isStreaming),
    success: Boolean(success),
    status_code: statusCode,
    error_code: errorCode || null,
    created_at: createdAt,
  };
}

export function getUsageSnapshot() {
  return readJsonFile(LOCAL_STATS_PATH, emptyStatsStore('No local usage stats file found.'));
}

async function forwardUsageRecordToNewApi(record) {
  if (!NEWAPI_INGEST_ENABLED) return;
  if (!NEWAPI_INGEST_URL || !NEWAPI_INGEST_SECRET) {
    console.warn('New API usage ingest skipped: NEWAPI_INGEST_URL or NEWAPI_INGEST_SECRET is missing');
    return;
  }

  const payload = {
    provider: record.provider,
    model: record.model,
    request_path: record.request_path,
    source_app: record.source_app,
    api_key_fingerprint: record.api_key_fingerprint,
    input_tokens: record.input_tokens,
    output_tokens: record.output_tokens,
    total_tokens: record.total_tokens,
    cached_input_tokens: record.cached_input_tokens,
    cache_miss_tokens: record.cache_miss_tokens,
    reasoning_tokens: record.reasoning_tokens,
    is_streaming: record.is_streaming,
    success: record.success,
    status_code: record.status_code,
    error_code: record.error_code,
    raw_usage_json: record.raw_usage_json,
    token_name: record.source_app && record.source_app !== 'unknown' ? record.source_app : 'connectmulti',
    user_id: Number.isFinite(NEWAPI_INGEST_USER_ID) ? NEWAPI_INGEST_USER_ID : 0,
  };

  try {
    const response = await fetch(NEWAPI_INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${NEWAPI_INGEST_SECRET}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn(`New API usage ingest failed: ${response.status} ${text.slice(0, 300)}`);
    }
  } catch (error) {
    console.warn('New API usage ingest error:', error.message);
  }
}
