/**
 * Dashboard JSON API (`/api/*`). Everything except /api/auth/* requires a session (see ./auth.ts).
 *
 * Errors are `{ error, code? }`; unexpected exceptions become 500 INTERNAL and are written to
 * run_log (action 'api'). State-changing requests must be same-origin when the browser sends an
 * Origin header (defence in depth next to the SameSite=Lax session cookie).
 *
 * Endpoint reference (all JSON):
 *   GET  /api/auth/status                 { authenticated, setupComplete, needsSecrets }   (no session needed)
 *   POST /api/auth/login  {password}      sets the session cookie                         (no session needed)
 *   POST /api/auth/logout                 clears it                                        (no session needed)
 *   GET  /api/status                      configuration + counts + last runs
 *   GET  /api/summary?offset=0            budget table for a period
 *   PUT  /api/targets/:entityType/:id     edit one budget target
 *   GET  /api/transactions?from&to&q&limit
 *   GET  /api/yesterday                   yesterday's included expenses (as in the brief)
 *   GET  /api/cashflow                    closing-balance history
 *   GET  /api/brief/preview               exact WhatsApp text + template params
 *   GET  /api/settings | PUT /api/settings
 *   POST /api/admin/sync {full?, force?} | capture | send-brief | test-wallet | fx-backfill {from?, all?}
 *   POST /api/admin/import/budgets (text/csv) | import/cashflow (text/csv)
 *   GET  /api/admin/logs?type=run|message&limit
 */
import { loadBudgetComputation, listYesterdayExpenses } from '../budget/engine';
import { buildBriefData, renderBriefText, renderTemplateParams } from '../budget/brief';
import { captureClosingBalances } from '../cashflow/capture';
import {
	type BudgetTargetRow,
	type CashflowRow,
	type EntityType,
	type Flag,
	clearFxRates,
	countCoreRows,
	defaultIncludeInExpense,
	getTarget,
	latestRunLogByAction,
	listCashflowRows,
	listCashflowTotals,
	listCategories,
	listDistinctCurrencies,
	listMessageLog,
	listRunLog,
	listTargets,
	listTransactionsBetween,
	logRun,
	reconvertTransactionsToBase,
	upsertTarget,
} from '../db/repo';
import { SETTING_DEFAULTS, getSettings, setSettings } from '../db/settings';
import type { Env } from '../env';
import { roundCurrency } from '../lib/format';
import { ensureRates } from '../lib/fx';
import { normalizeStartDay, periodForOffset } from '../lib/period';
import { addDays, localDate } from '../lib/tz';
import { WalletApiError, testWalletAuth } from '../wallet/client';
import { syncWallet } from '../wallet/sync';
import { sendDailyBrief } from '../whatsapp/client';
import { handleAuthRequest, requireAuth, secretsMissing } from './auth';
import { importBudgetsCsv, importCashflowCsv } from './imports';
import { HttpError, errorJson, errorMessage, httpErrorResponse, intParam, isDateText, json, readJsonObject, readText } from './http';
import { validateSettingsPatch } from './settings';

interface RouteContext {
	request: Request;
	env: Env;
	ctx: ExecutionContext;
	db: D1Database;
	url: URL;
	params: Record<string, string>;
}

type Handler = (c: RouteContext) => Promise<Response>;

interface Route {
	method: 'GET' | 'POST' | 'PUT';
	pattern: RegExp;
	keys: string[];
	handler: Handler;
}

const routes: Route[] = [];

function route(method: Route['method'], path: string, handler: Handler): void {
	const keys: string[] = [];
	const source = path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
		keys.push(key);
		return '([^/]+)';
	});
	routes.push({ method, pattern: new RegExp(`^${source}/?$`), keys, handler });
}

/** run_log actions summarised by GET /api/status (sync, brief, capture, cron dispatcher). */
const LAST_RUN_ACTIONS = { sync: 'walletSync', brief: 'whatsapp.brief', capture: 'capture', scheduled: 'scheduled' } as const;

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/**
 * Handles `/api` and `/api/*`; returns null for any other path so the caller can fall through
 * (static assets, webhook, ...).
 */
