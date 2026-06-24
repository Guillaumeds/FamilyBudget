import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = process.env.WALLET_API_BASE_URL || 'https://rest.budgetbakers.com/wallet';
const TOKEN = process.env.WALLET_API_TOKEN;
const OUT_DIR = path.resolve(process.cwd(), 'wallet-api-audit');
const LIMIT = Number(process.env.WALLET_API_LIMIT || 200);
const MAX_PAGES = Number(process.env.WALLET_API_MAX_PAGES || 50);
const ENDPOINTS = [
  { name: 'categories', path: '/v1/api/categories', paged: true },
  { name: 'accounts', path: '/v1/api/accounts', paged: true },
  { name: 'budgets', path: '/v1/api/budgets', paged: true },
  { name: 'records_may_june_2026', path: '/v1/api/records', paged: true, params: { date: 'gte.2026-05-01' } },
  { name: 'records_recent', path: '/v1/api/records', paged: true, params: { limit: LIMIT } },
  { name: 'api_usage_stats', path: '/v1/api/api-usage/stats', paged: false }
];

if (!TOKEN) {
  console.error('Missing WALLET_API_TOKEN environment variable. Set it only in this terminal session, then rerun.');
  process.exit(2);
}

await fs.mkdir(OUT_DIR, { recursive: true });
const report = [];

for (const endpoint of ENDPOINTS) {
  try {
    console.log(`Fetching ${endpoint.name}...`);
    const data = endpoint.paged ? await fetchAllPages(endpoint.path, endpoint.params || {}) : await walletFetch(endpoint.path, endpoint.params || {});
    const items = Array.isArray(data) ? data : extractItems(data);
    await writeJson(`${endpoint.name}.raw.json`, data);
    if (Array.isArray(items)) await writeJson(`${endpoint.name}.items.json`, items);
    const schema = inferSchema(Array.isArray(items) ? items : [data]);
    await writeJson(`${endpoint.name}.schema.json`, schema);
    report.push(renderEndpointReport(endpoint.name, data, items, schema));
  } catch (error) {
    report.push(`## ${endpoint.name}\n\nERROR: ${error.message}\n`);
    console.error(`${endpoint.name} failed: ${error.message}`);
  }
}

const amountReport = await buildAmountReport();
report.push(amountReport);
await fs.writeFile(path.join(OUT_DIR, 'REPORT.md'), report.join('\n\n'), 'utf8');
console.log(`Audit written to ${OUT_DIR}`);

async function fetchAllPages(endpointPath, params) {
  const all = [];
  let offset = 0;
  let page = 0;
  let lastResponse = null;
  while (page < MAX_PAGES) {
    const response = await walletFetch(endpointPath, { limit: LIMIT, ...params, offset });
    lastResponse = response;
    const items = extractItems(response);
    if (!items.length && Array.isArray(response)) break;
    for (const item of items) all.push(item);
    const nextOffset = response?.nextOffset ?? response?.next_offset ?? response?.paging?.nextOffset ?? null;
    if (nextOffset === null || nextOffset === undefined || nextOffset === '' || nextOffset === offset) break;
    offset = nextOffset;
    page++;
  }
  if (Array.isArray(lastResponse)) return all;
  return { items: all, pageEnvelopeExample: lastResponse };
}

async function walletFetch(endpointPath, params) {
  const url = new URL(BASE_URL + endpointPath);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json'
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

function extractItems(response) {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];
  for (const key of ['items', 'data', 'records', 'categories', 'accounts', 'budgets', 'results']) {
    if (Array.isArray(response[key])) return response[key];
  }
  return [];
}

function inferSchema(items) {
  const stats = {};
  for (const item of items.slice(0, 1000)) flatten(item, '', stats);
  return Object.fromEntries(Object.entries(stats).sort(([a], [b]) => a.localeCompare(b)).map(([field, stat]) => [field, {
    types: [...stat.types].sort(),
    count: stat.count,
    examples: [...stat.examples].slice(0, 8)
  }]));
}

function flatten(value, prefix, stats) {
  const field = prefix || '(root)';
  addStat(stats, field, value);
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) {
      if (item && typeof item === 'object') flatten(item, `${field}[]`, stats);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, stats);
}

function addStat(stats, field, value) {
  if (!stats[field]) stats[field] = { types: new Set(), examples: new Set(), count: 0 };
  stats[field].count++;
  stats[field].types.add(Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);
  if (value !== null && value !== undefined && typeof value !== 'object') stats[field].examples.add(String(value).slice(0, 160));
  if (typeof value === 'object' && value !== null) stats[field].examples.add(JSON.stringify(value).slice(0, 160));
}

function renderEndpointReport(name, raw, items, schema) {
  const count = Array.isArray(items) ? items.length : 'n/a';
  const fields = Object.keys(schema);
  const interesting = fields.filter(field => /amount|currency|ref|reference|convert|base|date|time|account|category|parent|name|type|id|uuid/i.test(field));
  return [`## ${name}`, '', `Items: ${count}`, '', '### Interesting fields', ...interesting.map(field => `- \`${field}\` (${schema[field].types.join(', ')}): ${schema[field].examples.join(' | ')}`), '', '### All fields', ...fields.map(field => `- \`${field}\` (${schema[field].types.join(', ')})`)].join('\n');
}

async function buildAmountReport() {
  let records = [];
  try {
    const raw = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'records_may_june_2026.items.json'), 'utf8'));
    records = Array.isArray(raw) ? raw : [];
  } catch {
    return '## Amount diagnostics\n\nNo records file available.';
  }
  const fields = new Map();
  for (const record of records.slice(0, 1000)) {
    const flat = {};
    flattenValues(record, '', flat);
    for (const [field, value] of Object.entries(flat)) {
      if (!/amount|value|currency|ref|reference|convert|base|eur/i.test(field)) continue;
      if (!fields.has(field)) fields.set(field, { numeric: 0, string: 0, examples: new Set() });
      const stat = fields.get(field);
      if (value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value))) stat.numeric++;
      if (typeof value === 'string') stat.string++;
      stat.examples.add(String(value).slice(0, 120));
    }
  }
  return ['## Amount diagnostics', '', ...[...fields.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([field, stat]) => `- \`${field}\`: numeric=${stat.numeric}, string=${stat.string}, examples=${[...stat.examples].slice(0, 8).join(' | ')}`)].join('\n');
}

function flattenValues(value, prefix, out) {
  if (!value || typeof value !== 'object') {
    out[prefix || '(root)'] = value;
    return;
  }
  if (Array.isArray(value)) {
    out[prefix || '(root)'] = JSON.stringify(value).slice(0, 200);
    return;
  }
  for (const [key, child] of Object.entries(value)) flattenValues(child, prefix ? `${prefix}.${key}` : key, out);
}

async function writeJson(fileName, data) {
  await fs.writeFile(path.join(OUT_DIR, fileName), JSON.stringify(data, null, 2), 'utf8');
}
