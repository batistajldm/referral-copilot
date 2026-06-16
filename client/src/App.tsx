import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  useAnalyticsQuery,
} from '@databricks/appkit-ui/react';
import type { QueryRegistry } from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import {
  MapPin,
  Stethoscope,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  ExternalLink,
  Search,
  Star,
  Trash2,
  Sparkles,
  Loader2,
  Phone,
  Globe,
  ListFilter,
  ArrowUpDown,
  ThumbsUp,
  ThumbsDown,
  Users,
  MessageSquare,
} from 'lucide-react';
import { useShortlist, type ShortlistApi, type ShortlistItem, type ShortlistStatus } from './shortlist';
import { useReviews, type ReviewsApi, type ReviewDetail } from './reviews';
import { FacilityMap } from './FacilityMap';

// ---------- helpers ----------

/** Safely parse a JSON-array column (e.g. specialties, capability, source_urls).
 *  The data is dirty: some rows arrive as a JSON string, others as an
 *  already-deserialized array/object, others as a plain scalar. Handle all. */
function parseJsonArray(value: unknown): string[] {
  if (value == null) return [];

  // Already an array (AppKit auto-deserialized the JSON column).
  if (Array.isArray(value)) {
    return value
      .map((x) => asText(x).trim())
      .filter((x): x is string => x !== '');
  }

  // Objects that aren't arrays carry no useful list content.
  if (typeof value === 'object') return [];

  const str = asText(value).trim();
  if (!str) return [];

  try {
    const parsed: unknown = JSON.parse(str);
    if (Array.isArray(parsed)) {
      return parsed
        .map((x) => asText(x).trim())
        .filter((x): x is string => x !== '');
    }
  } catch {
    return [str];
  }
  return [str];
}

/** Deduplicate while preserving order. */
function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

/** "internalMedicine" -> "Internal Medicine" */
function humanize(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Build a safe, clickable href from a website field that is often a bare
 *  domain (e.g. "ckshospitals.com") rather than a full URL. Returns null for
 *  anything that isn't an http(s) URL or a plausible domain — so we never emit
 *  a "javascript:" or otherwise unsafe scheme. */
function toWebsiteHref(value: unknown): string | null {
  const v = clean(value);
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  // Reject other explicit schemes (mailto:, javascript:, tel:, etc.).
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  // Plausible bare domain: has a dot, no spaces, valid-ish hostname start.
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(v)) return `https://${v}`;
  return null;
}

/** Coerce any value to a safe display string (data is dirty — some fields
 *  arrive as parsed objects/arrays instead of plain strings). */
function asText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Treat empty / literal "null" strings as missing. */
function clean(value: unknown): string | null {
  const v = asText(value).trim();
  return v === '' || v.toLowerCase() === 'null' ? null : v;
}

// ---------- search-term matching (why did this facility match?) ----------
// The facility_search query matches the need against specialties/capability/
// description. Surface that match: reorder hits to the front (so the cap
// doesn't bury them) and highlight the matched text.
//
// Matching is TOKEN-based, not whole-string. The need is split into words and
// each word is matched/highlighted independently. This is what makes the
// highlight consistent: a search like "cardiology surgery" highlights
// "cardiology" in the specialties chip AND "surgery" in cited claims like
// "General surgery program" — even though no single claim contains the whole
// phrase. Tokens shorter than 3 chars and generic stop-words are ignored so we
// don't paint half the card yellow.

// Levenshtein edit distance — deterministic, no ML. Used only to suggest a
// closely-spelled specialty when a search returns zero results, so a typo like
// "dialisis" can point the user at "dialysis". It corrects MISSPELLINGS, not
// synonyms or abbreviations (those need semantic/vector search — see roadmap).
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Suggest known specialties whose spelling is within a strict edit-distance of
 * the searched need. Returns up to 3 distinct terms, closest first. Only fires
 * for genuine typos (dist > 0, threshold scales with word length but capped),
 * never for exact matches or wildly different words.
 */
function suggestSpecialties(
  need: string,
  options: { specialty: string }[],
): string[] {
  const q = need.trim().toLowerCase();
  if (q.length < 4 || options.length === 0) return [];
  // Cap at distance 2 and require the same first letter: typos rarely change
  // the initial char, and this keeps us from suggesting a semantically
  // different real specialty (e.g. "cardiology" → "radiology"), which would
  // undermine the evidence-honest promise.
  const threshold = Math.min(2, Math.max(1, Math.floor(q.length * 0.34)));
  const scored = options
    .map((o) => ({ term: o.specialty, dist: editDistance(q, o.specialty.toLowerCase()) }))
    .filter((s) => s.dist > 0 && s.dist <= threshold && s.term.toLowerCase()[0] === q[0])
    .sort((a, b) => a.dist - b.dist);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of scored) {
    const key = s.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.term);
    if (out.length === 3) break;
  }
  return out;
}

const STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'care', 'need', 'needs', 'service', 'services',
  'treatment', 'help', 'near', 'have', 'has', 'any', 'all',
]);

/** Split a free-text need into meaningful lowercase search tokens. */
function tokenizeNeedle(needle: string): string[] {
  return Array.from(
    new Set(
      needle
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
    ),
  );
}

/** True if any search token appears in the text. */
function matchesNeedle(text: string, needle: string): boolean {
  const lower = text.toLowerCase();
  return tokenizeNeedle(needle).some((t) => lower.includes(t));
}

/** Stable sort that floats items matching the search term to the front. */
function matchesFirst(items: string[], needle: string): string[] {
  if (!tokenizeNeedle(needle).length) return items;
  const hit: string[] = [];
  const rest: string[] = [];
  for (const it of items) (matchesNeedle(it, needle) ? hit : rest).push(it);
  return [...hit, ...rest];
}