export async function handleApiRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
	const url = new URL(request.url);
	const { pathname } = url;
	if (pathname !== '/api' && !pathname.startsWith('/api/')) return null;
	const method = request.method.toUpperCase();

	try {
		if (method !== 'GET' && method !== 'HEAD') {
			const origin = request.headers.get('Origin');
			if (origin && origin !== url.origin) return errorJson(403, 'Cross-origin request refused.', 'BAD_ORIGIN');
		}

		if (pathname.startsWith('/api/auth/')) {
			return (await handleAuthRequest(request, env, pathname)) ?? errorJson(404, 'Not found.', 'NOT_FOUND');
		}

		const denied = await requireAuth(request, env);
		if (denied) return denied;

		let methodMismatch = false;
		for (const candidate of routes) {
			const match = candidate.pattern.exec(pathname);
			if (!match) continue;
			if (candidate.method !== method) {
				methodMismatch = true;
				continue;
			}
			const params: Record<string, string> = {};
			candidate.keys.forEach((key, i) => (params[key] = decodeURIComponent(match[i + 1]!)));
			return await candidate.handler({ request, env, ctx, db: env.DB, url, params });
		}
		return methodMismatch ? errorJson(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED') : errorJson(404, 'Not found.', 'NOT_FOUND');
	} catch (error) {
		if (error instanceof HttpError) return httpErrorResponse(error);
		const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
		await logRun(env.DB, 'ERROR', 'api', `${method} ${pathname} failed: ${detail}`);
		return errorJson(500, 'Something went wrong on the server. Details are in the run log.', 'INTERNAL');
	}
}

// ---------------------------------------------------------------------------------------------
// Status, summary, targets
// ---------------------------------------------------------------------------------------------

route('GET', '/api/status', async ({ env, db }) => {
	const [settings, counts, latest] = await Promise.all([getSettings(db), countCoreRows(db), latestRunLogByAction(db, Object.values(LAST_RUN_ACTIONS))]);
	const lastRun = Object.fromEntries(
		Object.entries(LAST_RUN_ACTIONS).map(([name, action]) => {
			const row = latest.get(action);
			return [name, row ? { ts: row.ts, level: row.level, message: row.message } : null];
		}),
	);
	return json({
		setupComplete: settings.setup_complete === '1',
		walletConfigured: !!env.WALLET_API_TOKEN?.trim(),
		whatsappConfigured: !!(env.WHATSAPP_ACCESS_TOKEN?.trim() && env.WHATSAPP_PHONE_NUMBER_ID?.trim()),
		webhookConfigured: !!(env.META_APP_SECRET?.trim() && env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim()),
		aiConfigured: !!env.ANTHROPIC_API_KEY?.trim(),
		dashboardSecured: !secretsMissing(env),
		baseCurrency: settings.base_currency,
		timezone: settings.timezone,
		counts,
		lastRun,
	});
});

route('GET', '/api/summary', async ({ db, url }) => {
	const offset = intParam(url, 'offset', 0, -240, 24);
	const settings = await getSettings(db);
	const [computation, targets] = await Promise.all([loadBudgetComputation(db, settings, new Date(), offset), listTargets(db)]);
	return json({
		offset,
		period: computation.period,
		todayLocal: computation.todayLocal,
		missingFxCount: computation.missingFxCount,
		lines: computation.lines,
		currency: settings.base_currency,
		// Stored targets keyed "category:<id>" / "group:<id>": the engine reports a missing budget as 0,
		// the editor needs to tell "no target" (null) from an explicit 0.
		targets: Object.fromEntries(targets.map((t) => [`${t.entityType}:${t.entityId}`, { budget: t.budget, period: t.period }])),
	});
});

const TARGET_FIELDS = new Set(['budget', 'forecastType', 'includeInReport', 'includeInExpense', 'period']);

