import { describe, expect, it } from 'vitest';
import { categoryEmoji, formatMoney, maskPhone, roundCurrency, sanitizeTemplateParam } from '../src/lib/format';

describe('roundCurrency', () => {
	it('rounds to cents and treats non-numbers as 0', () => {
		expect(roundCurrency(12.345678)).toBe(12.35);
		expect(roundCurrency(-3.333)).toBe(-3.33);
		expect(roundCurrency(null)).toBe(0);
		expect(roundCurrency(Number.NaN)).toBe(0);
	});

	it('never returns negative zero', () => {
		expect(Object.is(roundCurrency(-0.001), 0)).toBe(true);
	});
});

describe('formatMoney', () => {
	it('formats EUR like the POC ("€1,234.56")', () => {
		expect(formatMoney(1234.56, 'EUR')).toBe('€1,234.56');
		expect(formatMoney(1234.5, 'EUR')).toBe('€1,234.50');
		expect(formatMoney(1234567.891, 'EUR')).toBe('€1,234,567.89');
		expect(formatMoney(0, 'EUR')).toBe('€0.00');
		expect(formatMoney(null, 'EUR')).toBe('€0.00');
		expect(formatMoney(-12.5, 'EUR')).toBe('-€12.50');
		expect(formatMoney(-0.001, 'EUR')).toBe('€0.00');
	});

	it('supports other currencies and lower-case codes', () => {
		expect(formatMoney(10, 'gbp')).toBe('£10.00');
		expect(formatMoney(1500, 'ZAR')).toMatch(/^ZAR\s1,500\.00$/);
	});

	it('falls back for codes Intl does not accept', () => {
		expect(formatMoney(1234.5, 'X1')).toBe('X1 1,234.50');
	});
});

describe('categoryEmoji', () => {
	it('matches exact standard names first, case-insensitively', () => {
		expect(categoryEmoji('Groceries', 'Food & Drinks')).toBe('🛒');
		expect(categoryEmoji('FUEL', '')).toBe('⛽');
		expect(categoryEmoji('Vehicle maintenance', 'Vehicle')).toBe('🔧');
	});

	it('then the exact group name', () => {
		expect(categoryEmoji('Weekly shop', 'Food & Drinks')).toBe('🍽️');
		expect(categoryEmoji('Salary', 'Income')).toBe('💰');
	});

	it('then keywords in name + group', () => {
		expect(categoryEmoji('Coffee bar', null)).toBe('☕');
		expect(categoryEmoji('Kids stuff')).toBe('🧸');
		expect(categoryEmoji('Public transport', 'Travel')).toBe('🚗');
		expect(categoryEmoji('Misc', 'Other things')).toBe('📦');
	});

	it("falls back to '•'", () => {
		expect(categoryEmoji('Something', 'Mystery')).toBe('•');
		expect(categoryEmoji(null, null)).toBe('•');
	});
});

describe('maskPhone', () => {
	it('keeps only the last four digits', () => {
		expect(maskPhone('+353 87 123 4567')).toBe('***4567');
		expect(maskPhone('35387123456')).toBe('***3456');
	});

	it('fully masks short or empty values', () => {
		expect(maskPhone('1234')).toBe('****');
		expect(maskPhone('')).toBe('****');
		expect(maskPhone(undefined)).toBe('****');
	});
});

describe('sanitizeTemplateParam', () => {
	it('turns line breaks into " · "', () => {
		expect(sanitizeTemplateParam('Groceries\nTesco')).toBe('Groceries · Tesco');
		expect(sanitizeTemplateParam('a\r\n\r\nb')).toBe('a · b');
		expect(sanitizeTemplateParam('a \n  b')).toBe('a · b');
	});

	it('collapses tabs and runs of spaces to a single space and trims', () => {
		expect(sanitizeTemplateParam('a\tb')).toBe('a b');
		expect(sanitizeTemplateParam('a     b')).toBe('a b');
		expect(sanitizeTemplateParam('  \n lead and trail \t\n ')).toBe('lead and trail');
		expect(sanitizeTemplateParam('x')).not.toMatch(/\s{2,}|[\n\t]/);
	});

	it('stringifies non-strings and maps null/undefined to empty', () => {
		expect(sanitizeTemplateParam(12.5)).toBe('12.5');
		expect(sanitizeTemplateParam(null)).toBe('');
		expect(sanitizeTemplateParam(undefined)).toBe('');
	});

	it('truncates to maxLen characters with an ellipsis, without splitting emoji', () => {
		const long = 'x'.repeat(300);
		expect(sanitizeTemplateParam(long)).toHaveLength(200);
		expect(sanitizeTemplateParam(long).endsWith('…')).toBe(true);
		expect(sanitizeTemplateParam('abcdefghijkl', 10)).toBe('abcdefghi…');
		expect(sanitizeTemplateParam('🛒🛒🛒🛒', 3)).toBe('🛒🛒…');
		expect(sanitizeTemplateParam('exactly10!', 10)).toBe('exactly10!');
	});
});
