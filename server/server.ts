import { createApp, analytics, lakebase, serving, server } from '@databricks/appkit';
import {
  initShortlistSchema,
  userIdFrom,
  listShortlist,
  saveToShortlist,
  updateItem,
  removeFromShortlist,
} from './shortlist';
import {
  initReviewsSchema,
  summarizeReviews,
  listReviewsFor,
  submitReview,
  deleteReview,
} from './reviews';
import { parseQuery, nlParseEnabled } from './parse';

// Lakebase is only configured when the platform injects its connection env
// (i.e. when deployed with the `postgres` app resource). Locally — without a
// server/.env — we run analytics-only so dev and smoke tests still work; the
// shortlist UI degrades gracefully (its fetches fail soft).
const lakebaseEnabled = Boolean(process.env.LAKEBASE_ENDPOINT);

// Natural-language parsing uses a Foundation Model serving endpoint (the
// `serving-default` app resource). The plugin is always loaded — it only errors
// when invoked without DATABRICKS_SERVING_ENDPOINT_NAME, which the route guards.
// (Literal arrays per branch so createApp can infer the plugin map type.)
createApp({
  plugins: lakebaseEnabled
    ? [analytics(), lakebase(), serving(), server()]
    : [analytics(), serving(), server()],
  async onPluginsReady(appkit) {
    if (!nlParseEnabled()) {
      console.warn(
        '[referral-copilot] DATABRICKS_SERVING_ENDPOINT_NAME not set — natural-language search disabled (structured form still works).',
      );
    }

    // Natural-language query parsing: free text → { need, city, state }.
    // Available whenever the serving endpoint is configured, independent of
    // Lakebase, so it works even in analytics-only mode.
    appkit.server.extend((app) => {
      app.post('/api/parse-query', async (req, res) => {
        if (!nlParseEnabled()) {
          res.status(503).json({ error: 'Natural-language search is not configured.' });
          return;
        }
        const q = typeof req.body?.q === 'string' ? req.body.q.trim() : '';
        if (!q) {
          res.status(400).json({ error: 'Missing query text.' });
          return;
        }
        try {
          const parsed = await parseQuery(appkit, q);
          res.json(parsed);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Parse failed';
          res.status(502).json({ error: message });
        }
      });
    });

    if (!lakebaseEnabled) {
      console.warn('[referral-copilot] LAKEBASE_ENDPOINT not set — shortlist persistence disabled (analytics only).');
      return;
    }

    // Create the SP-owned schema + tables before the server accepts requests.
    await initShortlistSchema(appkit);
    await initReviewsSchema(appkit);

    appkit.server.extend((app) => {
      // List the current user's shortlist (saved facilities + notes).
      app.get('/api/shortlist', async (req, res) => {
        const rows = await listShortlist(appkit, userIdFrom(req));
        res.json(rows);
      });

      // Add (or refresh) a facility in the shortlist.
      app.post('/api/shortlist', async (req, res) => {
        const result = await saveToShortlist(appkit, userIdFrom(req), req.body);
        if ('error' in result) {
          res.status(400).json({ error: result.error });
          return;
        }
        res.status(201).json(result.row);
      });

      // Update the note and/or the review decision (status) of a saved facility.
      app.patch('/api/shortlist/:facilityId', async (req, res) => {
        const result = await updateItem(appkit, userIdFrom(req), req.params.facilityId, req.body);
        if ('error' in result) {
          res.status(result.error === 'Not found' ? 404 : 400).json({ error: result.error });
          return;
        }
        res.json(result.row);
      });

      // Remove a facility from the shortlist.
      app.delete('/api/shortlist/:facilityId', async (req, res) => {
        await removeFromShortlist(appkit, userIdFrom(req), req.params.facilityId);
        res.status(204).send();
      });

      // ── Community reviews (SHARED across users) ──────────────────────────
      // Aggregated summary for a batch of facilities (the visible results set).
      // GET /api/reviews?facility_ids=a,b,c
      app.get('/api/reviews', async (req, res) => {
        const raw = typeof req.query.facility_ids === 'string' ? req.query.facility_ids : '';
        const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
        const rows = await summarizeReviews(appkit, userIdFrom(req), ids);
        res.json(rows);
      });

      // Individual reviews (anonymised comments) for one facility.
      app.get('/api/reviews/:facilityId', async (req, res) => {
        const rows = await listReviewsFor(appkit, userIdFrom(req), req.params.facilityId);
        res.json(rows);
      });

      // Submit (or update) the caller's own review.
      app.post('/api/reviews', async (req, res) => {
        const result = await submitReview(appkit, userIdFrom(req), req.body);
        if ('error' in result) {
          res.status(400).json({ error: result.error });
          return;
        }
        res.status(201).json(result.row);
      });

      // Remove the caller's own review.
      app.delete('/api/reviews/:facilityId', async (req, res) => {
        const summary = await deleteReview(appkit, userIdFrom(req), req.params.facilityId);
        res.json(summary);
      });
    });
  },
}).catch(console.error);