route('PUT', '/api/targets/:entityType/:entityId', async ({ request, db, params }) => {
	const entityType = params.entityType as EntityType;
	const entityId = params.entityId!;
	if (entityType !== 'category' && entityType !== 'group') {
		throw new HttpError(400, 'entityType must be "category" or "group".', 'VALIDATION');
	}
	const body = await readJsonObject(request);
	const keys = Object.keys(body);
	const unknown = keys.filter((key) => !TARGET_FIELDS.has(key));
	if (unknown.length > 0) throw new HttpError(400, `Unknown field(s): ${unknown.join(', ')}.`, 'VALIDATION');
	if (keys.length === 0) throw new HttpError(400, 'Nothing to update.', 'VALIDATION');

	const patch: Partial<BudgetTargetRow> = {};
	const fields: Record<string, string> = {};
	if ('budget' in body) {
		const budget = body.budget;
		if (budget === null) patch.budget = null;
		else if (typeof budget === 'number' && Number.isFinite(budget) && budget >= 0 && budget < 1e12) patch.budget = roundCurrency(budget);
		else fields.budget = 'Budget must be a number ≥ 0, or null for no target.';
	}
	if ('forecastType' in body) {
		if (body.forecastType === 'day_to_day' || body.forecastType === 'recurring') patch.forecastType = body.forecastType;
		else fields.forecastType = 'Forecast type must be "day_to_day" or "recurring".';
	}
	for (const key of ['includeInReport', 'includeInExpense'] as const) {
		if (!(key in body)) continue;
		if (typeof body[key] === 'boolean') patch[key] = (body[key] ? 1 : 0) as Flag;
		else fields[key] = `${key} must be true or false.`;
	}
	if ('period' in body) {
		const period = typeof body.period === 'string' ? body.period.trim().toLowerCase() : '';
		if (/^[a-z_]{1,32}$/.test(period)) patch.period = period;
		else fields.period = 'Period must be a short word such as "monthly".';
	}
	if (Object.keys(fields).length > 0) {
		throw new HttpError(400, Object.values(fields).join(' '), 'VALIDATION', { fields });
	}

	const [existing, categories] = await Promise.all([getTarget(db, entityType, entityId), listCategories(db)]);
	const owner =
		entityType === 'category' ? categories.find((c) => c.id === entityId) : categories.find((c) => c.groupId === entityId);
	if (!existing && !owner) throw new HttpError(404, `Unknown ${entityType} "${entityId}".`, 'NOT_FOUND');

	const target: BudgetTargetRow = {
		...(existing ?? {
			entityType,
			entityId,
			period: 'monthly',
			forecastType: 'day_to_day',
			budget: null,
			includeInReport: 0,
			includeInExpense: defaultIncludeInExpense(owner?.groupName),
		}),
		...patch,
		entityType,
		entityId,
	};
	await upsertTarget(db, target);
	return json({ target });
});

// ---------------------------------------------------------------------------------------------
// Transactions, yesterday, cash flow, brief
// ---------------------------------------------------------------------------------------------

route('GET', '/api/transactions', async ({ db, url }) => {
	const settings = await getSettings(db);
	const today = localDate(new Date(), settings.timezone);
	const current = periodForOffset(today, normalizeStartDay(Number(settings.budget_month_start_day)), 0);
	const from = url.searchParams.get('from') || current.startText;
	const to = url.searchParams.get('to') || current.endText;
	if (!isDateText(from) || !isDateText(to)) throw new HttpError(400, 'from and to must be dates (yyyy-mm-dd).', 'VALIDATION');
	if (from > to) throw new HttpError(400, '"from" must not be after "to".', 'VALIDATION');
	const limit = intParam(url, 'limit', 200, 1, 500);
	const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();

	const [rows, categories] = await Promise.all([listTransactionsBetween(db, from, addDays(to, 1)), listCategories(db)]);
	const byId = new Map(categories.map((category) => [category.id, category]));
	const enriched = rows
		.map((row) => {
			const category = row.categoryId ? byId.get(row.categoryId) : undefined;
			return {
				...row,
				categoryName: category?.name ?? null,
				categoryPath: category ? category.fullPath || category.name : null,
				groupName: category?.groupName ?? null,
			};
		})
		.filter((row) => !q || [row.categoryPath, row.accountName, row.note].some((value) => value?.toLowerCase().includes(q)))
		.reverse(); // newest first

	const sums = enriched.reduce(
		(acc, row) => {
			if (row.recordType?.toLowerCase() === 'expense') acc.expenses += -(row.amountBase ?? 0);
			else if (row.recordType?.toLowerCase() === 'income') acc.income += row.amountBase ?? 0;
			if (row.amountBase === null) acc.missingFx++;
			return acc;
		},
		{ expenses: 0, income: 0, missingFx: 0 },
	);
	return json({
		from,
		to,
		q,
		currency: settings.base_currency,
		total: enriched.length,
		truncated: enriched.length > limit,
		totals: { expenses: roundCurrency(sums.expenses), income: roundCurrency(sums.income), missingFx: sums.missingFx },
		transactions: enriched.slice(0, limit),
	});
});

