import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Minimal shape the map needs — decoupled from the full FacilityRow type so this
// component has no dependency on App.tsx internals.
export type MapPoint = {
  unique_id: string;
  name?: unknown;
  city?: unknown;
  state?: unknown;
  // Databricks SQL DOUBLE columns can arrive as strings over the wire, so accept
  // both and coerce defensively (see num()).
  latitude: number | string | null;
  longitude: number | string | null;
  distance_km?: number | string | null;
  evidence_score?: number | string | null;
  /** Optional precomputed pin colour (e.g. per-need relevance). Falls back to
   *  the evidence-tier colour when absent. */
  pinColor?: string | null;
  /** Optional plain-language reason for the pin colour, shown in the popup. */
  relevanceLabel?: string | null;
};

export type MapLegendItem = { color: string; label: string };

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

// Coerce a possibly-stringified numeric to a finite number, else null.
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Evidence-tier colour, mirroring the card tiers, so the map reinforces the
// evidence story rather than showing undifferentiated pins.
function colorFor(score: unknown): string {
  const s = num(score) ?? 0;
  if (s >= 9) return '#16a34a'; // strong  - green
  if (s >= 6) return '#2563eb'; // moderate - blue
  if (s >= 3) return '#d97706'; // limited - amber
  return '#6b7280'; // insufficient - gray
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Only allow a hex colour into inline styles (defence-in-depth: pin colours are
// our own values, but never interpolate untrusted text into HTML).
function safeColor(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Lightweight Leaflet map of facility results.
 * - CARTO light tiles (no API key; CSP-cleared on Databricks Apps).
 * - circleMarkers (no image assets → immune to bundler icon-path issues).
 * - When a city was searched, a distinct ring marks the median centroid of the
 *   results (an approximation of the SQL reference point used for ranking).
 * Renders nothing if no point has valid coordinates (parent shows fallback).
 */
export function FacilityMap({
  points,
  city,
  heightClass = 'h-64',
  colorMeaning = 'evidence tier',
  legend,
  onSelect,
}: {
  points: MapPoint[];
  city?: string;
  heightClass?: string;
  colorMeaning?: string;
  legend?: MapLegendItem[];
  /** Called with the facility's unique_id when its pin is clicked (e.g. to
   *  scroll the matching card into view). */
  onSelect?: (uniqueId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  // Hold onSelect in a ref so the map effect (keyed on point data) doesn't need
  // to re-run when the callback identity changes.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Normalise coordinates up front (DOUBLE columns may arrive as strings) and
  // drop rows without usable coordinates or stuck at the (0,0) null-island.
  const valid = points
    .map((p) => ({ ...p, lat: num(p.latitude), lon: num(p.longitude) }))
    .filter(
      (p): p is typeof p & { lat: number; lon: number } =>
        p.lat !== null && p.lon !== null && !(p.lat === 0 && p.lon === 0),
    );

  useEffect(() => {
    if (!containerRef.current || valid.length === 0) return;

    const map = L.map(containerRef.current, { scrollWheelZoom: false, attributionControl: true });
    mapRef.current = map;

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(map);

    const latlngs: L.LatLngExpression[] = [];
    for (const p of valid) {
      const name = str(p.name) || 'Unnamed facility';
      const place = [str(p.city), str(p.state)].filter(Boolean).join(', ');
      const d = num(p.distance_km);
      const dist = d !== null ? `~${d} km away` : '';
      const fill = safeColor(p.pinColor) || colorFor(p.evidence_score);
      const relLabel = str(p.relevanceLabel);
      // The "why this colour" line: a coloured dot in the pin's own colour plus a
      // plain-language reason, so the colour is never a mystery.
      const relLine = relLabel
        ? `<br/><span style="color:${fill};font-weight:600">●</span> <span style="color:#374151">${escapeHtml(relLabel)}</span>`
        : '';
      const marker = L.circleMarker([p.lat, p.lon], {
        radius: 7,
        color: '#ffffff',
        weight: 1.5,
        fillColor: fill,
        fillOpacity: 0.9,
      })
        .addTo(map)
        .bindPopup(
          `<strong>${escapeHtml(name)}</strong>${place ? `<br/>${escapeHtml(place)}` : ''}${relLine}${
            dist ? `<br/><span style="color:#6b7280">${escapeHtml(dist)}</span>` : ''
          }`,
        );
      // Clicking a pin scrolls the matching card into view in the results list.
      marker.on('click', () => onSelectRef.current?.(p.unique_id));
      latlngs.push([p.lat, p.lon]);
    }

    // City reference point (median centroid of the results), if a city was searched.
    if (city && city.trim() && valid.length > 0) {
      const refLat = median(valid.map((p) => p.lat));
      const refLon = median(valid.map((p) => p.lon));
      L.circleMarker([refLat, refLon], {
        radius: 10,
        color: '#111827',
        weight: 2,
        fillColor: '#111827',
        fillOpacity: 0,
      })
        .addTo(map)
        .bindPopup(`<strong>${escapeHtml(city.trim())}</strong><br/><span style="color:#6b7280">search reference point</span>`);
      latlngs.push([refLat, refLon]);
    }

    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });

    // Leaflet needs a size recompute once the container has laid out.
    setTimeout(() => map.invalidateSize(), 0);

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Re-init when the set of points or the city changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(valid.map((p) => [p.unique_id, p.lat, p.lon, p.evidence_score, p.pinColor])), city]);

  if (valid.length === 0) return null;

  const hasCityRef = Boolean(city && city.trim());

  return (
    <div className="space-y-1.5">
      <div ref={containerRef} className={`${heightClass} w-full rounded-lg border z-0`} />

      {/* Colour legend, so blue/green/amber/grey pins are never a mystery. */}
      {legend && legend.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {legend.map((item) => (
            <span key={item.label} className="inline-flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-full border border-white shadow-sm"
                style={{ backgroundColor: safeColor(item.color) ?? '#6b7280' }}
              />
              {item.label}
            </span>
          ))}
          {hasCityRef && (
            <span className="inline-flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-full border-2"
                style={{ borderColor: '#111827' }}
              />
              Search reference point
            </span>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Showing {valid.length} of {points.length} facilities with map coordinates · pin colour = {colorMeaning} ·
        distance is straight-line.
      </p>
    </div>
  );
}
