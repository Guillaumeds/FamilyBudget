// Budget view: period navigation, overall summary and the editable budget table.
import { api, callout, diffDays, errorBox, flash, h, meter, money, pageHeader, percent, prefs, signedMoney, spinner, toast } from './lib.js';

const MIN_OFFSET = -240;
const MAX_OFFSET = 24;
const FORECAST_TYPES = [
	['day_to_day', 'Day-to-day'],
	['recurring', 'Recurring'],
];

export async function render(root, ctx) {
	let offset = clampOffset(Number(ctx.params.get('offset')) || 0);
	let summary = null;
	let loadToken = 0;
	/** rowKey → { tr, update(line) } for in-place refreshes after an edit. */
	let rows = new Map();

	const periodTitle = h('span', { class: 'period-title' });
	const periodHint = h('span', { class: 'period-hint' });
	const prev = h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Previous period', title: 'Previous period', onclick: () => go(offset - 1) }, '‹');
	const next = h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Next period', title: 'Next period', onclick: () => go(offset + 1) }, '›');
	const today = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => go(0) }, 'Current');
	const periodNav = h('div', { class: 'period-nav', role: 'group', 'aria-label': 'Budget period' }, prev, h('div', { class: 'period-label', 'aria-live': 'polite' }, periodTitle, periodHint), next, today);

	const hideEmpty = h('input', { type: 'checkbox', id: 'hide-empty', class: 'switch', checked: prefs.get('budget.hideEmpty', false) });
	const tableTools = h('div', { class: 'table-tools' }, h('label', { for: 'hide-empty', class: 'inline-flag' }, hideEmpty, 'Hide categories without budget or spend'));
	const body = h('div', { class: 'budget-body' }, spinner());

	root.append(pageHeader('Budget', 'Targets are yours to edit — spending comes from BudgetBakers.', periodNav), body);

	hideEmpty.addEventListener('change', () => {
		prefs.set('budget.hideEmpty', hideEmpty.checked);
		body.querySelector('.budget-table')?.classList.toggle('hide-empty', hideEmpty.checked);
	});

	function clampOffset(value) {
		return Math.min(MAX_OFFSET, Math.max(MIN_OFFSET, Math.trunc(value)));
	}

	function go(value) {
		offset = clampOffset(value);
		history.replaceState(null, '', offset === 0 ? '#/budget' : `#/budget?offset=${offset}`);
		load();
	}

	async function fetchSummary() {
		const data = await api(`/api/summary?offset=${offset}`);
		if (data.offset === 0) ctx.setCurrentPeriod(data);
		return data;
	}

	async function load() {
		const token = ++loadToken;
		prev.disabled = offset <= MIN_OFFSET;
		next.disabled = offset >= MAX_OFFSET;
		today.hidden = offset === 0;
		periodHint.textContent = relativeLabel(offset);
		body.classList.add('is-loading');
		if (!summary) body.replaceChildren(spinner());
		try {
			const data = await fetchSummary();
			if (token !== loadToken) return;
			summary = data;
			renderAll();
		} catch (error) {
			if (token !== loadToken) return;
			summary = null;
			body.replaceChildren(errorBox(error, load));
		} finally {
			if (token === loadToken) body.classList.remove('is-loading');
		}
	}

	/** After an edit: recompute and patch the rows in place so focus and scroll position survive. */
	async function refresh() {
		const token = ++loadToken;
		try {
			const data = await fetchSummary();
			if (token !== loadToken) return;
			const sameShape = data.lines.length === summary.lines.length && data.lines.every((line) => rows.has(rowKey(line)));
			summary = data;
			if (!sameShape) return renderAll();
			body.querySelector('.summary').replaceWith(renderSummary());
			for (const line of data.lines) rows.get(rowKey(line))?.update(line);
		} catch (error) {
			if (token === loadToken) toast(`Couldn’t refresh the totals: ${error.message}`, 'error');
		}
	}

	function renderAll() {
		periodTitle.textContent = summary.period.label;
		const lines = summary.lines.filter((line) => line.rowType !== 'OVERALL');
		const parts = [];
		if (summary.missingFxCount > 0) {
			parts.push(
				callout(
					'warn',
					h('strong', {}, `${summary.missingFxCount} transaction(s) in this period have no exchange rate yet`),
					' and count as 0 in the totals. ',
					h('a', { href: '#/settings/fx' }, 'Run an FX backfill →'),
				),
			);
		}
		parts.push(renderSummary());
		if (lines.length === 0) {
			parts.push(
				callout(
					'info',
					h('strong', {}, 'No categories yet. '),
					'Categories appear here after the first sync from BudgetBakers. ',
					h('a', { href: '#/settings/admin' }, 'Sync now →'),
				),
			);
		} else {
			parts.push(tableTools, renderTable(lines));
		}
		body.replaceChildren(...parts);
	}

	function elapsedFraction() {
		const { startText, endText, periodDays } = summary.period;
		const todayText = summary.todayLocal;
		if (todayText < startText) return { fraction: 0, text: 'Not started yet' };
		if (todayText > endText) return { fraction: 1, text: `${periodDays} days · finished` };
		const day = diffDays(startText, todayText) + 1;
		return { fraction: day / periodDays, text: `Day ${day} of ${periodDays}` };
	}

	function renderSummary() {
		const overall = summary.lines.find((line) => line.rowType === 'OVERALL');
		const cur = summary.currency;
		const elapsed = elapsedFraction();
		const over = overall.forecast > overall.budget && overall.budget > 0;
		const stat = (label, value, extra, cls = '') => h('div', { class: `stat ${cls}` }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), extra && h('div', { class: 'stat-extra' }, extra));
		return h(
			'section',
			{ class: 'summary card', 'aria-label': 'Overall budget' },
			h(
				'div',
				{ class: 'stats' },
				stat('Spent', money(overall.spent, cur), `${percent(overall.usedPct)} of budget`),
				stat('Budget', money(overall.budget, cur), elapsed.text),
				stat('Remaining', money(overall.remaining, cur), overall.remaining < 0 ? 'over budget' : null, overall.remaining < 0 ? 'is-bad' : ''),
				stat(
					'Forecast',
					money(overall.forecast, cur),
					overall.budget > 0 ? `${signedMoney(overall.forecastVsBudget, cur)} vs budget` : null,
					overall.budget > 0 ? (over ? 'is-bad' : 'is-good') : '',
				),
			),
			meter(overall.usedPct, { marker: elapsed.fraction, label: `${percent(overall.usedPct)} of the budget used, ${percent(elapsed.fraction)} of the period elapsed` }),
			h('div', { class: 'meter-legend small muted' }, h('span', {}, `${percent(overall.usedPct)} used`), h('span', {}, 'The tick marks how far through the period you are')),
		);
	}

	function renderTable(lines) {
		rows = new Map();
		const tbody = h('tbody');
		for (const line of lines) {
			const row = line.rowType === 'TYPE' ? groupRow(line) : categoryRow(line);
			rows.set(rowKey(line), row);
			tbody.append(row.tr);
		}
		const th = (label, cls = '', title) => h('th', { scope: 'col', class: cls, title }, label);
		return h(
			'div',
			{ class: 'table-scroll' },
			h(
				'table',
				{ class: `table budget-table${hideEmpty.checked ? ' hide-empty' : ''}` },
				h('caption', { class: 'visually-hidden' }, `Budget lines for ${summary.period.label}`),
				h(
					'thead',
					{},
					h(
						'tr',
						{},
						th('Category', 'sticky-col'),
						th('Budget', 'num'),
						th('Spent', 'num'),
						th('Remaining', 'num'),
						th('Used', 'col-used'),
						th('Forecast', 'num', 'Day-to-day: spend so far extrapolated to the whole period. Recurring: the budget.'),
						th('Avg (3 prev.)', 'num', 'Average spend of the previous three periods'),
						th('Forecast type'),
						th('Report', 'center', 'Show this line in the daily WhatsApp brief'),
						th('Expense', 'center', 'Count this line in the overall budget'),
					),
				),
				tbody,
			),
		);
	}

	// ---- rows -----------------------------------------------------------------------------

	function numberCells() {
		return { spent: h('td', { class: 'num' }), remaining: h('td', { class: 'num' }), used: h('td', { class: 'col-used' }), forecast: h('td', { class: 'num' }), baseline: h('td', { class: 'num muted' }) };
	}

	function updateNumbers(cells, line) {
		const cur = summary.currency;
		cells.spent.textContent = money(line.spent, cur);
		cells.remaining.textContent = money(line.remaining, cur);
		cells.remaining.classList.toggle('neg', line.remaining < 0);
		cells.used.replaceChildren(
			line.budget > 0
				? h('div', { class: 'used' }, meter(line.usedPct), h('span', { class: `used-pct${line.usedPct > 1 ? ' neg' : ''}` }, percent(line.usedPct)))
				: h('span', { class: 'muted' }, line.spent > 0 ? 'no budget' : '—'),
		);
		cells.forecast.textContent = money(line.forecast, cur);
		cells.forecast.className = `num ${line.forecast > line.budget ? 'neg' : line.forecast > 0 || line.budget > 0 ? 'pos' : 'muted'}`;
		cells.forecast.title = `${signedMoney(line.forecastVsBudget, cur)} vs budget`;
		cells.baseline.textContent = money(line.baselineAvg, cur);
		cells.baseline.title = `Previous periods (newest first): ${line.baselines.map((value) => money(value, cur)).join(' · ')}`;
	}

	function flagInput(line, entityType, key, label) {
		const input = h('input', { type: 'checkbox', checked: line[key], 'aria-label': `${label}: ${line.path}` });
		input.addEventListener('change', () => save(entityType, line.id, { [key]: input.checked }, input, () => (input.checked = !input.checked)));
		return input;
	}

	/**
	 * Inline budget editor for a category or group target. Empty = no target (null), 0 is a real zero.
	 * `sync()` re-reads the stored target after a refresh unless the input has focus.
	 */
	function budgetInput(entityType, line) {
		const key = `${entityType}:${line.id}`;
		const stored = () => summary.targets[key]?.budget;
		const input = h('input', {
			type: 'number',
			class: 'budget-input',
			min: '0',
			step: '0.01',
			inputmode: 'decimal',
			placeholder: '—',
			value: stored() ?? '',
			'aria-label': `Budget for ${line.path}`,
		});
		let saved = input.value;
		const commit = () => {
			const text = input.value.trim();
			if (text === saved) return;
			// badInput: the browser couldn't parse the text (value then reads as '' — must not clear the target).
			if (input.validity?.badInput || (text !== '' && !(Number.isFinite(Number(text)) && Number(text) >= 0))) {
				flash(input, 'error');
				toast('Budget must be a number ≥ 0 (leave empty for no target).', 'error');
				input.value = saved;
				return;
			}
			const value = text === '' ? null : Math.round(Number(text) * 100) / 100;
			const before = saved;
			saved = value === null ? '' : String(value);
			input.value = saved;
			save(entityType, line.id, { budget: value }, input, () => {
				saved = before;
				input.value = before;
			});
		};
		input.addEventListener('change', commit);
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') input.blur();
			if (event.key === 'Escape') {
				input.value = saved;
				input.blur();
			}
		});
		const sync = () => {
			if (document.activeElement === input) return;
			saved = stored() == null ? '' : String(stored());
			input.value = saved;
		};
		return { input, sync, hasTarget: () => stored() != null };
	}

	function forecastSelect(entityType, line) {
		const select = h('select', { 'aria-label': `Forecast type for ${line.path}` }, FORECAST_TYPES.map(([value, label]) => h('option', { value, selected: value === line.forecastType }, label)));
		let saved = line.forecastType;
		select.addEventListener('change', () => {
			const before = saved;
			saved = select.value;
			save(entityType, line.id, { forecastType: select.value }, select, () => {
				saved = before;
				select.value = before;
			});
		});
		return select;
	}

	function categoryRow(line) {
		const budget = budgetInput('category', line);
		const cells = numberCells();
		const name = h('th', { scope: 'row', class: 'sticky-col name', style: { '--depth': String(Math.max(0, line.depth - 1)) }, title: line.path }, line.name);
		const report = flagInput(line, 'category', 'includeInReport', 'Include in brief');
		const expense = flagInput(line, 'category', 'includeInExpense', 'Count in overall');
		const tr = h(
			'tr',
			{ class: `row-category depth-${Math.min(line.depth, 3)}` },
			name,
			h('td', { class: 'num' }, budget.input),
			cells.spent,
			cells.remaining,
			cells.used,
			cells.forecast,
			cells.baseline,
			h('td', {}, forecastSelect('category', line)),
			h('td', { class: 'center' }, report),
			h('td', { class: 'center' }, expense),
		);
		const update = (next) => {
			updateNumbers(cells, next);
			tr.classList.toggle('is-empty', !(next.budget > 0) && !(next.spent > 0) && !budget.hasTarget());
			tr.classList.toggle('is-excluded', !next.includeInExpense);
			budget.sync();
			report.checked = next.includeInReport;
			expense.checked = next.includeInExpense;
		};
		update(line);
		return { tr, update };
	}

	/** Sum of the budgets of the group's categories counted in expenses — the group budget when it has none of its own. */
	function categorySum(groupId) {
		const total = summary.lines.filter((l) => l.rowType === 'CATEGORY' && l.groupId === groupId && l.includeInExpense).reduce((acc, l) => acc + l.budget, 0);
		return Math.round(total * 100) / 100;
	}

	function groupRow(line) {
		const cells = numberCells();
		// The ungrouped bucket (id '') has no target to edit: its budget stays the sum.
		const editable = line.id !== '';
		const budget = editable ? budgetInput('group', line) : null;
		if (budget) budget.input.title = 'Empty = sum of this group’s category budgets. Type an amount to set the group budget directly.';
		const budgetCell = h('td', { class: 'num' }, budget?.input);
		if (!budget) budgetCell.title = 'Sum of the category budgets counted in this group';
		const report = editable ? flagInput(line, 'group', 'includeInReport', 'Include group in brief') : null;
		const expense = editable ? flagInput(line, 'group', 'includeInExpense', 'Count group in overall') : null;
		const tr = h(
			'tr',
			{ class: 'row-group' },
			h('th', { scope: 'row', class: 'sticky-col name' }, line.name),
			budgetCell,
			cells.spent,
			cells.remaining,
			cells.used,
			cells.forecast,
			cells.baseline,
			editable ? h('td', { title: 'The forecast is the sum of the categories’ forecasts (recurring ones always count in full). Choosing “recurring” on a group with its own budget forecasts that budget instead.' }, forecastSelect('group', line)) : h('td', { class: 'muted small' }, 'Group total'),
			h('td', { class: 'center' }, report ?? '—'),
			h('td', { class: 'center' }, expense ?? '—'),
		);
		const update = (next) => {
			if (budget) {
				budget.input.placeholder = `Σ ${categorySum(next.id).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
				budget.sync();
			} else {
				budgetCell.textContent = money(next.budget, summary.currency);
			}
			updateNumbers(cells, next);
			tr.classList.toggle('is-excluded', !next.includeInExpense);
			if (report) report.checked = next.includeInReport;
			if (expense) expense.checked = next.includeInExpense;
		};
		update(line);
		return { tr, update };
	}

	async function save(entityType, id, patch, el, revert) {
		// Not disabled while saving: that would drop keyboard focus. aria-busy + the flash give feedback.
		el.setAttribute('aria-busy', 'true');
		try {
			await api(`/api/targets/${entityType}/${encodeURIComponent(id)}`, { method: 'PUT', body: patch });
			el.removeAttribute('aria-busy');
			flash(el, 'saved');
			await refresh();
		} catch (error) {
			el.removeAttribute('aria-busy');
			revert();
			flash(el, 'error');
			toast(`Not saved: ${error.message}`, 'error');
		}
	}

	await load();
}

function rowKey(line) {
	return `${line.rowType}:${line.id}`;
}

function relativeLabel(offset) {
	if (offset === 0) return 'Current period';
	if (offset === -1) return 'Previous period';
	if (offset === 1) return 'Next period';
	return offset < 0 ? `${-offset} periods ago` : `${offset} periods ahead`;
}