route('GET', '/api/yesterday', async ({ db }) => {
	const settings = await getSettings(db);
	const now = new Date();
	const expenses = await listYesterdayExpenses(db, settings, now);
	return json({
		date: addDays(localDate(now, settings.timezone), -1),
		currency: settings.base_currency,
		total: roundCurrency(expenses.reduce((sum, expense) => sum + expense.amountBase, 0)),
		expenses,
	});
});

route('GET', '/api/cashflow', async ({ db }) => {
	const [settings, totalRows, allRows] = await Promise.all([getSettings(db), listCashflowTotals(db, 25), listCashflowRows(db)]);
	const closing = (row: CashflowRow) => row.closingBalanceBase ?? row.closingBalance;
	// Newest first; the 25th row only provides the "change" of the 24th.
	const totals = totalRows.slice(0, 24).map((row, index) => {
		const prior = totalRows[index + 1];
		return {
			...row,
			closing: closing(row),
			change: prior ? roundCurrency(closing(row) - closing(prior)) : 0,
			hasPrior: !!prior,
		};
	});
	const accounts: Record<string, CashflowRow[]> = {};
	for (const row of allRows) if (row.rowType === 'ACCOUNT') (accounts[row.periodEnd] ??= []).push(row);
	return json({ currency: settings.base_currency, totals, accounts });
});

route('GET', '/api/brief/preview', async ({ db }) => {
	const settings = await getSettings(db);
	const data = await buildBriefData(db, settings, new Date());
	return json({ text: renderBriefText(data), params: renderTemplateParams(data), data });
});

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

route('GET', '/api/settings', async ({ db }) => {
	return json({ settings: await getSettings(db), defaults: SETTING_DEFAULTS });
});

route('PUT', '/api/settings', async ({ request, db }) => {
	const body = await readJsonObject(request);
	if (Object.keys(body).length === 0) throw new HttpError(400, 'Nothing to update.', 'VALIDATION');
	const { values, errors } = validateSettingsPatch(body);
	if (Object.keys(errors).length > 0) {
		throw new HttpError(400, Object.entries(errors).map(([key, message]) => `${key}: ${message}`).join(' '), 'VALIDATION', { fields: errors });
	}

	const before = await getSettings(db);
	await setSettings(db, values);

	let warning: string | undefined;
	if (values.base_currency && values.base_currency !== before.base_currency.toUpperCase()) {
		await clearFxRates(db);
		warning =
			`Base currency changed from ${before.base_currency} to ${values.base_currency}: cached exchange rates were cleared. ` +
			'Run an FX backfill with "re-convert all" (or a full sync) so stored amounts are converted to the new currency. ' +
			'Budget targets and cash-flow history keep their old values.';
		await logRun(db, 'WARN', 'settings', warning);
	}
	return json({ settings: await getSettings(db), ...(warning ? { warning } : {}) });
});

// ---------------------------------------------------------------------------------------------
// Admin actions
// ---------------------------------------------------------------------------------------------

function optionalBoolean(body: Record<string, unknown>, url: URL, key: string): boolean {
	const value = body[key] ?? url.searchParams.get(key);
	if (value === undefined || value === null) return false;
	if (typeof value === 'boolean') return value;
	if (value === 1 || value === '1' || value === 'true') return true;
	if (value === 0 || value === '0' || value === 'false' || value === '') return false;
	throw new HttpError(400, `"${key}" must be true or false.`, 'VALIDATION');
}

route('POST', '/api/admin/sync', async ({ request, env, db, url }) => {
	const body = await readJsonObject(request);
	const full = optionalBoolean(body, url, 'full');
	const force = optionalBoolean(body, url, 'force');
	try {
		const result = await syncWallet(env, db, { full, force });
		return json({ ok: true, full, ...result });
	} catch (error) {
		if (!(error instanceof WalletApiError)) throw error;
		if (error.code === 'WALLET_SYNC_IN_PROGRESS') {
			// BudgetBakers is still importing the account after the token was created (HTTP 409).
			return json({ ok: false, pending: true, code: error.code, message: error.message, retryAfterSeconds: error.retryAfterSeconds ?? 300 }, 202);
		}
		return errorJson(502, error.message, error.code, error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {});
	}
});

