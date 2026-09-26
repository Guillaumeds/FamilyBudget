import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateHousehold } from '../src/db/households';
import { listRunLog } from '../src/db/repo';
import { setSettings } from '../src/db/settings';
import { GLOBAL_HID, tenant } from '../src/db/tenant';
import type { Env } from '../src/env';
import { runScheduled } from '../src/scheduled';
import { type HouseholdTaskMessage, runHouseholdTasks } from '../src/tasks';
import { HH1, HH2, resetDb, seedHousehold } from './helpers';

// Producer-level tests: the consumer is mocked (its behaviour is covered in tasks.test.ts).
vi.mock('../src/tasks', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/tasks')>()), runHouseholdTasks: vi.fn() }));

const db = env.DB;
const inline = vi.mocked(runHouseholdTasks);
const sendBatch = vi.fn(async (_messages: Iterable<MessageSendRequest<unknown>>) => undefined);
const queueEnv: Env = { ...env, HOUSEHOLD_TASKS: { sendBatch } as unknown as Queue<unknown> };

/** One cron tick at the given UTC instant; returns the messages enqueued (householdId → tasks). */
async function tick(iso: string, e: Env = queueEnv): Promise<Record<number, string[]>> {
	sendBatch.mockClear();
	inline.mockClear();
	await runScheduled(e, createExecutionContext(), new Date(iso));
	const sent: Record<number, string[]> = {};
	for (const [requests] of sendBatch.mock.calls) {
		for (const { body, contentType } of requests as MessageSendRequest<HouseholdTaskMessage>[]) {
			expect(contentType).toBe('json');
			expect(body).toMatchObject({ v: 1, scheduledFor: new Date(iso).toISOString() });
			sent[body.householdId] = body.tasks;
		}
	}
	return sent;
}

async function logLines(): Promise<string[]> {
	return (await listRunLog(db, 100)).map((row) => `${row.level} ${row.action}: ${row.message}`);
}

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	inline.mockResolvedValue();
	await setSettings(HH1, { timezone: 'Europe/Dublin', brief_hour_local: '9', budget_month_start_day: '25', capture_hour_local: '22' });
	await setSettings(HH2, { timezone: 'America/New_York', brief_hour_local: '9', budget_month_start_day: '1', capture_hour_local: '22' });
});

describe('daily brief gating (per household timezone)', () => {
	it('08:00 UTC in July briefs Dublin (09:00 IST) but not New York (04:00 EDT)', async () => {
		expect(await tick('2026-07-15T07:00:00Z')).toEqual({ 1: ['sync'], 2: ['sync'] });
		expect(await tick('2026-07-15T08:00:00Z')).toEqual({ 1: ['sync', 'brief'], 2: ['sync'] });
		expect(await tick('2026-07-15T13:00:00Z')).toEqual({ 1: ['sync', 'brief'], 2: ['sync', 'brief'] }); // 09:00 EDT
		expect(sendBatch).toHaveBeenCalledOnce();
		expect(await logLines()).toContain('INFO scheduled: Enqueued 2 household task message(s): hh1[sync,brief], hh2[sync,brief].');
	});

	it('follows DST: Dublin 09:00 is 09:00 UTC in winter', async () => {
		expect((await tick('2026-01-15T08:00:00Z'))[1]).toEqual(['sync']);
		expect((await tick('2026-01-15T09:00:00Z'))[1]).toEqual(['sync', 'brief']);
	});

	it('catches up later the same day (>=, not ===)', async () => {
		expect((await tick('2026-01-15T11:00:00Z'))[1]).toEqual(['sync', 'brief']);
	});

	it('the guard suppresses the brief for the rest of the local day, not the next day', async () => {
		await setSettings(HH1, { brief_last_sent_date: '2026-01-15' });
		expect((await tick('2026-01-15T10:00:00Z'))[1]).toEqual(['sync']);
		expect((await tick('2026-01-15T23:00:00Z'))[1]).toEqual(['sync']);
		expect((await tick('2026-01-16T09:00:00Z'))[1]).toEqual(['sync', 'brief']);
	});

	it('the guard is per household and compared with ITS local date', async () => {
		// 03:00 UTC 16 Jan = 03:00 Dublin (16th) = 22:00 New York (15th).
		await setSettings(HH1, { brief_hour_local: '0', brief_last_sent_date: '2026-01-15' });
		await setSettings(HH2, { brief_last_sent_date: '2026-01-15' });
		expect(await tick('2026-01-16T03:00:00Z')).toEqual({ 1: ['sync', 'brief'], 2: ['sync'] });
	});

	it('uses the defaults when an hour setting or the timezone is invalid', async () => {
		await setSettings(HH1, { brief_hour_local: 'nine' }); // → default 9
		expect((await tick('2026-01-15T08:00:00Z'))[1]).toEqual(['sync']);
		expect((await tick('2026-01-15T09:00:00Z'))[1]).toEqual(['sync', 'brief']);

		await setSettings(HH2, { timezone: 'Mars/Olympus' }); // → UTC
		expect((await tick('2026-01-15T09:00:00Z'))[2]).toEqual(['sync', 'brief']);
		expect((await listRunLog(db, 100, 2)).map((row) => row.message)).toContain('Invalid timezone "Mars/Olympus" — scheduling in UTC.');
	});

	it('global rows are merged under household rows', async () => {
		await db.prepare("DELETE FROM settings WHERE household_id = 2 AND key = 'brief_hour_local'").run();
		await setSettings(tenant(db, GLOBAL_HID), { brief_hour_local: '3' });
		// 07:00 UTC = 03:00 EDT: at the global 3 for hh2; hh1 keeps its own 9 (08:00 IST).
		expect(await tick('2026-07-15T07:00:00Z')).toEqual({ 1: ['sync'], 2: ['sync', 'brief'] });
	});
});

