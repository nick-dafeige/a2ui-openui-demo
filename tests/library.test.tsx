import { renderToStaticMarkup } from 'react-dom/server';
import { Renderer } from '@openuidev/react-lang';
import { describe, expect, it } from 'vitest';
import { generateCalls } from '../src/data/generate.ts';
import expected from './expected.json' with { type: 'json' };
import { defaultLayout } from '../src/layout/defaults.ts';
import { EnvContext, library, programFor, unknownComponents } from '../src/report/library.tsx';
import { buildReport, defaultFilters, specFor } from '../src/report/model.ts';
import { COMPONENT_IDS } from '../src/layout/components.ts';

const render = (intent: Parameters<typeof specFor>[0], f = defaultFilters(), drill?: string) => {
  const spec = specFor(intent, [], drill);
  const data = buildReport(generateCalls(), spec, f);
  return renderToStaticMarkup(
    <EnvContext.Provider value={{ data, layout: defaultLayout(), onSelectCampaign: () => {}, onDrill: () => {}, onOpenCall: () => {} }}>
      <Renderer response={programFor(spec.components)} library={library} />
    </EnvContext.Provider>);
};

describe('OpenUI-rendered report shows engine figures', () => {
  it('overview cards and table', () => {
    const h = render('campaign_overview');
    expect(h).toContain('>720<');                  // total calls
    expect(h).toContain('48.3%');                  // 348/720
    expect(h).toContain('23.9%');                  // 83/348 conversion (denominator = answered)
    expect(h).toContain('Payment Reminder');
  });
  it('change view shows Cannot compare and pp values', () => {
    const h = render('change_analysis');
    expect(h).toContain('-50.0 pp');
    expect(h).toContain('Cannot compare');
    expect(h).toContain('2026-10-26 to 2026-11-01');
  });
  it('zero-denominator conversion shows a dash', () => {
    const h = render('campaign_overview', { ...defaultFilters(), campaignIds: ['c7'] });
    expect(h).toContain('data-testid="conversion_card-value">—<');
  });
  it('drill-down lists only the campaign\'s unanswered calls', () => {
    expect(render('unanswered_drilldown', defaultFilters(), 'c2')).toContain(`${expected.c2Unanswered.total} unanswered calls`);
  });
});

describe('program guard', () => {
  it('every component id maps to a library component', () => {
    expect(unknownComponents(programFor([...COMPONENT_IDS]))).toEqual([]);
  });
  it('flags components the renderer would silently drop', () => {
    expect(unknownComponents('root = Report([a])\na = Script("x")')).toEqual(['Script']);
  });
});

describe('every subset of components renders (free composition)', () => {
  it('all 255 non-empty subsets render without error and show exactly their components', () => {
    const calls = generateCalls();
    for (let mask = 1; mask < 1 << COMPONENT_IDS.length; mask++) {
      const comps = COMPONENT_IDS.filter((_, i) => mask & (1 << i));
      const spec = { ...specFor('campaign_overview'), components: [...comps], drill: { campaignId: 'c2', sort: 'desc' as const, page: 1 } };
      const data = buildReport(calls, spec, defaultFilters());
      const html = renderToStaticMarkup(
        <EnvContext.Provider value={{ data, layout: defaultLayout(), onSelectCampaign: () => {}, onDrill: () => {}, onOpenCall: () => {} }}>
          <Renderer response={programFor(comps)} library={library} /></EnvContext.Provider>);
      const shown = [...html.matchAll(/data-scene-id="([a-z_]+)"/g)].map((m) => m[1]).sort();
      expect(shown).toEqual([...comps].sort());
    }
  });
});
