/**
 * Display helpers: money, category emoji, phone masking and WhatsApp template-parameter sanitising.
 * Ported from legacy/Code.gs (formatEuro, STANDARD_BUDGET_ICON_LIBRARY/getBudgetCategoryEmoji,
 * maskPhoneForLog, roundCurrency) and generalised to any currency.
 */

/** Rounds to cents with Math.round (same as the POC); non-numbers become 0. Never returns -0. */
export function roundCurrency(value: number | null | undefined): number {
	return Math.round((Number(value) || 0) * 100) / 100 || 0;
}

const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** Formats money with two decimals, e.g. formatMoney(1234.5, 'EUR') → "€1,234.50". */
export function formatMoney(value: number | null | undefined, currency: string): string {
	const code = currency.toUpperCase();
	let formatter = moneyFormatters.get(code);
	if (!formatter) {
		try {
			formatter = new Intl.NumberFormat('en-IE', {
				style: 'currency',
				currency: code,
				minimumFractionDigits: 2,
				maximumFractionDigits: 2,
			});
		} catch {
			// Not an ISO 4217 code Intl knows — fall back to "XYZ 1,234.56".
			return `${code} ${roundCurrency(value).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
		}
		moneyFormatters.set(code, formatter);
	}
	return formatter.format(roundCurrency(value));
}

/** BudgetBakers standard category/group names → emoji (keys are lower-case). */
export const STANDARD_BUDGET_ICON_LIBRARY: Readonly<Record<string, string>> = {
	'alcohol, tobacco': '🍷',
	'bar cafe': '☕',
	'clothes & shoes': '👕',
	drugstore: '🧴',
	'electronics & accessories': '💻',
	'financial expenses': '🏦',
	'food & drinks': '🍽️',
	fuel: '⛽',
	groceries: '🛒',
	'home & garden': '🏡',
	housing: '🏠',
	income: '💰',
	investments: '📈',
	kids: '🧸',
	'life & entertainment': '🎭',
	others: '📦',
	parking: '🅿️',
	'pc, communication': '📱',
	'restaurants & fast food': '🍔',
	shopping: '🛍️',
	transportation: '🚗',
	unknown: '❓',
	vehicle: '🚘',
	'vehicle maintenance': '🔧',
};

/** Keyword fallbacks, checked in order against "<name> <group>" when there is no exact match. */
const EMOJI_KEYWORDS: ReadonlyArray<readonly [keywords: readonly string[], libraryKey: string]> = [
	[['bar', 'cafe'], 'bar cafe'],
	[['restaurant', 'fast food'], 'restaurants & fast food'],
	[['grocery', 'groceries'], 'groceries'],
	[['alcohol', 'tobacco'], 'alcohol, tobacco'],
	[['clothes', 'shoes'], 'clothes & shoes'],
	[['drugstore'], 'drugstore'],
	[['electronics'], 'electronics & accessories'],
	[['home', 'garden'], 'home & garden'],
	[['kids'], 'kids'],
	[['food'], 'food & drinks'],
	[['housing'], 'housing'],
	[['shopping'], 'shopping'],
	[['vehicle'], 'vehicle'],
	[['transport'], 'transportation'],
	[['pc', 'communication'], 'pc, communication'],
	[['financial'], 'financial expenses'],
	[['life', 'entertainment'], 'life & entertainment'],
	[['unknown'], 'unknown'],
	[['other'], 'others'],
];

/** Emoji for a budget line: exact name match, then exact group match, then keyword match, else '•'. */
export function categoryEmoji(name: string | null | undefined, groupName?: string | null): string {
	const values = [name, groupName].map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean);
	for (const value of values) {
		const exact = STANDARD_BUDGET_ICON_LIBRARY[value];
		if (exact) return exact;
	}
	const key = values.join(' ');
	for (const [keywords, libraryKey] of EMOJI_KEYWORDS) {
		if (keywords.some((keyword) => key.includes(keyword))) return STANDARD_BUDGET_ICON_LIBRARY[libraryKey]!;
	}
	return '•';
}

/** Masks a phone number for logs: keeps only the last 4 digits ("***1234"). */
export function maskPhone(value: string | null | undefined): string {
	const digits = String(value ?? '').replace(/\D/g, '');
	return digits.length <= 4 ? '****' : `***${digits.slice(-4)}`;
}

/**
 * Makes a value safe for a WhatsApp template body parameter. Meta rejects parameters containing
 * newlines, tabs or more than 4 consecutive spaces, so line breaks become " · ", all other whitespace
 * runs collapse to one space, and the result is trimmed and truncated (with "…") to `maxLen`
 * characters. Empty input yields '' — Meta also rejects empty parameters, so callers pad (e.g. '–').
 */
export function sanitizeTemplateParam(value: unknown, maxLen = 200): string {
	const text = String(value ?? '')
		.trim()
		.replace(/\s*[\r\n]+\s*/g, ' · ')
		.replace(/\s+/g, ' ')
		.trim();
	const chars = Array.from(text); // code points, so emoji are never split
	if (chars.length <= maxLen) return text;
	return `${chars.slice(0, Math.max(0, maxLen - 1)).join('').trimEnd()}…`;
}
