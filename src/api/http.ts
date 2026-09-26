/**
 * Tiny JSON-over-HTTP helpers shared by the dashboard API modules. Every API response is JSON with
 * `Cache-Control: no-store`; errors use the shape `{ error: string, code?: string, ...extra }`.
 */

export class HttpError extends Error {
	readonly status: number;
	readonly code?: string;
	readonly extra?: Record<string, unknown>;

	constructor(status: number, message: string, code?: string, extra?: Record<string, unknown>) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
		this.code = code;
		this.extra = extra;
	}
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
	});
}

export function errorJson(status: number, error: string, code?: string, extra: Record<string, unknown> = {}): Response {
	return json({ error, ...(code ? { code } : {}), ...extra }, status);
}

export function httpErrorResponse(error: HttpError): Response {
	return errorJson(error.status, error.message, error.code, error.extra);
}

/** Largest request body the API reads (CSV imports included). */
export const MAX_BODY_BYTES = 2_000_000;

export async function readText(request: Request): Promise<string> {
	const declared = Number(request.headers.get('Content-Length'));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large (max 2 MB).', 'TOO_LARGE');
	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large (max 2 MB).', 'TOO_LARGE');
	return text;
}

/** Parses a JSON object body; an empty body is `{}`. Anything else → 400. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
	const text = (await readText(request)).trim();
	if (text === '') return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new HttpError(400, 'Request body is not valid JSON.', 'BAD_JSON');
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new HttpError(400, 'Request body must be a JSON object.', 'BAD_JSON');
	}
	return value as Record<string, unknown>;
}

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date in 'yyyy-mm-dd' form (rejects 2026-02-30). */
export function isDateText(value: unknown): value is string {
	if (typeof value !== 'string' || !DATE_TEXT.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Parses an optional integer query parameter within [min, max]; 400 otherwise. */
export function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
	const raw = url.searchParams.get(name);
	if (raw === null || raw.trim() === '') return fallback;
	if (!/^-?\d+$/.test(raw.trim())) throw new HttpError(400, `Query parameter "${name}" must be an integer.`, 'VALIDATION');
	const value = Number(raw);
	if (value < min || value > max) throw new HttpError(400, `Query parameter "${name}" must be between ${min} and ${max}.`, 'VALIDATION');
	return value;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
