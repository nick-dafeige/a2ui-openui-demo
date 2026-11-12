import { describe, expect, it } from 'vitest';
import { planQuestion, preparedPlan, deepseekComplete } from '../src/ai/planner.ts';

const say = (s: string) => async () => s;
describe('planner (mocked model)', () => {
  it('accepts a valid plan and labels it live', async () =>
    expect(await planQuestion('q', say('{"intent":"change_analysis"}'))).toMatchObject({ kind: 'plan', source: 'live' }));
  it('tolerates a fenced JSON block', async () =>
    expect((await planQuestion('q', say('```json\n{"intent":"campaign_overview"}\n```'))).kind).toBe('plan'));
  it('unknown metric lists available metrics and produces no plan', async () =>
    expect(await planQuestion('q', say('{"intent":"campaign_overview","metrics":["revenue"]}'))).toMatchObject({ kind: 'unknown_metric' }));
  it('drill-down without a single campaign asks for selection (FR-3)', async () =>
    expect(await planQuestion('q', say('{"intent":"unanswered_drilldown"}'))).toEqual({ kind: 'need_campaign' }));
  it('a composition containing the call list needs exactly one campaign', async () => {
    expect(await planQuestion('q', say('{"intent":"campaign_overview","components":["call_list"],"only":true}'))).toEqual({ kind: 'need_campaign' });
    expect(await planQuestion('q', say('{"intent":"campaign_overview","components":["call_list"],"campaignIds":["c2"],"only":true}'))).toMatchObject({ kind: 'plan' });
  });
  it('the prompt lists every component and explains only', async () => {
    let sys = ''; await planQuestion('q', async (s) => { sys = s; return '{"intent":"campaign_overview"}'; });
    for (const id of ['calls_card', 'change_ranking', 'call_list', 'daily_call_volume']) expect(sys).toContain(id);
    expect(sys).toContain('ONLY what they named');
  });
  it('regression: a change question with a redundant sortBy still plans as change_analysis', async () => {
    for (const out of ['{"intent":"change_analysis","sortBy":"answer_rate_change","order":"asc","limit":1}', '{"intent":"campaign_overview","metrics":["answer_rate_change"],"sortBy":"answer_rate_change","order":"asc","limit":1}', '{"intent":"change_analysis","sortBy":"answer_rate","limit":1}']) {
      const o = await planQuestion('biggest drop', say(out));
      expect(o).toMatchObject({ kind: 'plan', request: { intent: 'change_analysis' } });
      expect((o as any).request.sortBy).toBeUndefined();
    }
  });
  it('unrelated invalid sorts stay rejected', async () =>
    expect(await planQuestion('q', say('{"intent":"campaign_overview","sortBy":"revenue"}'))).toMatchObject({ kind: 'failed' }));
  it('model-supplied figures are rejected', async () =>
    expect(await planQuestion('q', say('{"intent":"campaign_overview","calls":5}'))).toMatchObject({ kind: 'failed' }));
  it('non-JSON and thrown errors become failures, never plans', async () => {
    expect(await planQuestion('q', say('sure!'))).toMatchObject({ kind: 'failed', reason: 'model_output_not_json' });
    expect(await planQuestion('q', async () => { throw new Error('boom'); })).toMatchObject({ kind: 'failed' });
  });
  it('prepared plans are labelled fallback', () => expect(preparedPlan('overview')).toMatchObject({ source: 'fallback' }));
});

describe('deepseek client (no network)', () => {
  it('refuses without a key and never calls fetch', async () => {
    const saved = process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_API_KEY;
    let called = false;
    await expect(deepseekComplete({ reserveStage: 't', fetchImpl: (async () => { called = true; return new Response(''); }) as typeof fetch })('s', 'u')).rejects.toThrow('not set');
    expect(called).toBe(false);
    if (saved) process.env.DEEPSEEK_API_KEY = saved;
  });
});

describe('planner context', () => {
  it('tells the model which campaign is selected, or none', async () => {
    const seen: string[] = [];
    await planQuestion('expand this campaign', async (_s, u) => { seen.push(u); return '{"intent":"unanswered_drilldown"}'; });
    await planQuestion('expand this campaign', async (_s, u) => { seen.push(u); return '{"intent":"unanswered_drilldown","campaignIds":["c2"]}'; }, { selectedCampaignId: 'c2' });
    expect(seen[0]).toContain('Selected campaign: none');
    expect(seen[1]).toContain('Selected campaign: c2');
  });
});
