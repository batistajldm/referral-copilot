# Referral Copilot — 3-minute Demo Script

**Track 3** · DAIS for Good 2026 · Live URL: https://referral-copilot-2878696955147552.aws.databricksapps.com
Dataset: `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities` (healthcare facilities in India)

> Mapped to the 4 judging dimensions: **[PJ]** Product judgment · **[EU]** Evidence & uncertainty · **[TE]** Technical execution · **[AM]** Ambition.
> Total budget ~3:00. Times are cumulative targets. Written in simple, easy-to-say English — read it out loud once before the demo.
> If you run long, cut the closing line, not the evidence beat.

---

## 0:00 — Hook & problem (20s) [PJ]
> "When a patient needs a certain kind of care — let's say **dialysis near Jaipur** — someone has to find a place that really offers it, close by, and then trust that to act on it. Today that means hours of phone calls. **Referral Copilot** turns a location and a care need into a short list you can trust, backed by evidence."

- Show the empty state: the persona line ("For care coordinators & patients…") and the three example chips.
- *Why it lands:* the judge's first contact is one click, not a blank form.

## 0:20 — Ask in plain English (25s) [PJ][AM]
> "I'll just ask in plain English."

- In **"Ask in plain English"**, type: `dialysis near Jaipur` → run.
- Point at the parsed fields (it switches to "Search by field": need = dialysis, city = Jaipur).
> "A model on Databricks read my question and split it into a **need** and a **place**. Here is the key point: **the model only reads the question. It never ranks, and it never makes up evidence.** Everything you see next comes straight from the data, with sources."

- *This is your Evidence & uncertainty insurance — say it clearly.*

## 0:45 — Near, on the map (25s) [AM][TE]
> "Track 3 is about *near*. We don't just match the city name."

- Point at the `~X km away` chips and a nearby town (e.g. Bagru ~15 km away). Then point at the **map on the right**.
> "We take the **middle point** of the results and rank by real distance, so we also show good options in nearby towns. On the map, each pin is **colored by how well it matches your search** — and there's a legend, so the colors are never a mystery. *(Straight-line distance today; road routing is on the roadmap.)*"

## 1:10 — The two evidence signals (35s) — THE CORE BEAT [EU]
> "Now the part that builds trust. Every card carries **two separate signals.**"

1. **Facility score** badge: `Facility: Strong · 12`.
   > "First: how well-documented the *place* is overall — claims, sources, location, capacity, doctors. Zero to twelve."
2. **Per-need** signal at the top of the card:
   > "Second, and more important: the evidence for **the exact thing you searched**. Here it's **cited** — a real claim with a source link. On another card you'll see **only mentioned in the description** — we flag it in amber and show the text, because that's weaker."

- Open **"How is confidence calculated?"** → show the formula and the "Two separate signals" note.
> "We never hide doubt. A place can be well-documented *and* still have weak evidence for your need — and we tell you both."

## 1:45 — We read every field (15s) [TE][EU]
> "We also read the **procedure and equipment** lists, not just the summary."

- Mention (or show a card where the match comes from procedure/equipment).
> "For dialysis alone, that brings in **hundreds of places** other tools would miss — because the proof was in those fields, not in the headline."

## 2:00 — Act on it, and share it (35s) [PJ][AM]
> "A short list is useless if you can't act."

- Click **Call · {phone}** (or the Website button). Save a facility to **My shortlist**, add a note, set status **Follow-up**.
> "I can call, save it, add a note, and set a status — and it even remembers **which service I searched for**."
- Scroll to **Community feedback** on the card (thumbs up / down + notes).
> "Here's the new part: **that decision is shared.** The next coordinator who looks at this place sees it — a thumbs up or down, and the notes other people left. So the tool gets **better the more people use it.** And we keep this human feedback **separate from the cited evidence**, so the data story stays clean."

## 2:35 — It sticks (10s) [TE]
- Reload the page → shortlist + note + status survive.
> "I reload — my short list, my note, and my status are all still here. That's **Lakebase Postgres** behind the app, and the service principal owns the schema."

## 2:45 — What's next & close (15s) [AM]
> "What's next: a live map with road distance, ranking by capacity, and sending a referral straight to the facility. The evidence backbone — **cited claims, never made up** — stays the same. **Referral Copilot:** ask in plain English, find what's really near, and trust it because every claim is cited. Thank you."

---

## One-liners to have in your pocket (for Q&A)
- **"Where does the evidence come from?"** → "All from the dataset. Claims, specialties, procedures, equipment, source links, location — all dataset columns. The model only reads the query."
- **"Why search procedure and equipment too?"** → "A place may not list 'dialysis' as a specialty but still do it — and say so in its procedure or equipment list. We read those, so we don't miss real options. For dialysis that's about 429 extra places."
- **"What if a place has no evidence?"** → "It scores low and the per-need signal says 'none'. We still show it, but we flag it — we don't hide it."
- **"Is the distance real?"** → "Yes — real distance computed in SQL. It's straight-line today; road routing is on the roadmap. We left out an outside routing service to keep the live demo simple and dependency-free."
- **"Why the middle point for the city?"** → "It's robust. A few wrong coordinates, or a same-named town in another state, can't drag the reference point off. The plain average was off by about 20 km in Mumbai."
- **"Is the community feedback part of the evidence score?"** → "No, on purpose. Votes and notes are human input, shown separately. The evidence score stays 100% from the dataset, so we never dress up an opinion as a cited fact."

## Demo data that's known-good (verified against the live warehouse)
- `dialysis near Jaipur` → returns real facilities with phone/website; SCR Hospital matches dialysis **only in the description** → a clean example of the amber "mentioned" signal.
- 94% of facilities have a phone, 83% have a website → contact buttons will populate.
- Community feedback may start empty → that's fine; leave one thumbs-up + a short note before the demo so the "shared" beat shows real data.
- Backup queries if Jaipur is slow: `cardiology near Mumbai`, `maternity in Rajasthan`.
