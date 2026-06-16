// Lakebase persistence for user actions: shortlisted facilities + notes.
// Uses a dedicated `referral` schema so the app's Service Principal owns it
// (the SP cannot use `public`). All table names are schema-qualified.
import { z } from 'zod';

// Minimal structural type for the Lakebase plugin handle we need. Avoids
// coupling to the full generic AppKit type (which depends on the plugin array).
type AppKit = {
  lakebase: {
    query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
};

// ── Schema ────────────────────────────────────────────────────────────────

// Allowed review decisions (overrides). Persisting these covers the core
// requirement to store "overrides" and "review decisions", not just notes.
export const STATUS_VALUES = ['considering', 'reviewed', 'rejected', 'follow_up'] as const;
export type ShortlistStatus = (typeof STATUS_VALUES)[number];

export async function initShortlistSchema(appkit: AppKit): Promise<void> {
  await appkit.lakebase.query(`
    CREATE SCHEMA IF NOT EXISTS referral;
    CREATE TABLE IF NOT EXISTS referral.shortlist (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id         TEXT        NOT NULL,
      facility_id     TEXT        NOT NULL,
      facility_name   TEXT,
      facility_city   TEXT,
      facility_state  TEXT,
      evidence_score  INTEGER,
      need            TEXT        NOT NULL DEFAULT '',
      note            TEXT        NOT NULL DEFAULT '',
      status          TEXT        NOT NULL DEFAULT 'considering',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, facility_id)
    );
    -- Idempotent migrations for tables created before these columns existed.
    ALTER TABLE referral.shortlist ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'considering';
    -- need records WHICH service the coordinator was searching when they saved
    -- the facility, so the shortlist (and the shared community view) shows the
    -- decision in context, not just saved-this-place.
    ALTER TABLE referral.shortlist ADD COLUMN IF NOT EXISTS need TEXT NOT NULL DEFAULT '';
  `);
}

// ── Validation ──────────────────────────────────────────────────────────────

const saveSchema = z.object({
  facility_id: z.string().min(1),
  facility_name: z.string().optional().default(''),
  facility_city: z.string().optional().default(''),
  facility_state: z.string().optional().default(''),
  evidence_score: z.number().int().optional().nullable(),
  need: z.string().max(200).optional().default(''),
  note: z.string().max(4000).optional().default(''),
});

// PATCH accepts a note, a status override, or both — but at least one.
const patchSchema = z
  .object({
    note: z.string().max(4000).optional(),
    status: z.enum(STATUS_VALUES).optional(),
  })
  .refine((d) => d.note !== undefined || d.status !== undefined, {
    message: 'Provide a note and/or a status',
  });

// ── User identity ─────────────────────────────────────────────────────────
// Deployed apps get the caller's email from the platform proxy header.
// Local dev falls back to a fixed test user.
export function userIdFrom(req: { header(name: string): string | undefined }): string {
  return req.header('x-forwarded-email') || 'local-dev@referral-copilot';
}

// ── Persistence helpers ─────────────────────────────────────────────────────

export async function listShortlist(appkit: AppKit, userId: string) {
  const { rows } = await appkit.lakebase.query(
    `SELECT facility_id, facility_name, facility_city, facility_state,
            evidence_score, need, note, status, created_at, updated_at
       FROM referral.shortlist
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

export async function saveToShortlist(appkit: AppKit, userId: string, body: unknown) {
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) return { error: 'Invalid input' as const };
  const d = parsed.data;
  // Upsert: re-saving a facility refreshes its metadata but preserves the note
  // unless a new note is provided.
  const { rows } = await appkit.lakebase.query(
    `INSERT INTO referral.shortlist
       (user_id, facility_id, facility_name, facility_city, facility_state, evidence_score, need, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, facility_id) DO UPDATE SET
       facility_name  = EXCLUDED.facility_name,
       facility_city  = EXCLUDED.facility_city,
       facility_state = EXCLUDED.facility_state,
       evidence_score = EXCLUDED.evidence_score,
       need           = CASE WHEN EXCLUDED.need <> '' THEN EXCLUDED.need ELSE referral.shortlist.need END,
       note           = CASE WHEN EXCLUDED.note <> '' THEN EXCLUDED.note ELSE referral.shortlist.note END,
       updated_at     = NOW()
     RETURNING facility_id, facility_name, facility_city, facility_state,
               evidence_score, need, note, status, created_at, updated_at`,
    [userId, d.facility_id, d.facility_name, d.facility_city, d.facility_state, d.evidence_score ?? null, d.need, d.note],
  );
  return { row: rows[0] };
}

export async function updateItem(appkit: AppKit, userId: string, facilityId: string, body: unknown) {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return { error: 'Invalid input' as const };

  // Build the SET clause from only the provided fields (note and/or status),
  // keeping every value parameterized.
  const params: unknown[] = [userId, facilityId];
  const sets: string[] = [];
  if (parsed.data.note !== undefined) {
    params.push(parsed.data.note);
    sets.push(`note = $${params.length}`);
  }
  if (parsed.data.status !== undefined) {
    params.push(parsed.data.status);
    sets.push(`status = $${params.length}`);
  }

  const { rows } = await appkit.lakebase.query(
    `UPDATE referral.shortlist SET ${sets.join(', ')}, updated_at = NOW()
      WHERE user_id = $1 AND facility_id = $2
      RETURNING facility_id, note, status, updated_at`,
    params,
  );
  if (rows.length === 0) return { error: 'Not found' as const };
  return { row: rows[0] };
}

export async function removeFromShortlist(appkit: AppKit, userId: string, facilityId: string) {
  await appkit.lakebase.query(
    `DELETE FROM referral.shortlist WHERE user_id = $1 AND facility_id = $2`,
    [userId, facilityId],
  );
}
