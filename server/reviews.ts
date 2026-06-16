// Lakebase persistence for COMMUNITY reviews — the collaborative feedback loop.
//
// This is deliberately different from `shortlist`: the shortlist is PRIVATE
// (scoped to user_id on every read), whereas a review is SHARED — anyone who
// searches a facility sees the aggregated thumbs-up / thumbs-down and the notes
// other coordinators left. That's what turns a search tool into a platform the
// community can improve over time.
//
// Integrity boundary: reviews are HUMAN feedback, kept entirely separate from
// the dataset-derived `evidence_score`. We never fold a vote into the evidence
// signal — the evidence story stays "cited from the dataset", and community
// feedback is shown as its own clearly-labelled signal.
import { z } from 'zod';

type AppKit = {
  lakebase: {
    query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
};

// ── Schema ────────────────────────────────────────────────────────────────
// rating is +1 (helpful / positive) or -1 (not helpful / negative). One review
// per (facility, user); re-submitting updates it (upsert).
export async function initReviewsSchema(appkit: AppKit): Promise<void> {
  await appkit.lakebase.query(`
    CREATE SCHEMA IF NOT EXISTS referral;
    CREATE TABLE IF NOT EXISTS referral.facility_review (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      facility_id     TEXT        NOT NULL,
      user_id         TEXT        NOT NULL,
      rating          SMALLINT    NOT NULL CHECK (rating IN (-1, 1)),
      comment         TEXT        NOT NULL DEFAULT '',
      facility_name   TEXT,
      facility_city   TEXT,
      facility_state  TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (facility_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS facility_review_facility_idx
      ON referral.facility_review (facility_id);
  `);
}

// ── Validation ──────────────────────────────────────────────────────────────

const submitSchema = z.object({
  facility_id: z.string().min(1),
  rating: z.union([z.literal(1), z.literal(-1)]),
  comment: z.string().max(2000).optional().default(''),
  facility_name: z.string().optional().default(''),
  facility_city: z.string().optional().default(''),
  facility_state: z.string().optional().default(''),
});

// ── Public read: aggregated summary for a batch of facilities ────────────────
// Batched by design: the results grid asks for every visible facility at once,
// so the card render never does N+1 round-trips.

export type ReviewSummary = {
  facility_id: string;
  up: number;
  down: number;
  total: number;
  /** Votes that carry a written comment (drives the "read notes" count). */
  commented: number;
  /** Coordinator decisions surfaced from the shortlist (status set and/or a
   *  note) — the second kind of shared feedback. */
  decisions: number;
  /** The signed-in user's own vote for this facility, if any. */
  my_rating: 1 | -1 | null;
};

function toInt(v: unknown): number {
  return typeof v === 'number' ? v : Number(v) || 0;
}

export async function summarizeReviews(
  appkit: AppKit,
  userId: string,
  facilityIds: string[],
): Promise<ReviewSummary[]> {
  const ids = facilityIds.filter((s) => typeof s === 'string' && s.length > 0);
  if (ids.length === 0) return [];

  // Aggregate vote counts across ALL users (the shared signal)…
  const { rows: agg } = await appkit.lakebase.query(
    `SELECT facility_id,
            COUNT(*) FILTER (WHERE rating = 1)   AS up,
            COUNT(*) FILTER (WHERE rating = -1)  AS down,
            COUNT(*)                             AS total,
            COUNT(*) FILTER (WHERE comment <> '') AS commented
       FROM referral.facility_review
      WHERE facility_id = ANY($1)
      GROUP BY facility_id`,
    [ids],
  );

  // …shortlist decisions across ALL users (status set, or a note left)…
  const { rows: dec } = await appkit.lakebase.query(
    `SELECT facility_id, COUNT(*) AS decisions
       FROM referral.shortlist
      WHERE facility_id = ANY($1) AND (status <> 'considering' OR note <> '')
      GROUP BY facility_id`,
    [ids],
  );
  const decMap = new Map<string, number>();
  for (const r of dec) decMap.set(String(r.facility_id), toInt(r.decisions));

  // …plus the caller's own vote, so the UI can show its toggle state.
  const { rows: mine } = await appkit.lakebase.query(
    `SELECT facility_id, rating
       FROM referral.facility_review
      WHERE user_id = $1 AND facility_id = ANY($2)`,
    [userId, ids],
  );
  const myMap = new Map<string, 1 | -1>();
  for (const r of mine) myMap.set(String(r.facility_id), toInt(r.rating) as 1 | -1);

  // Build a summary for every facility that has ANY shared activity — votes or
  // decisions — so a facility known only through a shortlist decision still
  // surfaces in the community section.
  const aggMap = new Map<string, Record<string, unknown>>();
  for (const r of agg) aggMap.set(String(r.facility_id), r);
  const activeIds = new Set<string>([...aggMap.keys(), ...decMap.keys()]);

  return [...activeIds].map((fid) => {
    const r = aggMap.get(fid);
    return {
      facility_id: fid,
      up: r ? toInt(r.up) : 0,
      down: r ? toInt(r.down) : 0,
      total: r ? toInt(r.total) : 0,
      commented: r ? toInt(r.commented) : 0,
      decisions: decMap.get(fid) ?? 0,
      my_rating: myMap.get(fid) ?? null,
    };
  });
}

// ── Public read: individual reviews (comments) for one facility ──────────────
// Privacy: we never expose who reviewed. Other users' reviews are anonymous;
// only the caller's own review is flagged `is_mine` so they can edit/remove it.

export async function listReviewsFor(appkit: AppKit, userId: string, facilityId: string) {
  // Two kinds of shared feedback, unified into one chronological list:
  //  • 'vote'     — a thumbs-up/down with a written comment.
  //  • 'decision' — a coordinator's shortlist decision (status and/or note),
  //                 tagged with the service they searched for.
  // Identities are never exposed; only the caller's own entries are flagged.
  const { rows } = await appkit.lakebase.query(
    `SELECT 'vote'      AS source,
            rating,
            NULL::text   AS status,
            NULL::text   AS need,
            comment,
            created_at,
            (user_id = $1) AS is_mine
       FROM referral.facility_review
      WHERE facility_id = $2 AND comment <> ''
     UNION ALL
     SELECT 'decision'   AS source,
            NULL::smallint AS rating,
            status,
            need,
            note         AS comment,
            created_at,
            (user_id = $1) AS is_mine
       FROM referral.shortlist
      WHERE facility_id = $2 AND (status <> 'considering' OR note <> '')
      ORDER BY is_mine DESC, created_at DESC
      LIMIT 50`,
    [userId, facilityId],
  );
  return rows.map((r) => ({
    source: r.source === 'decision' ? ('decision' as const) : ('vote' as const),
    rating: r.rating == null ? null : toInt(r.rating),
    status: r.status == null ? null : String(r.status),
    need: r.need == null ? null : String(r.need),
    comment: String(r.comment ?? ''),
    created_at: r.created_at,
    is_mine: Boolean(r.is_mine),
  }));
}

// ── Write: submit or update the caller's review ──────────────────────────────

export async function submitReview(appkit: AppKit, userId: string, body: unknown) {
  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) return { error: 'Invalid input' as const };
  const d = parsed.data;
  await appkit.lakebase.query(
    `INSERT INTO referral.facility_review
       (facility_id, user_id, rating, comment, facility_name, facility_city, facility_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (facility_id, user_id) DO UPDATE SET
       rating         = EXCLUDED.rating,
       comment        = EXCLUDED.comment,
       facility_name  = EXCLUDED.facility_name,
       facility_city  = EXCLUDED.facility_city,
       facility_state = EXCLUDED.facility_state,
       updated_at     = NOW()`,
    [d.facility_id, userId, d.rating, d.comment, d.facility_name, d.facility_city, d.facility_state],
  );
  // Return the fresh aggregate so the client can update in place.
  const [summary] = await summarizeReviews(appkit, userId, [d.facility_id]);
  return {
    row: summary ?? { facility_id: d.facility_id, up: 0, down: 0, total: 0, commented: 0, decisions: 0, my_rating: d.rating },
  };
}

export async function deleteReview(appkit: AppKit, userId: string, facilityId: string) {
  await appkit.lakebase.query(
    `DELETE FROM referral.facility_review WHERE user_id = $1 AND facility_id = $2`,
    [userId, facilityId],
  );
  const [summary] = await summarizeReviews(appkit, userId, [facilityId]);
  return summary ?? { facility_id: facilityId, up: 0, down: 0, total: 0, commented: 0, decisions: 0, my_rating: null };
}
