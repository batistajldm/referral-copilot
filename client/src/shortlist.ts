import { useCallback, useEffect, useMemo, useState } from 'react';

// Client-side state for the user's shortlist, persisted in Lakebase via the
// /api/shortlist routes. NOTE: this is OLTP data — use fetch, never
// useAnalyticsQuery (which targets the SQL warehouse).

export type ShortlistStatus = 'considering' | 'reviewed' | 'rejected' | 'follow_up';

export type ShortlistItem = {
  facility_id: string;
  facility_name: string | null;
  facility_city: string | null;
  facility_state: string | null;
  evidence_score: number | null;
  /** The service the coordinator searched when they saved this facility. */
  need: string;
  note: string;
  status: ShortlistStatus;
  created_at: string;
  updated_at: string;
};

export type SaveInput = {
  facility_id: string;
  facility_name?: string;
  facility_city?: string;
  facility_state?: string;
  evidence_score?: number | null;
  need?: string;
};

function upsert(items: ShortlistItem[], row: ShortlistItem): ShortlistItem[] {
  const exists = items.some((i) => i.facility_id === row.facility_id);
  return exists ? items.map((i) => (i.facility_id === row.facility_id ? row : i)) : [row, ...items];
}

export function useShortlist() {
  const [items, setItems] = useState<ShortlistItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/shortlist');
      if (res.ok) setItems((await res.json()) as ShortlistItem[]);
    } catch {
      // Lakebase may be cold/unavailable in local dev — fail soft.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const savedIds = useMemo(() => new Set(items.map((i) => i.facility_id)), [items]);

  const save = useCallback(async (input: SaveInput) => {
    const res = await fetch('/api/shortlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (res.ok) {
      const row = (await res.json()) as ShortlistItem;
      setItems((prev) => upsert(prev, row));
    }
  }, []);

  const remove = useCallback(async (facilityId: string) => {
    const res = await fetch(`/api/shortlist/${encodeURIComponent(facilityId)}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setItems((prev) => prev.filter((i) => i.facility_id !== facilityId));
    }
  }, []);

  const setNote = useCallback(async (facilityId: string, note: string) => {
    const res = await fetch(`/api/shortlist/${encodeURIComponent(facilityId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    if (res.ok) {
      const row = (await res.json()) as { facility_id: string; note: string; updated_at: string };
      setItems((prev) =>
        prev.map((i) => (i.facility_id === facilityId ? { ...i, note: row.note, updated_at: row.updated_at } : i)),
      );
    }
  }, []);

  // Persist a review decision (override) for a saved facility.
  const setStatus = useCallback(async (facilityId: string, status: ShortlistStatus) => {
    const res = await fetch(`/api/shortlist/${encodeURIComponent(facilityId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      const row = (await res.json()) as { facility_id: string; status: ShortlistStatus; updated_at: string };
      setItems((prev) =>
        prev.map((i) => (i.facility_id === facilityId ? { ...i, status: row.status, updated_at: row.updated_at } : i)),
      );
    }
  }, []);

  return { items, savedIds, loading, save, remove, setNote, setStatus };
}

export type ShortlistApi = ReturnType<typeof useShortlist>;