/** Wrap every occurrence of any search token in a soft yellow highlighter. */
function highlightMatch(text: string, needle: string): ReactNode {
  const tokens = tokenizeNeedle(needle);
  if (!tokens.length) return text;
  const lower = text.toLowerCase();
  // Collect every [start,end) span covered by any token, then merge overlaps.
  const spans: Array<[number, number]> = [];
  for (const t of tokens) {
    let from = 0;
    for (;;) {
      const found = lower.indexOf(t, from);
      if (found === -1) break;
      spans.push([found, found + t.length]);
      from = found + t.length;
    }
  }
  if (!spans.length) return text;
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const [s, e] of merged) {
    if (s > cursor) parts.push(text.slice(cursor, s));
    parts.push(
      <mark key={key++} className="rounded-sm bg-yellow-200/70 px-0.5 text-foreground dark:bg-yellow-300/30">
        {text.slice(s, e)}
      </mark>,
    );
    cursor = e;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

// ---------- per-need trust signal (is the match actually evidenced?) ----------
// The facility-level evidence_score answers "is this facility well-documented?".
// But the user asked for a SPECIFIC need (e.g. "dialysis"). A facility can score
// "Strong" overall yet only *mention* dialysis in free-text, with no cited claim.
// This signal answers "how strong is the evidence for THE NEED YOU SEARCHED?" and
// surfaces the exact source text that matched — so a match is never a black box.

type NeedTrustLevel = 'cited' | 'listed' | 'offered' | 'mentioned' | 'none';

type NeedTrust = {
  level: NeedTrustLevel;
  /** Plain-language qualifier shown next to the searched term. */
  qualifier: string;
  /** Tailwind colour classes (green = strongest … amber = weak). */
  className: string;
  /** When the match is only in free-text, the snippet that matched. */
  snippet: string | null;
};

/** Extract a short window of `text` around the earliest matching token. */
function snippetAround(text: string, tokens: string[], radius = 70): string | null {
  const lower = text.toLowerCase();
  let idx = -1;
  let hitLen = 0;
  for (const t of tokens) {
    const f = lower.indexOf(t);
    if (f !== -1 && (idx === -1 || f < idx)) {
      idx = f;
      hitLen = t.length;
    }
  }
  if (idx === -1) return null;
  let start = Math.max(0, idx - radius);
  let end = Math.min(text.length, idx + hitLen + radius);
  while (start > 0 && /\S/.test(text[start - 1])) start--; // snap to word start
  while (end < text.length && /\S/.test(text[end])) end++; // snap to word end
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/** Classify how strongly the searched need is evidenced at this facility. */
function needTrustSignal(
  needle: string,
  capabilityClaims: string[],
  specialties: string[],
  procedures: string[],
  equipment: string[],
  description: string | null,
  hasSources: boolean,
): NeedTrust | null {
  const tokens = tokenizeNeedle(needle);
  if (!tokens.length) return null;

  if (capabilityClaims.some((c) => matchesNeedle(c, needle))) {
    return hasSources
      ? { level: 'cited', qualifier: 'cited capability claim, traceable to a source', className: 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400', snippet: null }
      : { level: 'cited', qualifier: 'cited capability claim (no source link)', className: 'bg-primary/10 text-primary', snippet: null };
  }
  if (specialties.some((s) => matchesNeedle(s, needle))) {
    return { level: 'listed', qualifier: 'listed as a declared specialty', className: 'bg-primary/10 text-primary', snippet: null };
  }
  // Structured procedure / equipment lists: a concrete service the facility
  // states it performs or has the kit for. Stronger than a free-text mention
  // (it's a structured claim), weaker than a declared specialty / cited claim.
  const procHit = procedures.find((p) => matchesNeedle(p, needle));
  if (procHit) {
    return {
      level: 'offered',
      qualifier: 'listed as a procedure performed here',
      className: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
      snippet: snippetAround(procHit, tokens),
    };
  }
  const equipHit = equipment.find((e) => matchesNeedle(e, needle));
  if (equipHit) {
    return {
      level: 'offered',
      qualifier: 'listed in the facility’s equipment',
      className: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
      snippet: snippetAround(equipHit, tokens),
    };
  }
  const desc = description ?? '';
  if (matchesNeedle(desc, needle)) {
    return {
      level: 'mentioned',
      qualifier: 'only mentioned in free-text description — not a cited claim',
      className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
      snippet: snippetAround(desc, tokens),
    };
  }
  return { level: 'none', qualifier: 'no explicit mention found in the listed fields', className: 'bg-muted text-muted-foreground', snippet: null };
}

// For weak per-need evidence (mentioned / none), spell out WHAT is missing so a
// care coordinator can see the gap, not just a colour. Turning uncertainty into
// a concrete checklist is the difference between "looks shaky" and "here's what
// to confirm before you refer a patient here".
function missingEvidenceFor(trust: NeedTrust | null, hasSources: boolean): string[] {
  if (!trust || trust.level === 'cited' || trust.level === 'listed' || trust.level === 'offered') return [];
  const gaps = ['no cited capability claim for this need', 'not a declared specialty'];
  if (!hasSources) gaps.push('no source link');
  return gaps;
}

// How relevant is this facility to the SEARCHED need? Higher = better match.
// This is the primary ranking key when a need is given, so a facility that is
// well-documented overall but a poor fit for the search doesn't outrank a
// facility that actually offers (and cites) the searched service.
function needRelevanceScore(trust: NeedTrust | null): number {
  switch (trust?.level) {
    case 'cited':
      return 5;
    case 'listed':
      return 4;
    case 'offered':
      return 3;
    case 'mentioned':
      return 2;
    default:
      return 1; // 'none' or no need searched
  }
}

// Pin colour driven by per-need relevance (mirrors the card's trust badge),
// so the map answers "how good a match for my search?" rather than "how
// documented overall?".
function needPinColor(trust: NeedTrust | null): string {
  switch (trust?.level) {
    case 'cited':
      return '#16a34a'; // green  - cited capability
    case 'listed':
      return '#2563eb'; // blue   - listed specialty
    case 'offered':
      return '#0891b2'; // cyan   - listed procedure / equipment
    case 'mentioned':
      return '#d97706'; // amber  - only free-text mention
    default:
      return '#6b7280'; // gray   - no explicit match
  }
}

// Short human label for a per-need relevance level (shown in the map popup so
// the pin colour is self-explanatory).
function needRelevanceLabel(trust: NeedTrust | null): string {
  switch (trust?.level) {
    case 'cited':
      return 'Cited capability for your search';
    case 'listed':
      return 'Listed as a specialty';
    case 'offered':
      return 'Listed procedure / equipment';
    case 'mentioned':
      return 'Only mentioned in description';
    default:
      return 'No explicit match for your search';
  }
}

// ---------- evidence & uncertainty ----------
// Core requirement: communicate uncertainty, never present weak evidence as
// fact. The evidence_score (0–12) is mapped to a confidence tier with distinct
// colour + label, and weak/incomplete facilities get an explicit caveat.

type EvidenceTier = {
  label: string;
  /** Tailwind classes for the badge (colour communicates confidence). */
  className: string;
  /** Whether this tier is low enough to warrant a visible warning icon. */
  weak: boolean;
};

function evidenceTier(score: number): EvidenceTier {
  if (score <= 2)
    return { label: 'Insufficient evidence', className: 'bg-destructive/10 text-destructive', weak: true };
  if (score <= 5)
    return { label: 'Limited evidence', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400', weak: true };
  if (score <= 8) return { label: 'Moderate evidence', className: 'bg-primary/10 text-primary', weak: false };
  return { label: 'Strong evidence', className: 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400', weak: false };
}

/** Plain-language caveat that names *why* confidence is limited, so a
 *  non-technical user knows what to double-check. Returns null when the
 *  evidence is strong and complete. */
function evidenceCaveat(score: number, citedClaims: number, hasSources: boolean): string | null {
  if (score <= 2)
    return 'Almost no verifiable information for this facility — treat as unconfirmed and verify directly before referring a patient.';
  if (score <= 5)
    return 'Limited verifiable signals. Confirm key details (services, capacity, contact) directly with the facility before relying on this recommendation.';
  if (citedClaims === 0)
    return 'No cited capability claims — this ranking is based on metadata only, not on described services.';
  if (!hasSources) return 'No source links provided, so the claims below could not be traced back to an original source.';
  return null;
}

function toScore(value: unknown): number {
  return typeof value === 'number' ? value : Number(value) || 0;
}

// Databricks DOUBLE columns (distance_km, latitude, longitude) arrive as
// STRINGS at runtime, so `typeof x === 'number'` is false. Coerce, and return
// null for anything non-finite so callers can branch cleanly.
function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---------- review decisions (overrides) ----------
// Persisted per-facility so a referrer's decision survives across sessions.

const STATUS_OPTIONS: { value: ShortlistStatus; label: string }[] = [
  { value: 'considering', label: 'Considering' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'rejected', label: 'Rejected' },
];

function statusMeta(status: ShortlistStatus): { label: string; className: string } {
  switch (status) {
    case 'reviewed':
      return { label: 'Reviewed', className: 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400' };
    case 'rejected':
      return { label: 'Rejected', className: 'bg-destructive/10 text-destructive' };
    case 'follow_up':
      return { label: 'Follow-up', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' };
    default:
      return { label: 'Considering', className: 'bg-muted text-muted-foreground' };
  }
}

type Query = { state: string; city: string; need: string };

// One-click starting points so a first-time visitor (or a judge opening the app
// cold) immediately sees what to do. Each runs the same evidence SQL as a manual
// search — the structured fields are filled in too, so it stays transparent.
const EXAMPLE_QUERIES: { label: string; query: Query }[] = [
  { label: 'Dialysis near Jaipur', query: { need: 'dialysis', city: 'Jaipur', state: '' } },
  { label: 'Cardiology near Mumbai', query: { need: 'cardiology', city: 'Mumbai', state: '' } },
  { label: 'Maternity in Rajasthan', query: { need: 'maternity', city: '', state: 'Rajasthan' } },
];

// ---------- app shell ----------

export default function App() {
  const [need, setNeed] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [submitted, setSubmitted] = useState<Query | null>(null);

  // Natural-language search ("dialysis near Jaipur"): a Foundation Model parses
  // free text into structured params, which then drive the same evidence SQL.
  const [nlText, setNlText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [nlError, setNlError] = useState<string | null>(null);

  // Compact the above-the-fold: one search card with two tabs instead of two
  // stacked cards. Plain-English is the default (it's the friendliest entry).
  const [searchTab, setSearchTab] = useState<'nl' | 'fields'>('nl');

  async function runNlSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = nlText.trim();
    if (!q || parsing) return;
    setParsing(true);
    setNlError(null);
    try {
      const res = await fetch('/api/parse-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Parse failed (${res.status})`);
      }
      const parsed = (await res.json()) as { need: string; city: string; state: string };
      // Reflect the parse into the structured form (transparency: the user sees
      // exactly what we searched) and run the search.
      setNeed(parsed.need);
      setCity(parsed.city);
      setState(parsed.state);
      setSubmitted({ state: parsed.state, city: parsed.city, need: parsed.need });
      // Reveal the parsed fields so the user can see/adjust exactly what ran.
      setSearchTab('fields');
    } catch (err) {
      setNlError(err instanceof Error ? err.message : 'Could not understand that request.');
    } finally {
      setParsing(false);
    }
  }

  const stateParams = useMemo(() => ({}), []);
  const { data: states } = useAnalyticsQuery('states', stateParams);

  // Autocomplete sources.
  const specialtyParams = useMemo(() => ({}), []);
  const { data: specialtyOptions } = useAnalyticsQuery('specialties', specialtyParams);

  // Cities are scoped to the currently selected state (reactive, not on submit).
  const cityParams = useMemo(() => ({ state: sql.string(state) }), [state]);
  const { data: cityOptions } = useAnalyticsQuery('cities', cityParams);

  // Persistent user actions (saved facilities + notes), stored in Lakebase.
  const shortlist = useShortlist();
  // Shared community reviews (the collaborative feedback loop) — visible to all.
  const reviews = useReviews();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted({ state, city, need });
  }

  // Reflect a one-click example into the form (transparency) and run it.
  function runExample(q: Query) {
    setNeed(q.need);
    setCity(q.city);
    setState(q.state);
    setNlText('');
    setNlError(null);
    setSubmitted(q);
  }

  // Apply a "did you mean" specialty correction: update the form field and
  // re-run the search with the corrected need (city/state unchanged).
  function correctNeed(corrected: string) {
    setNeed(corrected);
    setSubmitted((prev) =>
      prev ? { ...prev, need: corrected } : { state, city, need: corrected },
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-4 md:px-6 py-3 flex items-center gap-3">
        <Stethoscope className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-lg font-semibold text-foreground leading-tight">Referral Copilot</h1>
          <p className="text-xs text-muted-foreground">
            For care coordinators &amp; patients: find the right facility for a need, near a place — with the evidence
            to back it. India.
          </p>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-6">
        <div className="max-w-5xl mx-auto space-y-4">
          {/* single compact search card: two tabs (plain-English default +
              structured fields) so the controls don't push results below the fold */}
          <Card className="shadow-sm border-primary/30">
            <CardContent className="pt-4">
              {/* tab bar */}
              <div className="flex items-center gap-1 border-b">
                <button
                  type="button"
                  role="tab"
                  aria-selected={searchTab === 'nl'}
                  onClick={() => setSearchTab('nl')}
                  className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
                    searchTab === 'nl'
                      ? 'border-primary text-foreground font-medium'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Sparkles className="h-4 w-4" /> Ask in plain English
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={searchTab === 'fields'}
                  onClick={() => setSearchTab('fields')}
                  className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
                    searchTab === 'fields'
                      ? 'border-primary text-foreground font-medium'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Search className="h-4 w-4" /> Search by field
                </button>
              </div>

              {/* tab panels */}
              <div className="pt-3">
                {searchTab === 'nl' ? (
                  <>
                    <form onSubmit={runNlSearch} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <input
                        value={nlText}
                        onChange={(e) => setNlText(e.target.value)}
                        placeholder="e.g. dialysis near Jaipur · emergency surgery near Patna"
                        className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <Button type="submit" className="h-9 sm:w-auto" disabled={parsing || !nlText.trim()}>
                        {parsing ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <Sparkles className="h-4 w-4 mr-1" />
                        )}
                        {parsing ? 'Understanding…' : 'Search'}
                      </Button>
                    </form>
                    {nlError ? (
                      <p className="mt-1.5 text-xs text-destructive">{nlError}</p>
                    ) : (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Parsed into structured fields you can review and tweak under “Search by field”.
                      </p>
                    )}
                  </>
                ) : (
                  <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">Care need / specialty</span>
                      <input
                        value={need}
                        onChange={(e) => setNeed(e.target.value)}
                        placeholder="e.g. oncology, ICU, maternity"
                        list="need-options"
                        autoComplete="off"
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <datalist id="need-options">
                        {specialtyOptions?.map((o) => (
                          <option key={o.specialty} value={o.specialty}>
                            {humanize(o.specialty)} ({o.facility_count})
                          </option>
                        ))}
                      </datalist>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">State / region</span>
                      <select
                        value={state}
                        onChange={(e) => setState(e.target.value)}
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="">Any state</option>
                        {states?.map((s) => (
                          <option key={s.state} value={s.state}>
                            {s.state} ({s.facility_count})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">Near (city)</span>
                      <input
                        value={city}
                        onChange={(e) => setCity(e.target.value)}
                        placeholder="e.g. Jaipur"
                        list="city-options"
                        autoComplete="off"
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <datalist id="city-options">
                        {cityOptions?.map((o) => (
                          <option key={o.city} value={o.city}>
                            {o.city} ({o.facility_count})
                          </option>
                        ))}
                      </datalist>
                    </label>
                    <Button type="submit" className="h-9">
                      <Search className="h-4 w-4 mr-1" /> Search
                    </Button>
                  </form>
                )}
              </div>

              {/* one-click starting points — always available in both tabs */}
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                <span className="text-xs text-muted-foreground">Try:</span>
                {EXAMPLE_QUERIES.map((ex) => (
                  <button
                    key={ex.label}
                    type="button"
                    onClick={() => runExample(ex.query)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-3 py-1 text-xs text-primary transition-colors hover:bg-primary/10"
                  >
                    <Search className="h-3 w-3" />
                    {ex.label}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* saved facilities (persisted in Lakebase) — collapsible so it never
              pushes results below the fold */}
          {shortlist.items.length > 0 && <ShortlistPanel shortlist={shortlist} />}

          {/* results */}
          {submitted ? (
            <Results
              query={submitted}
              shortlist={shortlist}
              reviews={reviews}
              specialtyOptions={specialtyOptions ?? []}
              onCorrect={correctNeed}
            />
          ) : (
            <p className="text-sm text-muted-foreground text-center py-12">
              Enter a care need and location above — or tap an example to start.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

// ---------- shortlist panel ----------

function ShortlistPanel({ shortlist }: { shortlist: ShortlistApi }) {
  return (
    <Card className="shadow-sm border-primary/30">
      <details open className="group">
        <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-6 py-3 text-base font-semibold text-foreground [&::-webkit-details-marker]:hidden">
          <Star className="h-4 w-4 fill-primary text-primary" /> My shortlist ({shortlist.items.length})
          <span className="ml-auto text-xs font-normal text-muted-foreground group-open:hidden">Show</span>
          <span className="ml-auto hidden text-xs font-normal text-muted-foreground group-open:inline">Hide</span>
        </summary>
        <div className="space-y-3 px-6 pb-4">
          {shortlist.items.map((item) => (
            <ShortlistRow key={item.facility_id} item={item} shortlist={shortlist} />
          ))}
        </div>
      </details>
    </Card>
  );
}

/** Short, locale-aware date (e.g. "16 Jun 2026"); '' for unparseable input. */
function formatDate(value: unknown): string {
  if (!value) return '';
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function ShortlistRow({ item, shortlist }: { item: ShortlistItem; shortlist: ShortlistApi }) {
  const [note, setNoteText] = useState(item.note);
  const dirty = note !== item.note;
  const status: ShortlistStatus = item.status ?? 'considering';
  const meta = statusMeta(status);
  const rejected = status === 'rejected';

  return (
    <div className={`rounded-md border bg-muted/20 p-3 ${rejected ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={`text-sm font-medium text-foreground ${rejected ? 'line-through' : ''}`}>
            {item.facility_name || 'Unnamed facility'}
            <span className={`ml-2 align-middle rounded-full px-1.5 py-0.5 text-[10px] font-normal ${meta.className}`}>
              {meta.label}
            </span>
          </p>
          <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
            <MapPin className="h-3 w-3" />
            {[item.facility_city, item.facility_state].filter(Boolean).join(', ') || 'Location unknown'}
            {item.evidence_score != null && (() => {
              const tier = evidenceTier(item.evidence_score);
              return (
                <span className={`ml-2 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${tier.className}`}>
                  {tier.weak ? <ShieldAlert className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
                  {tier.label}
                </span>
              );
            })()}
          </p>
          {/* Context for the decision: which service was searched, and when. */}
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {item.need?.trim() && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                <Stethoscope className="h-3 w-3" /> {item.need.trim()}
              </span>
            )}
            {formatDate(item.created_at) && <span>Saved {formatDate(item.created_at)}</span>}
            {formatDate(item.updated_at) && item.updated_at !== item.created_at && (
              <span>· updated {formatDate(item.updated_at)}</span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void shortlist.remove(item.facility_id)}
          title="Remove from shortlist"
          className="shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-destructive hover:border-destructive/50"
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </button>
      </div>

      {/* review decision (override) — persisted to Lakebase */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground mr-0.5">Decision:</span>
        {STATUS_OPTIONS.map((opt) => {
          const active = status === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() => void shortlist.setStatus(item.facility_id, opt.value)}
              className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                active
                  ? `${statusMeta(opt.value).className} border-transparent font-medium`
                  : 'text-muted-foreground hover:text-foreground hover:border-foreground/30'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        <textarea
          value={note}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="Add a private note (e.g. why you're considering this facility)…"
          rows={2}
          className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        {dirty && (
          <div className="flex gap-2">
            <Button
              type="button"
              className="h-7 text-xs"
              onClick={() => void shortlist.setNote(item.facility_id, note)}
            >
              Save note
            </Button>
            <button
              type="button"
              onClick={() => setNoteText(item.note)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- results ----------

type SortMode = 'distance' | 'evidence';

function Results({
  query,
  shortlist,
  reviews,
  specialtyOptions,
  onCorrect,
}: {
  query: Query;
  shortlist: ShortlistApi;
  reviews: ReviewsApi;
  specialtyOptions: { specialty: string }[];
  onCorrect: (term: string) => void;
}) {
  const params = useMemo(
    () => ({
      state: sql.string(query.state),
      city: sql.string(query.city),
      need: sql.string(query.need),
    }),
    [query],
  );

  const { data, loading, error } = useAnalyticsQuery('facility_search', params);

  // Result controls (client-side over the already-ranked SQL result).
  const hasNeed = query.need.trim().length > 0;
  const hasCity = query.city.trim().length > 0;
  const [onlyMatches, setOnlyMatches] = useState(false);
  // Default sort follows the SQL: distance-first when a city is given, else evidence.
  const [sortMode, setSortMode] = useState<SortMode>(hasCity ? 'distance' : 'evidence');

  const visible = useMemo(() => {
    if (!data) return [];
    let rows = [...data];
    if (onlyMatches && hasNeed) {
      rows = rows.filter((r) => {
        const t = computeRowTrust(r, query.need);
        return t?.level === 'cited' || t?.level === 'listed' || t?.level === 'offered';
      });
    }
    if (sortMode === 'evidence') {
      rows.sort((a, b) => {
        // 1) When a need is searched, per-need relevance leads: a facility that
        //    actually offers (and cites) the searched service ranks above one
        //    that's merely well-documented overall.
        if (hasNeed) {
          const rel =
            needRelevanceScore(computeRowTrust(b, query.need)) - needRelevanceScore(computeRowTrust(a, query.need));
          if (rel !== 0) return rel;
        }
        // 2) Facility-level evidence, then 3) distance, as tiebreakers.
        const diff = toScore(b.evidence_score) - toScore(a.evidence_score);
        if (diff !== 0) return diff;
        const da = toFiniteNumber(a.distance_km) ?? Infinity;
        const db = toFiniteNumber(b.distance_km) ?? Infinity;
        return da - db;
      });
    } else {
      rows.sort((a, b) => {
        const da = toFiniteNumber(a.distance_km) ?? Infinity;
        const db = toFiniteNumber(b.distance_km) ?? Infinity;
        if (da !== db) return da - db;
        return toScore(b.evidence_score) - toScore(a.evidence_score);
      });
    }
    return rows;
  }, [data, onlyMatches, hasNeed, sortMode, query.need]);

  // Batch-load community review summaries for the visible facilities, so each
  // card shows the shared feedback without an N+1 of per-card requests. Keyed on
  // the concrete id list so it re-runs when the result set changes.
  const visibleIdsKey = visible.map((r) => r.unique_id).join(',');
  const { loadSummaries } = reviews;
  useEffect(() => {
    const ids = visibleIdsKey ? visibleIdsKey.split(',') : [];
    if (ids.length) void loadSummaries(ids);
  }, [visibleIdsKey, loadSummaries]);

  // Map pin → card: keep a live registry of each card's wrapper element keyed by
  // facility id, so a click on the map can scroll the matching card into view
  // and flash it briefly. Refs (not state) — we don't want a re-render per card.
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const handleSelectOnMap = useCallback((uniqueId: string) => {
    const el = cardRefs.current.get(uniqueId);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Brief highlight so the eye lands on the right card after the scroll.
    el.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'rounded-lg');
    window.setTimeout(() => {
      el.classList.remove('ring-2', 'ring-primary', 'ring-offset-2', 'rounded-lg');
    }, 1600);
  }, []);

  // Whether any visible row has usable coordinates — drives the two-column
  // (cards + map) layout vs. a single column when the map would be empty.
  const hasMapPoints = useMemo(
    () =>
      visible.some((r) => {
        const lat = Number(r.latitude);
        const lon = Number(r.longitude);
        return Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
      }),
    [visible],
  );

  // Enrich map points with a per-need relevance colour when a need is searched,
  // so the pin colour answers "how good a match for my search?". With no need,
  // fall through to the map's evidence-tier colouring.
  const mapPoints = useMemo(
    () =>
      hasNeed
        ? visible.map((r) => {
            const t = computeRowTrust(r, query.need);
            return { ...r, pinColor: needPinColor(t), relevanceLabel: needRelevanceLabel(t) };
          })
        : visible,
    [visible, hasNeed, query.need],
  );

  // Colour legend for the map — per-need relevance tiers when a service was
  // searched, otherwise facility-evidence tiers.
  const mapLegend = useMemo(
    () =>
      hasNeed
        ? [
            { color: '#16a34a', label: 'Cited' },
            { color: '#2563eb', label: 'Listed' },
            { color: '#0891b2', label: 'Procedure/equipment' },
            { color: '#d97706', label: 'Mentioned' },
            { color: '#6b7280', label: 'No match' },
          ]
        : [
            { color: '#16a34a', label: 'Strong' },
            { color: '#2563eb', label: 'Moderate' },
            { color: '#d97706', label: 'Limited' },
            { color: '#6b7280', label: 'Insufficient' },
          ],
    [hasNeed],
  );

  if (loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }
  if (error) return <div className="text-destructive text-sm">Error: {error}</div>;
  if (!data || data.length === 0) {
    const suggestions = hasNeed ? suggestSpecialties(query.need, specialtyOptions) : [];
    return (
      <div className="text-center py-12 space-y-3">
        <p className="text-sm text-muted-foreground">
          No facilities matched your search
          {hasNeed ? (
            <>
              {' '}for &ldquo;<span className="font-medium text-foreground">{query.need}</span>&rdquo;
            </>
          ) : null}
          .
        </p>
        {suggestions.length > 0 ? (
          <div className="flex flex-col items-center gap-2">
            <p className="text-sm text-muted-foreground">Did you mean:</p>
            <div className="flex flex-wrap justify-center gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onCorrect(s)}
                  className="rounded-full border border-input bg-background px-3 py-1 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  {humanize(s)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* result controls: filter to real matches + choose sort */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Showing <span className="font-medium text-foreground">{visible.length}</span>
          {visible.length !== data.length ? <span> of {data.length}</span> : null} facilities ·{' '}
          {sortMode === 'distance' && hasCity
            ? `nearest to ${query.city.trim()} first`
            : hasNeed
              ? 'best match for your search first'
              : 'strongest evidence first'}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {hasNeed && (
            <button
              type="button"
              aria-pressed={onlyMatches}
              onClick={() => setOnlyMatches((v) => !v)}
              title="Hide facilities where the searched service is only mentioned in free text (not a cited or listed capability)."
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                onlyMatches
                  ? 'border-primary/50 bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:border-foreground/30'
              }`}
            >
              <ListFilter className="h-3.5 w-3.5" /> Only real matches
            </button>
          )}
          <div className="inline-flex items-center rounded-full border p-0.5 text-xs">
            <ArrowUpDown className="h-3.5 w-3.5 mx-1 text-muted-foreground" />
            <button
              type="button"
              aria-pressed={sortMode === 'distance'}
              onClick={() => setSortMode('distance')}
              disabled={!hasCity}
              title={hasCity ? 'Sort by distance' : 'Add a "Near (city)" to sort by distance'}
              className={`rounded-full px-2 py-0.5 transition-colors disabled:opacity-40 ${
                sortMode === 'distance' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Distance
            </button>
            <button
              type="button"
              aria-pressed={sortMode === 'evidence'}
              onClick={() => setSortMode('evidence')}
              title={
                hasNeed
                  ? 'Sort by relevance to your search (cited > listed > mentioned), then facility evidence'
                  : 'Sort by facility evidence'
              }
              className={`rounded-full px-2 py-0.5 transition-colors ${
                sortMode === 'evidence' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {hasNeed ? 'Relevance' : 'Evidence'}
            </button>
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Items with limited or insufficient evidence are flagged, not hidden, so you can judge them yourself.
      </p>

      <ConfidenceExplainer />

      <div
        className={
          hasMapPoints
            ? 'grid gap-4 lg:grid-cols-[1fr_22rem] lg:items-start'
            : 'space-y-3'
        }
      >
        {/* results list (left on desktop) */}
        <div className="space-y-3 min-w-0 order-2 lg:order-1">
          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No facilities have a cited or listed match for “{query.need.trim()}”.{' '}
              <button type="button" onClick={() => setOnlyMatches(false)} className="text-primary underline underline-offset-2">
                Show all results
              </button>
            </p>
          ) : (
            visible.map((row) => (
              <div
                key={row.unique_id}
                ref={(el) => {
                  if (el) cardRefs.current.set(row.unique_id, el);
                  else cardRefs.current.delete(row.unique_id);
                }}
                className="transition-shadow scroll-mt-4"
              >
                <FacilityCard
                  row={row}
                  needle={query.need}
                  saved={shortlist.savedIds.has(row.unique_id)}
                  onSave={shortlist.save}
                  onRemove={shortlist.remove}
                  reviews={reviews}
                />
              </div>
            ))
          )}
        </div>

        {/* map (right on desktop, sticky so it stays in view while scrolling cards) */}
        {hasMapPoints && (
          <div className="order-1 lg:order-2 lg:sticky lg:top-4">
            <FacilityMap
              points={mapPoints}
              city={query.city}
              heightClass="h-72 lg:h-[34rem]"
              colorMeaning={hasNeed ? 'match for your search (cited / listed / mentioned)' : 'evidence tier'}
              legend={mapLegend}
              onSelect={handleSelectOnMap}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** In-app documentation of the confidence model. Transparency matters: the
 *  user (and reviewers) can see exactly how the evidence score is built, so the
 *  ranking is auditable rather than a black box. Mirrors the formula in
 *  config/queries/facility_search.sql. */
function ConfidenceExplainer() {
  return (
    <details className="rounded-md border bg-muted/20 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none px-3 py-2 font-medium text-foreground hover:text-primary">
        How is confidence calculated?
      </summary>
      <div className="space-y-2 border-t px-3 py-2.5">
        <p>
          Each facility gets an <strong className="text-foreground">evidence score (0–12)</strong> built only from
          verifiable signals in the source data — never from opinion or AI guessing:
        </p>
        <ul className="space-y-1">
          <li className="flex justify-between gap-4">
            <span>Has cited capability claims</span>
            <span className="text-foreground tabular-nums">+2</span>
          </li>
          <li className="flex justify-between gap-4">
            <span>Each individual cited claim (up to 5)</span>
            <span className="text-foreground tabular-nums">+1 each</span>
          </li>
          <li className="flex justify-between gap-4">
            <span>Has source links (traceable to origin)</span>
            <span className="text-foreground tabular-nums">+2</span>
          </li>
          <li className="flex justify-between gap-4">
            <span>Geo-coordinates · capacity · staffing</span>
            <span className="text-foreground tabular-nums">+1 each</span>
          </li>
        </ul>
        <p>The total maps to a confidence tier:</p>
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-full bg-emerald-600/15 px-2 py-0.5 text-emerald-700 dark:text-emerald-400">
            Strong · 9–12
          </span>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">Moderate · 6–8</span>
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-400">
            Limited · 3–5
          </span>
          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">Insufficient · 0–2</span>
        </div>
        <p>
          Facilities with <em>limited</em> or <em>insufficient</em> evidence stay in the results but carry a warning —
          weak evidence is surfaced honestly, never presented as fact.
        </p>
        <p className="border-t pt-2">
          <strong className="text-foreground">Two separate signals.</strong> The{' '}
          <strong className="text-foreground">Facility</strong> score above answers “how well-documented is this place
          overall?”. The <strong className="text-foreground">Your search for “…”</strong> note on each result answers a
          different question: “is the specific service you searched for actually evidenced here — cited, listed as a
          specialty, listed as a procedure/equipment, or only mentioned in free text?”. A facility can be well-documented
          overall (Strong · 12) while your exact search
          term is only weakly evidenced — both can be true at once, and we show both.
        </p>
        <div className="border-t pt-2 space-y-2">
          <p>
            <strong className="text-foreground">Ranking &amp; map colour (when you search a service).</strong> Results are
            ordered by <em>relevance to that service first</em>, then facility evidence, then distance — so a place that
            actually offers (and cites) what you searched outranks one that’s merely well-documented. The five relevance
            tiers (highest → lowest) are:
          </p>
          <ul className="space-y-1">
            <li className="flex items-center gap-2">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: '#16a34a' }} />
              <span className="text-foreground">Cited</span> — the searched service is a cited capability claim
              (traceable to a source).
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: '#2563eb' }} />
              <span className="text-foreground">Listed</span> — appears as a declared specialty.
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: '#0891b2' }} />
              <span className="text-foreground">Procedure/equipment</span> — listed in the facility’s structured
              procedures or equipment (a concrete service, stronger than a free-text mention).
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: '#d97706' }} />
              <span className="text-foreground">Mentioned</span> — only found in the free-text description (weaker).
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: '#6b7280' }} />
              <span className="text-foreground">No match</span> — no explicit mention in the listed fields.
            </li>
          </ul>
          <p>
            The <strong className="text-foreground">map pin colour uses these same tiers</strong>, and each pin’s popup
            states the reason for its colour. When you search by location only (no service), ranking and pin colour fall
            back to the facility evidence tier (Strong / Moderate / Limited / Insufficient).
          </p>
        </div>
      </div>
    </details>
  );
}

type FacilityRow = QueryRegistry['facility_search']['result'][number];

/** Compute how strongly the searched need is evidenced for a row — used both to
 *  render the per-need trust signal and to power the "only real matches" filter
 *  at the results level (so the two never diverge). */
function computeRowTrust(row: FacilityRow, needle: string): NeedTrust | null {
  const allSpecialties = unique(parseJsonArray(row.specialties).map(humanize));
  const allCapability = parseJsonArray(row.capability);
  const allProcedures = parseJsonArray(row.procedure_list);
  const allEquipment = parseJsonArray(row.equipment_list);
  const hasSources = unique(parseJsonArray(row.source_urls).filter(isHttpUrl)).length > 0;
  return needTrustSignal(needle, allCapability, allSpecialties, allProcedures, allEquipment, row.description, hasSources);
}

function FacilityCard({
  row,
  needle,
  saved,
  onSave,
  onRemove,
  reviews,
}: {
  row: FacilityRow;
  needle: string;
  saved: boolean;
  onSave: ShortlistApi['save'];
  onRemove: ShortlistApi['remove'];
  reviews: ReviewsApi;
}) {
  // Float the matched specialty/claim to the front *before* capping, so the
  // reason this facility matched is never truncated away.
  const allSpecialties = unique(parseJsonArray(row.specialties).map(humanize));
  const allCapability = parseJsonArray(row.capability);
  const allProcedures = parseJsonArray(row.procedure_list);
  const allEquipment = parseJsonArray(row.equipment_list);
  const specialties = matchesFirst(allSpecialties, needle).slice(0, 8);
  const evidence = matchesFirst(allCapability, needle).slice(0, 4);
  const sources = unique(parseJsonArray(row.source_urls).filter(isHttpUrl)).slice(0, 5);

  const score = toScore(row.evidence_score);
  const tier = evidenceTier(score);
  const caveat = evidenceCaveat(score, toScore(row.n_capabilities), sources.length > 0);

  // Contact actions — the "act on it" step a coordinator actually needs.
  const phone = clean(row.officialPhone);
  const telHref = phone ? `tel:${phone.replace(/[^\d+]/g, '')}` : null;
  const websiteUrl = toWebsiteHref(row.officialWebsite);

  // How strongly is the SEARCHED need evidenced here? (checks full, untruncated
  // lists + description, so the "why did this match?" is always answerable.)
  const trust = needTrustSignal(needle, allCapability, allSpecialties, allProcedures, allEquipment, row.description, sources.length > 0);
  const missing = missingEvidenceFor(trust, sources.length > 0);

  function toggleSave() {
    if (saved) {
      void onRemove(row.unique_id);
    } else {
      void onSave({
        facility_id: row.unique_id,
        facility_name: row.name ?? '',
        facility_city: clean(row.city) ?? '',
        facility_state: clean(row.state) ?? '',
        evidence_score: typeof row.evidence_score === 'number' ? row.evidence_score : null,
        need: needle.trim(),
      });
    }
  }

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{row.name || 'Unnamed facility'}</CardTitle>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
              <MapPin className="h-3 w-3" />
              {[row.city, row.state].filter(Boolean).join(', ') || 'Location unknown'}
              {(() => {
                const km = toFiniteNumber(row.distance_km);
                if (km === null) return null;
                return (
                  <span className="ml-1 inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                    ~{Math.round(km)} km away
                  </span>
                );
              })()}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              title={`How well-documented this FACILITY is overall (score ${score} of ~12): rewards cited claims, source links, coordinates, capacity and staffing. This is separate from whether the service you searched for is evidenced — see the "Match for…" note below.`}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${tier.className}`}
            >
              {tier.weak ? <ShieldAlert className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              <span className="opacity-70">Facility:</span> {tier.label} · {score}
            </span>
            <button
              type="button"
              onClick={toggleSave}
              title={saved ? 'Remove from shortlist' : 'Save to shortlist'}
              aria-pressed={saved}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
                saved
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-primary hover:border-primary/50'
              }`}
            >
              <Star className={`h-3.5 w-3.5 ${saved ? 'fill-primary' : ''}`} />
              {saved ? 'Saved' : 'Save'}
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* DECISION-FIRST ORDER: the most important question for a coordinator —
            "does this place actually do what I searched for, and is it cited?" —
            is shown first and given visual weight, then the supporting detail,
            then the action (contact) at the bottom. */}

        {/* 1 · per-need trust signal — the answer to "should I look here?" */}
        {trust && (
          <div className={`flex items-start gap-2 rounded-md px-3 py-2.5 text-sm ${trust.className}`}>
            {trust.level === 'cited' || trust.level === 'listed' || trust.level === 'offered' ? (
              <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
            ) : (
              <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
            )}
            <div className="min-w-0">
              <span>
                <span className="opacity-70">Your search for</span>{' '}
                <span className="font-semibold">“{needle.trim()}”</span>: {trust.qualifier}.
              </span>
              {trust.snippet && (
                <p className="mt-1 text-xs leading-snug text-foreground/80">
                  “{highlightMatch(trust.snippet, needle)}”
                </p>
              )}
              {missing.length > 0 && (
                <div className="mt-1.5 text-xs">
                  <span className="opacity-70">Missing: </span>
                  <span>{missing.join(' · ')}.</span>
                  <span className="mt-1 flex items-center gap-1 font-medium">
                    <AlertTriangle className="h-3 w-3 shrink-0" /> Verify before referring.
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 2 · uncertainty caveat — never present weak evidence as fact */}
        {caveat && (
          <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{caveat}</span>
          </div>
        )}

        {/* 3 · quick facts */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {clean(row.capacity) ? <span>Capacity: {clean(row.capacity)}</span> : null}
          {clean(row.numberDoctors) ? <span>Doctors: {clean(row.numberDoctors)}</span> : null}
          <span>{toScore(row.n_capabilities)} cited claims</span>
          <span>{sources.length} source link{sources.length === 1 ? '' : 's'}</span>
        </div>

        {/* 4 · specialties — the one matching the search is highlighted */}
        {specialties.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {specialties.map((s) => {
              const hit = matchesNeedle(s, needle);
              return (
                <span
                  key={s}
                  className={`rounded-md px-2 py-0.5 text-xs ${
                    hit
                      ? 'bg-yellow-200/70 text-foreground font-medium dark:bg-yellow-300/30'
                      : 'bg-muted text-foreground'
                  }`}
                >
                  {s}
                </span>
              );
            })}
          </div>
        )}

        {/* evidence — cited capability claims */}
        {evidence.length > 0 && (
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-xs font-medium text-foreground mb-1.5 flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Evidence (cited from source)
            </p>
            <ul className="space-y-1">
              {evidence.map((claim, i) => (
                <li key={i} className="text-xs text-muted-foreground leading-snug">
                  “{highlightMatch(claim, needle)}”
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 5 · sources */}
        {sources.length > 0 && (
          <div className="flex flex-wrap gap-3 pt-1">
            {sources.map((url, i) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary inline-flex items-center gap-1 underline underline-offset-2 hover:text-primary/80"
              >
                <ExternalLink className="h-3 w-3" /> Source {i + 1}
              </a>
            ))}
          </div>
        )}

        {/* 6 · contact actions — the final "act on it" step */}
        {(telHref || websiteUrl) && (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            {telHref && (
              <a
                href={telHref}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Phone className="h-3.5 w-3.5" /> Call{phone ? ` · ${phone}` : ''}
              </a>
            )}
            {websiteUrl && (
              <a
                href={websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/50 hover:text-primary"
              >
                <Globe className="h-3.5 w-3.5" /> Website
              </a>
            )}
          </div>
        )}

        {/* 7 · community feedback — the collaborative loop. Shared across users
            and kept visually distinct from the cited dataset evidence above. */}
        <CommunityFeedback row={row} reviews={reviews} />
      </CardContent>
    </Card>
  );
}

// Shared, cross-user feedback for a facility. This is the "close the loop"
// surface: a coordinator's thumbs-up/down + note is persisted in Lakebase and
// shown to everyone who searches this facility next. Deliberately framed as
// HUMAN feedback, separate from the dataset-derived evidence signals, so it
// adds collaboration without diluting the "everything is cited" story.
function CommunityFeedback({ row, reviews }: { row: FacilityRow; reviews: ReviewsApi }) {
  const summary = reviews.summaries[row.unique_id];
  const up = summary?.up ?? 0;
  const down = summary?.down ?? 0;
  const mine = summary?.my_rating ?? null;
  // "Notes" = votes that carry a comment + shortlist decisions (status/note).
  const notesCount = (summary?.commented ?? 0) + (summary?.decisions ?? 0);
  const hasAnything = up > 0 || down > 0 || notesCount > 0;

  const [comment, setComment] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [details, setDetails] = useState<ReviewDetail[] | null>(null);
  const [showComments, setShowComments] = useState(false);

  const meta = {
    facility_id: row.unique_id,
    facility_name: row.name ?? '',
    facility_city: clean(row.city) ?? '',
    facility_state: clean(row.state) ?? '',
  };

  async function refreshDetails() {
    setDetails(await reviews.loadDetail(row.unique_id));
  }

  async function vote(rating: 1 | -1) {
    // Clicking your current vote again (with no new note) retracts it.
    if (mine === rating && !comment.trim()) {
      await reviews.remove(row.unique_id);
    } else {
      await reviews.submit({ ...meta, rating, comment: comment.trim() });
    }
    setComment('');
    setNoteOpen(false);
    if (showComments) await refreshDetails();
  }

  async function toggleComments() {
    if (!showComments && details === null) await refreshDetails();
    setShowComments((v) => !v);
  }

  const voteBtn = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
      active ? 'border-primary/50 bg-primary/10 text-primary' : 'text-muted-foreground hover:border-primary/50 hover:text-primary'
    }`;

  return (
    <div className="border-t pt-3 space-y-2">
      <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
        <Users className="h-3.5 w-3.5 text-muted-foreground" /> Community feedback
        <span className="font-normal text-muted-foreground">· from coordinators who used this, not dataset evidence</span>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void vote(1)} aria-pressed={mine === 1} className={voteBtn(mine === 1)}>
          <ThumbsUp className="h-3.5 w-3.5" /> Helpful{up > 0 ? ` · ${up}` : ''}
        </button>
        <button type="button" onClick={() => void vote(-1)} aria-pressed={mine === -1} className={voteBtn(mine === -1)}>
          <ThumbsDown className="h-3.5 w-3.5" /> Not helpful{down > 0 ? ` · ${down}` : ''}
        </button>
        <button
          type="button"
          onClick={() => setNoteOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2 hover:text-primary/80"
        >
          <MessageSquare className="h-3.5 w-3.5" /> {noteOpen ? 'Hide note' : 'Add a note'}
        </button>
        {notesCount > 0 && (
          <button type="button" onClick={() => void toggleComments()} className="text-xs text-muted-foreground hover:text-foreground">
            {showComments ? 'Hide notes' : `Read notes (${notesCount})`}
          </button>
        )}
      </div>

      {noteOpen && (
        <div className="space-y-1">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            rows={2}
            placeholder="Optional: what should the next coordinator know? (submitted with your Helpful / Not helpful vote)"
            className="w-full rounded-md border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none"
          />
          <p className="text-[11px] text-muted-foreground">Pick Helpful or Not helpful above to post your note.</p>
        </div>
      )}

      {!hasAnything && !noteOpen && (
        <p className="text-xs text-muted-foreground">No feedback yet — be the first to help the next coordinator.</p>
      )}

      {showComments && details && (
        <ul className="space-y-2 pt-0.5">
          {details.length === 0 ? (
            <li className="text-xs text-muted-foreground">Votes recorded, but no written notes yet.</li>
          ) : (
            details.map((d, i) => {
              const who = d.is_mine ? 'You' : 'A coordinator';
              const when = formatDate(d.created_at);
              if (d.source === 'decision') {
                // A shortlist review: status badge + the service it was for + note.
                const sMeta = d.status ? statusMeta(d.status as ShortlistStatus) : null;
                return (
                  <li key={i} className="text-xs text-muted-foreground">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <ListFilter className="h-3 w-3 shrink-0 text-primary" />
                      <span className="font-medium text-foreground">{who}</span>
                      {sMeta && (
                        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${sMeta.className}`}>{sMeta.label}</span>
                      )}
                      {d.need?.trim() && <span>for “{d.need.trim()}”</span>}
                      {when && <span className="text-[11px]">· {when}</span>}
                    </span>
                    {d.comment.trim() && <span className="mt-0.5 block pl-[18px]">“{d.comment.trim()}”</span>}
                  </li>
                );
              }
              // A thumbs vote with a comment.
              return (
                <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  {d.rating === 1 ? (
                    <ThumbsUp className="h-3 w-3 mt-0.5 shrink-0 text-emerald-600" />
                  ) : (
                    <ThumbsDown className="h-3 w-3 mt-0.5 shrink-0 text-amber-600" />
                  )}
                  <span>
                    <span className="font-medium text-foreground">{who}</span>
                    {when && <span className="text-[11px]"> · {when}</span>}: “{d.comment}”
                  </span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
