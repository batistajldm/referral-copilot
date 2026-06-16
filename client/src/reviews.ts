import { useCallback, useState } from 'react';

// Client state for COMMUNITY reviews — the shared feedback loop. Unlike the
// shortlist (private per user), these summaries reflect every user's votes, so
// what one coordinator learns becomes visible to the next one who searches.
// OLTP data → plain fetch, never useAnalyticsQuery.

export type ReviewRating = 1 | -1;

export type ReviewSummary = {
  facility_id: string;
  up: number;
  down: number;
  total: number;
  my_rating: ReviewRating | null;
};

export type ReviewDetail = {
  rating: number;
  comment: string;
  created_at: string;
  is_mine: boolean;
};

export type SubmitReviewInput = {
  facility_id: string;
  rating: ReviewRating;
  comment?: string;
  facility_name?: string;
  facility_city?: string;
  facility_state?: string;
};

export function useReviews() {
  // facility_id → aggregated summary. A Map kept in state so cards re-render
  // when their facility's counts change.
  const [summaries, setSummaries] = useState<Record<string, ReviewSummary>>({});

  const mergeSummaries = useCallback((rows: ReviewSummary[]) => {
    setSummaries((prev) => {
      const next = { ...prev };
      for (const r of rows) next[r.facility_id] = r;
      return next;
    });
  }, []);

  // Batch-load summaries for the currently visible results (avoids N+1).
  const loadSummaries = useCallback(
    async (facilityIds: string[]) => {
      const ids = facilityIds.filter(Boolean);
      if (ids.length === 0) return;
      try {
        const qs = ids.map((id) => encodeURIComponent(id)).join(',');
        const res = await fetch(`/api/reviews?facility_ids=${qs}`);
        if (res.ok) mergeSummaries((await res.json()) as ReviewSummary[]);
      } catch {
        // Lakebase cold/unavailable — fail soft; the community section hides.
      }
    },
    [mergeSummaries],
  );

  const submit = useCallback(
    async (input: SubmitReviewInput) => {
      try {
        const res = await fetch('/api/reviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (res.ok) mergeSummaries([(await res.json()) as ReviewSummary]);
      } catch {
        // fail soft
      }
    },
    [mergeSummaries],
  );

  const remove = useCallback(
    async (facilityId: string) => {
      try {
        const res = await fetch(`/api/reviews/${encodeURIComponent(facilityId)}`, { method: 'DELETE' });
        if (res.ok) mergeSummaries([(await res.json()) as ReviewSummary]);
      } catch {
        // fail soft
      }
    },
    [mergeSummaries],
  );

  // Lazy-load the individual comments for one facility (only when expanded).
  const loadDetail = useCallback(async (facilityId: string): Promise<ReviewDetail[]> => {
    try {
      const res = await fetch(`/api/reviews/${encodeURIComponent(facilityId)}`);
      if (res.ok) return (await res.json()) as ReviewDetail[];
    } catch {
      // fail soft
    }
    return [];
  }, []);

  return { summaries, loadSummaries, submit, remove, loadDetail };
}

export type ReviewsApi = ReturnType<typeof useReviews>;
