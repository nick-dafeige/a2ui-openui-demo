import type { Address, ServicePoint } from './data.ts';

export interface MapPin { id: string; x: number; y: number; label: string; kind: 'address' | 'service' | 'picked'; selected?: boolean }

/**
 * Schematic map (no tiles, no network): zone rings plus location markers. It shows WHERE things are; it never draws a
 * delivery track or live position. Clicking empty space reports a picked point (coordinates 0-100).
 */
export function MapView({ pins, onPin, onPick, testId, caption }: { pins: MapPin[]; onPin?: (id: string) => void; onPick?: (x: number, y: number) => void; testId: string; caption: string }) {
  const color = (p: MapPin) => (p.kind === 'service' ? '#0f7b3f' : p.kind === 'picked' ? '#b45309' : '#4c0eb6');
  return (
    <figure className="rt-map" data-testid={testId}>
      <svg viewBox="0 0 100 100" role="img" aria-label={caption}
        onClick={(e) => {
          if (!onPick) return;
          const r = e.currentTarget.getBoundingClientRect();
          onPick(Math.round(((e.clientX - r.left) / r.width) * 100), Math.round(((e.clientY - r.top) / r.height) * 100));
        }}>
        <rect width="100" height="100" fill="#f8f9fa" />
        <circle cx="50" cy="50" r="35" fill="#eef0f2" stroke="#d9dce0" strokeWidth=".4" />
        <circle cx="50" cy="50" r="20" fill="#e3def9" stroke="#c9c0f2" strokeWidth=".4" />
        <text x="50" y="30.5" textAnchor="middle" fontSize="2.6" fill="#5f6368">Urban</text>
        <text x="50" y="15.5" textAnchor="middle" fontSize="2.6" fill="#5f6368">Suburban</text>
        <text x="50" y="97" textAnchor="middle" fontSize="2.6" fill="#5f6368">Remote (outside the rings)</text>
        {pins.map((p) => (
          <g key={p.id} transform={`translate(${p.x} ${p.y})`} data-testid={`${testId}-pin-${p.id}`} data-selected={p.selected ? 'true' : 'false'}
            onClick={(e) => { if (onPin) { e.stopPropagation(); onPin(p.id); } }} style={{ cursor: onPin ? 'pointer' : 'default' }}>
            <circle r={p.selected ? 3.2 : 2.2} fill={color(p)} stroke="#fff" strokeWidth=".7" />
            {p.kind === 'service' && <rect x="-1" y="-1" width="2" height="2" fill="#fff" />}
            <text y="-4.2" textAnchor="middle" fontSize="2.8" fill="#1f2124" fontWeight={p.selected ? 700 : 400}>{p.label}</text>
          </g>
        ))}
      </svg>
      <figcaption className="muted">{caption}</figcaption>
    </figure>
  );
}

export const addressPin = (a: Address, selected: boolean): MapPin => ({ id: a.id, x: a.x, y: a.y, label: a.label.replace(/^.*· /, ''), kind: 'address', selected });
export const servicePin = (s: ServicePoint, selected: boolean): MapPin => ({ id: s.id, x: s.x, y: s.y, label: s.name.replace(' (demo)', ''), kind: 'service', selected });

/**
 * Visual-only real map (unofficial keyless Google embed). The demo's 0-100 map units are placed around central Wuhan with a fixed
 * scale (1 unit = 0.5 km, same as the distance rule), so the picture agrees with the numbers. Addresses are synthetic placeholders.
 * An iframe cannot report clicks: choosing a point is still done on the schematic map or in the list.
 */
export const geoOf = (p: { x: number; y: number }): { lat: number; lng: number } => ({ lat: Math.round((30.5928 - (p.y - 50) * 0.0045) * 1e5) / 1e5, lng: Math.round((114.3055 + (p.x - 50) * 0.0052) * 1e5) / 1e5 });
export const embedUrl = (p: { x: number; y: number }): string => { const g = geoOf(p); return `https://maps.google.com/maps?q=${g.lat},${g.lng}&z=14&output=embed`; };
export function RealMap({ at, label }: { at: { x: number; y: number }; label: string }) {
  return (
    <figure className="rt-map rt-gmap" data-testid="ou-gmap">
      <iframe key={embedUrl(at)} title={`Google Maps: ${label}`} src={embedUrl(at)} loading="lazy" referrerPolicy="no-referrer-when-downgrade" style={{ width: '100%', maxWidth: 420, height: 220, border: '1px solid var(--line)', borderRadius: 8 }} />
      <figcaption className="muted">Google Maps (view only, unofficial embed): {label}. Demo points are placeholders around central Wuhan.</figcaption>
    </figure>
  );
}
