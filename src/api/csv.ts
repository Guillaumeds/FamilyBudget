/**
 * Minimal RFC 4180 CSV parser (no dependency): quoted fields with embedded delimiters, doubled
 * quotes ("") and line breaks; CRLF/LF/CR line endings; a leading UTF-8 BOM is ignored. The
 * delimiter is ',' unless the header line contains more ';' than ',' (European Excel exports).
 * Completely empty lines are dropped. Cells are returned untrimmed.
 */
export function parseCsv(input: string): string[][] {
	const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
	const firstLine = text.slice(0, text.search(/\r|\n/) === -1 ? text.length : text.search(/\r|\n/));
	const count = (char: string) => firstLine.split(char).length - 1;
	const delimiter = count(';') > count(',') ? ';' : ',';

	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	let fieldStarted = false;

	const endField = () => {
		row.push(field);
		field = '';
		fieldStarted = false;
	};
	const endRow = () => {
		endField();
		if (!(row.length === 1 && row[0] === '')) rows.push(row);
		row = [];
	};

	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		if (inQuotes) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}
			continue;
		}
		if (char === '"' && !fieldStarted) {
			inQuotes = true;
			fieldStarted = true;
		} else if (char === delimiter) {
			endField();
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && text[i + 1] === '\n') i++;
			endRow();
		} else {
			field += char;
			fieldStarted = true;
		}
	}
	if (field !== '' || fieldStarted || row.length > 0) endRow();
	return rows;
}

/** Lower-cased header key with punctuation/whitespace collapsed: "Include in Report?" → "include in report". */
export function normalizeHeader(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[?:]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}
