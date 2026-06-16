# Referral Copilot — 3-minute Demo Script

**Track 3** · DAIS for Good 2026 · Live URL: https://referral-copilot-2878696955147552.aws.databricksapps.com
Dataset: `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities` (healthcare facilities in India)

> Mapped to the 4 judging dimensions: **[PJ]** Product judgment · **[EU]** Evidence & uncertainty · **[TE]** Technical execution · **[AM]** Ambition.
> Total budget ~3:00. Times are cumulative targets. Stay disciplined — if you run long, cut the closing line, not the evidence beat.

---

## 0:00 — Hook & problem (20s) [PJ]
> "When a patient needs a specific kind of care — say **dialysis near Jaipur** — a care coordinator has to find a facility that *actually* provides it, nearby, and then trust that information enough to act. Today that's hours of phone calls and guesswork. **Referral Copilot** turns location + care need into an evidence-backed shortlist they can act on."

- Show the empty state: persona subtitle ("For care coordinators & patients…") + the three example chips.
- *Why it lands:* judge's first contact is one click, not a blank form.

## 0:20 — Natural-language search (30s) [PJ][AM]
> "I'll just ask in plain English."

- In **"Ask in plain English"**, type: `dialysis near Jaipur` → run.
- Point at the parsed fields appearing (it switches to "Search by field" to show need=dialysis / city=Jaipur).
> "A Foundation Model on Databricks Model Serving parsed that. **Crucial point: the LLM only parses the question into need + place. It never ranks and never invents evidence** — everything you're about to see comes straight from the dataset, cited and traceable."

- *This single sentence is your Evidence & uncertainty insurance — say it verbatim.*

## 0:50 — Proximity ranking (25s) [AM][TE]
> "Track 3 is about *near*. We don't just filter to the city name."

- Point at the `~X km away` chips; show a neighbouring town (e.g. Bagru ~15 km) surfacing.
> "We derive the city's centroid from the dataset's own coordinates — using the **median** of lat/lon so a few mis-geocoded rows can't drag the reference point — and rank by real great-circle distance. That surfaces good options in neighbouring towns, not just exact-name matches. *(Straight-line distance today; real road routing is on the roadmap.)*"

## 1:15 — The two evidence signals (40s) — THE CORE BEAT [EU]
> "Now the part that matters for trust. Every card carries **two independent signals.**"

1. **Facility-level** badge: `Facility: Strong · 12`.
   > "This is how well-documented the *facility* is overall — capability claims, sources, coordinates, capacity, doctors. Zero to twelve."
2. **Per-need** trust signal at the top of the card:
   > "And this is the evidence for *the thing you searched for*. Here it's **cited** — a capability claim with a source URL. On another card you'll see **only mentioned in free-text description** — flagged amber, with the snippet shown, because that's weaker evidence."

- Open **"How is confidence calculated?"** → show the formula + the "Two separate signals" note.
> "We never hide uncertainty. A facility can be well-documented *and* have weak evidence for your specific need — and we tell you both."

- *Optional, if you have a clean example:* filter with **"Only real matches"** to drop description-only hits.

## 1:55 — Act on it (25s) [PJ]
> "A shortlist is useless if you can't act."

- Click **Call · {phone}** (or show the Website button).
- Save a facility to **My shortlist**, add a note, set status **Follow-up**.
> "Notes, status overrides, review decisions — all persisted in Lakebase, scoped to the user."

## 2:20 — Persistence proof (15s) [TE]
- Reload the page → shortlist + note + status survive.
> "That's Lakebase Postgres behind the app — a low-latency transactional store, and the service principal owns the schema."

## 2:35 — Ambition / what's next (15s) [AM]
> "What's next: a live map with road-distance routing, capacity-aware ranking, and a referral hand-off that emails the facility. The evidence spine — cited claims, never fabricated — stays the same."

## 2:50 — Close (10s)
> "Referral Copilot: ask in plain English, find what's *actually* nearby, and trust it because every claim is cited. Thank you."

---

## One-liners to have in your pocket (for Q&A)
- **"Where does the evidence come from?"** → "100% from the Virtue Foundation dataset. Capability claims, specialties, source URLs, coordinates — all dataset columns. The LLM only parses the query string."
- **"How do you handle a facility with no evidence?"** → "It scores low (Insufficient tier) and the per-need signal says 'none' — we surface it but flag it, we don't hide it."
- **"Is the distance real?"** → "Great-circle (straight-line) today, computed in SQL with haversine. Road routing is roadmap — we deliberately didn't add an external routing API to keep the live demo dependency-free."
- **"Why median for the centroid?"** → "Robust to mis-geocoded rows and same-named places in other states; mean was off by ~20 km in Mumbai."

## Demo data that's known-good (verified against the live warehouse)
- `dialysis near Jaipur` → returns real facilities with phone/website; SCR Hospital matches dialysis **only in description** → great example of the amber "mentioned" signal.
- 94% of facilities have a phone, 83% have a website → contact buttons will populate.
- Backup queries if Jaipur is slow: `cardiology near Mumbai`, `maternity in Rajasthan`.