route('POST', '/api/admin/capture', async ({ db }) => {
	const settings = await getSettings(db);
	return json({ ok: true, ...(await captureClosingBalances(db, settings, new Date())) });
});

route('POST', '/api/admin/send-brief', async ({ env, db }) => {
	const settings = await getSettings(db);
	const dryRun = settings.dry_run === '1';
	const outcome = await sendDailyBrief(env, db, new Date());
	return json({
		ok: !outcome.results.some((result) => result.error),
		dryRun,
		note: dryRun
			? 'dry_run is on: the brief was built and logged but not sent. Turn dry_run off in Settings to deliver it.'
			: 'Sent to every configured recipient (free-form text inside the 24h window, the template otherwise).',
		...outcome,
	});
});

route('POST', '/api/admin/test-wallet', async ({ env, db }) => {
	const result = await testWalletAuth(env);
	await logRun(
		db,
		result.ok ? 'INFO' : 'WARN',
		'testWallet',
		result.ok ? 'Wallet API token works.' : `Wallet API token check failed: ${result.code}: ${result.message}`,
	);
	return json(result);
});

route('POST', '/api/admin/fx-backfill', async ({ request, db, url }) => {
	const body = await readJsonObject(request);
	const settings = await getSettings(db);
	const base = settings.base_currency.toUpperCase();
	const today = localDate(new Date(), settings.timezone);
	const from = typeof body.from === 'string' && body.from ? body.from : (url.searchParams.get('from') ?? settings.sync_backfill_from);
	if (!isDateText(from)) throw new HttpError(400, '"from" must be a date (yyyy-mm-dd).', 'VALIDATION');
	if (from > today) throw new HttpError(400, '"from" must not be in the future.', 'VALIDATION');
	const all = optionalBoolean(body, url, 'all');

	const currencies = (await listDistinctCurrencies(db)).filter((currency) => currency !== base);
	let ratesFetched = 0;
	try {
		ratesFetched = currencies.length > 0 ? await ensureRates(db, base, currencies, from, today) : 0;
	} catch (error) {
		await logRun(db, 'ERROR', 'fxBackfill', `Fetching rates failed: ${errorMessage(error)}`);
		return errorJson(502, `Could not fetch exchange rates: ${errorMessage(error)}`, 'FX_ERROR');
	}
	const { updated, stillMissing } = await reconvertTransactionsToBase(db, base, { all });
	const reconverted = Math.max(0, updated - stillMissing);
	await logRun(
		db,
		stillMissing ? 'WARN' : 'INFO',
		'fxBackfill',
		`FX backfill from ${from} for ${currencies.join(', ') || 'no foreign currencies'}: ${ratesFetched} rate(s) fetched, ` +
			`${reconverted} transaction(s) ${all ? 're-converted' : 'converted'}, ${stillMissing} still without a rate.`,
	);
	return json({ ok: true, from, currencies, ratesFetched, reconverted, stillMissing });
});

function csvBody(request: Request): Promise<string> {
	return readText(request).then((text) => {
		if (!text.trim()) throw new HttpError(400, 'Send the CSV file as the request body (Content-Type: text/csv).', 'VALIDATION');
		return text;
	});
}

route('POST', '/api/admin/import/budgets', async ({ request, db }) => {
	return json({ ok: true, ...(await importBudgetsCsv(db, await csvBody(request))) });
});

route('POST', '/api/admin/import/cashflow', async ({ request, db }) => {
	const csv = await csvBody(request);
	return json({ ok: true, ...(await importCashflowCsv(db, await getSettings(db), csv)) });
});

route('GET', '/api/admin/logs', async ({ db, url }) => {
	const type = url.searchParams.get('type') ?? 'run';
	if (type !== 'run' && type !== 'message') throw new HttpError(400, 'type must be "run" or "message".', 'VALIDATION');
	const limit = intParam(url, 'limit', 50, 1, 200);
	const rows = type === 'run' ? await listRunLog(db, limit) : await listMessageLog(db, limit);
	return json({ type, rows });
});