describe('wallet sync', () => {
	it('full-sync on Sunday 03:00 local (per household), incremental otherwise', async () => {
		expect((await tick('2026-09-27T02:00:00Z'))[1]).toEqual(['full-sync']); // Sun 03:00 IST
		expect((await tick('2026-01-18T03:00:00Z'))[1]).toEqual(['full-sync']); // Sun 03:00 GMT
		expect((await tick('2026-09-27T03:00:00Z'))[1]).toEqual(['sync']); // Sun 04:00 IST
		expect((await tick('2026-09-26T02:00:00Z'))[1]).toEqual(['sync']); // Sat 03:00 IST
		expect(await tick('2026-09-27T07:00:00Z')).toEqual({ 1: ['sync'], 2: ['full-sync'] }); // Sun 03:00 EDT
	});
});

describe('cash-flow capture gating', () => {
	// hh1 period 25 Aug – 24 Sep 2026; 21:00 UTC on 24 Sep = 22:00 in Dublin.
	it('only on the period end day at/after the capture hour, until its guard is set', async () => {
		expect((await tick('2026-09-23T21:00:00Z'))[1]).toEqual(['sync', 'brief']); // day before the end
		expect((await tick('2026-09-24T20:00:00Z'))[1]).toEqual(['sync', 'brief']);
		expect((await tick('2026-09-24T21:00:00Z'))[1]).toEqual(['sync', 'brief', 'capture']);

		await setSettings(HH1, { capture_last_period_end: '2026-09-24', brief_last_sent_date: '2026-09-24' });
		expect((await tick('2026-09-24T22:00:00Z'))[1]).toEqual(['sync']);
	});

	it('each household uses its own start day', async () => {
		// hh2 (start day 1) ends its period on 30 Sep; 22:00 EDT = 02:00 UTC on 1 Oct.
		expect((await tick('2026-10-01T02:00:00Z'))[2]).toEqual(['sync', 'brief', 'capture']);
		expect((await tick('2026-10-01T02:00:00Z'))[1]).toEqual(['sync']); // 03:00 IST on 1 Oct, before brief hour
	});
});

describe('households', () => {
	it('suspended households get no message; new households are included', async () => {
		await updateHousehold(db, 2, { status: 'suspended' });
		await seedHousehold(3, 'newbies');
		expect(Object.keys(await tick('2026-01-15T09:00:00Z'))).toEqual(['1', '3']);
	});

	it('sends at most 100 messages per sendBatch call', async () => {
		for (let id = 3; id <= 102; id++) await seedHousehold(id, `hh-${id}`);
		const sent = await tick('2026-01-15T05:00:00Z');
		expect(Object.keys(sent)).toHaveLength(102);
		expect(sendBatch.mock.calls.map(([requests]) => [...requests].length)).toEqual([100, 2]);
	});
});

describe('inline fallback (no HOUSEHOLD_TASKS binding)', () => {
	it('runs each household sequentially with the tick time and logs once', async () => {
		const now = new Date('2026-07-15T08:00:00Z');
		await tick(now.toISOString(), env);

		expect(sendBatch).not.toHaveBeenCalled();
		expect(inline.mock.calls.map(([e, hid, tasks, when]) => [e === env, hid, tasks, when])).toEqual([
			[true, 1, ['sync', 'brief'], now],
			[true, 2, ['sync'], now],
		]);
		expect(await logLines()).toContain('INFO scheduled: Queue binding absent — ran 2 household(s) inline: hh1[sync,brief], hh2[sync].');
	});

	it('one household throwing does not stop the next', async () => {
		inline.mockRejectedValueOnce(new Error('D1 down'));
		await tick('2026-07-15T08:00:00Z', env);
		expect(inline).toHaveBeenCalledTimes(2);
		expect((await listRunLog(db, 100, 1)).map((row) => row.message)).toContain('Household tasks failed before running: D1 down');
	});
});

describe('housekeeping', () => {
	const OLD_TS = '2000-01-01T00:00:00.000Z';
	const oldRowCount = async () => (await db.prepare('SELECT COUNT(*) AS n FROM run_log WHERE ts = ?').bind(OLD_TS).first<number>('n')) ?? 0;

	it('prunes run_log only at 04:00 UTC', async () => {
		await db.prepare("INSERT INTO run_log (ts, level, action, message) VALUES (?, 'INFO', 'old', 'ancient')").bind(OLD_TS).run();

		await tick('2026-07-15T03:00:00Z'); // 04:00 IST — no longer local
		await tick('2026-07-15T05:00:00Z');
		expect(await oldRowCount()).toBe(1);

		await tick('2026-07-15T04:00:00Z');
		expect(await oldRowCount()).toBe(0);
		expect(await logLines()).toContain('INFO scheduled: Pruned 1 run_log row(s) older than 90 days.');
	});

	it('still prunes when enqueueing fails', async () => {
		await db.prepare("INSERT INTO run_log (ts, level, action, message) VALUES (?, 'INFO', 'old', 'ancient')").bind(OLD_TS).run();
		sendBatch.mockRejectedValueOnce(new Error('queue unavailable'));
		await runScheduled(queueEnv, createExecutionContext(), new Date('2026-07-15T04:00:00Z'));
		expect(await oldRowCount()).toBe(0);
		expect(await logLines()).toContain('ERROR scheduled: Enqueueing household tasks failed, retrying next hour: queue unavailable');
	});
});
