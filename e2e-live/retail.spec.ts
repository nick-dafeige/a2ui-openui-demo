import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// PAID: real DeepSeek through the real app. 7 typed messages (one is a what-if and may use a second model call, so up to 8 requests).
// Checks outcomes, not just that the API answered: state after a hypothetical, exactly what an adoption changed, trace proof of every call.
const last = (page: Page, id: string) => page.getByTestId(id).last();
const say = async (page: Page, text: string) => { await page.getByTestId('rt-question').fill(text); await page.getByTestId('rt-ask').click(); await expect(page.getByTestId('rt-loading')).toHaveCount(0, { timeout: 60_000 }); };

test('retail with the REAL model: explain, hypothetical, explicit adoption, drop-off - traced end to end', async ({ page, request }) => {
  const sent: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/retail/interpret')) sent.push(r.headers()['x-request-id']); });
  await page.goto('/');
  await page.getByTestId('mode-retail').click();
  await page.getByTestId('rt-sample').click();                                               // typed turn 1
  await expect(last(page, 'rt-orders')).toBeVisible({ timeout: 60_000 });
  await say(page, 'The first one, the left side has no sound');                                // 2
  await expect(page.getByTestId('rt-orders-value')).toContainText('Aurora Pro');
  await expect(page.getByTestId('rt-symptoms')).toHaveCount(0);
  await last(page, 'rt-deadline-date-input').fill('2026-11-16');
  await last(page, 'rt-deadline-date-confirm').click();
  await expect(last(page, 'rt-plans')).toBeVisible();
  await say(page, 'Exchange, ship it to my company');                                          // 3
  await expect(last(page, 'rt-address').getByTestId('rt-addr-summary')).toContainText('Company · Example Tower');

  // 4. a hypothetical: answered with the application's figures, address NOT changed
  const changedBefore = await page.getByText(/^Changed:/).count();     // earlier change turns report their own differences
  await say(page, "If I ship it home instead, how much sooner would it arrive? Don't change the address yet.");
  const answer = await page.getByTestId('rt-agent-text').filter({ hasText: /Nov 15/ }).last().innerText();
  expect(answer).toMatch(/Nov 15/);
  expect(answer).toMatch(/earlier|sooner|faster|quicker|1 day|one day|a day/i);
  expect(answer).not.toMatch(/ask away/i);
  await expect(page.getByTestId('rt-address-value').last()).toContainText('Company · Example Tower');   // state untouched
  await expect(page.getByText(/^Changed:/)).toHaveCount(changedBefore);   // the hypothetical added no change report: nothing changed

  // 5. explicit adoption of exactly that, everything else kept
  await say(page, 'Use the home address we just compared, keep everything else the same.');
  await expect(page.getByText(/^Changed:/)).toHaveCount(changedBefore + 1);
  const changed = page.getByText(/^Changed:/).last();
  await expect(changed).toContainText('Delivery address: Company · Example Tower → Home');
  await expect(changed).not.toContainText('Plan:');
  await expect(changed).toContainText('Unchanged:');

  // 6/7. an explanation and a drop-off wish, still with the real model
  await say(page, 'Why is exchange better for my trip than repair?');
  await expect(page.getByTestId('rt-agent-text').last()).not.toContainText(/ask away/i);
  await say(page, 'I would like to drop-off, give me the address');
  await expect(page.getByTestId('rt-agent-text').last()).toContainText(/near your company or near your home|service point/i);

  // trace: every typed message has a distinct request id, shown in the UI and recorded by the server as a real call
  const bubbles = page.getByTestId('rt-user-msg').filter({ hasNot: page.getByText('Quick action') });
  const vias = await bubbles.getByTestId('rt-via').allInnerTexts();
  expect(vias).toHaveLength(7);
  expect(vias.every((v) => v === 'Understood by model')).toBe(true);
  const lines = await bubbles.getByTestId('rt-trace-line').allInnerTexts();
  for (const l of lines) expect(l).toMatch(/^rq-[a-z0-9]+-[a-z0-9]{4} · model called \(deepseek-chat, HTTP 200\) · .*server \d+ ms.* · round trip \d+ ms$/);
  const ids = lines.map((l) => l.split(' · ')[0]);
  expect(new Set(ids).size).toBe(7);
  expect(sent).toEqual(ids);
  const serverSide = (await (await request.get('/api/retail/trace')).json()).traces as { requestId: string; modelCalled: boolean; mode: string; calls: { stage: string; httpStatus: number | null; budgetReservation: number | null }[]; turn: { mode: string; tools: string[]; ui: string[]; guardOk: boolean; answerReplaced: boolean; ignoredChanges: boolean } | null; outcome: string }[];
  const mine = ids.map((id) => serverSide.find((t) => t.requestId === id)!);
  for (const t of mine) { expect(t).toMatchObject({ modelCalled: true, mode: 'live' }); expect(t.calls.every((c) => c.httpStatus === 200)).toBe(true); expect(t.outcome).not.toBe('failed'); }
  expect(mine[3].turn!.mode).not.toBe('change');                                               // the hypothetical was not treated as a change
  expect(mine[4].turn!.mode).toBe('change');
  expect(JSON.stringify(serverSide)).not.toMatch(/sk-[A-Za-z0-9]{8,}|authorization|bearer|DEEPSEEK_API|My headphones are broken/i);
  mkdirSync('evidence/v0.4.0/trace', { recursive: true });
  writeFileSync('evidence/v0.4.0/trace/live-run-trace.json', JSON.stringify({ note: 'client trace lines and the server records for the same request ids; no key, prompt or message text', clientLines: lines, serverRecords: mine.map((t) => ({ ...t })) }, null, 2) + '\n');
  await page.screenshot({ path: 'evidence/v0.4.0/live-browser-final.png' });
});
