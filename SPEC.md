# SPEC: Panorama Localisation Agent (Albatroz Challenge, JunctionX Lisbon 2026)

Source brief: `Albatroz Challenge - JunctionX Lisbon 2026.pdf`. Rule numbers (R1–R12) refer to the scoring rules on page 2 of the brief.

## 1. Goal

Build an AI agent that takes a 360° panorama and returns up to 10 `(lat, lng)` pairs sorted by decreasing likelihood, ideally with no human help. The operator may assist only through the penalised channels the rules allow. Every interaction with the agent is recorded as JSON.

**Deadlines**

| When | What |
|---|---|
| Sat 10 Oct, afternoon | Free training on set 1 (10 panoramas, no ground truth) |
| Sat 10 Oct, 19:00–21:00 | Optional trial run on set 2 (10 panoramas); we treat it as mandatory |
| Sun 11 Oct, 10:00–13:00 | Scoring run: 5 panoramas + the "Special One" (x3), 60 minutes of solving time |
| Sun 11 Oct, after | One panorama solved live during the presentation; the challenge winner solves another against other challenge winners |

## 2. Inputs and outputs

**Input per panorama**
- Equirectangular JPG, 6080 x 3040 px, daylight, camera at most 5 m above ground, unedited.
- Capture timestamp `YYYYMMDDhhmmss` (time zone not stated, see Q5).
- Label `Urban` or `non-Urban`, which selects the distance function.
- Geographic scope: mainly Portugal, also Spain and France. Some panoramas are in open fields away from roads; street names are rarely visible.

**Output per panorama**
- A ranked list of exactly 10 entries, each one `(lat, lng)` in decimal WGS84 with 6 decimals. Duplicates are allowed (the brief says the agent "can repeat one location along the list to improve its score").
- One JSON log file of all interactions (section 9).

## 3. Scoring model

Implement this exactly in `scoring.py`; the allocator and the evaluation harness both depend on it.

```
S_panorama = M * SUM_{r=1..N} 1000 * 0.95^(r-1) * theta(d_r) * P_r        N <= 10

d_r      = haversine(entry_r, truth) in metres, R = 6371008.8 m; d_r < 10  =>  d_r := 0
theta_U  = 2 / (1 + d/100)          (Urban)
theta_NU = 2 / (1 + d/10000)        (non-Urban)
P_r      = 0.8^cues * 0.95^mcqs * 0.5^human_geocodes   (those that happened before entry r)
M        = 3 for the Special One, else 1
Team     = SUM over panoramas; tie -> shortest time
```

| Distance | theta_U | theta_NU |
|---|---|---|
| < 10 m | 2.000 | 2.000 |
| 50 m | 1.333 | 1.990 |
| 100 m | 1.000 | 1.980 |
| 500 m | 0.333 | 1.905 |
| 1 km | 0.182 | 1.818 |
| 10 km | 0.020 | 1.000 |
| 50 km | 0.004 | 0.333 |
| 100 km | 0.002 | 0.182 |

- Rank weights sum to 8.025, so the maximum is 16,050 per panorama and 48,150 for the Special One. The Special One is 3 of the 8 scoring units (37.5%).
- Scores are never negative: a wrong entry costs nothing, an empty slot forfeits 8–12% of the panorama.

### 3.1 Strategy that follows from the math

1. **Always submit 10 entries.** One entry earns 12.5% of what ten copies of it earn.
2. **Default list: the single best point repeated 10 times.** Expected score is linear in the entries, so every rank is maximised by the same point, the one with the highest expected theta. Splitting slots across hypotheses only reduces variance and always lowers the expectation.
3. **Never pin the midpoint of two distinct hypotheses.** Theta is convex in distance, so the more probable endpoint always beats the midpoint. Merge into a centroid only for tight clusters: candidates within about 30 m (Urban) or 3 km (non-Urban).
4. **Urban is a street-matching problem; non-Urban is a region-finding problem.** Urban at 1 km keeps 9% of the points; non-Urban at 1 km keeps 91%. Precision effort goes to Urban panoramas and the Special One. Non-Urban refinement stops at about 2 km estimated error.
5. **Pin the camera position.** For Urban, put the pin on the road or footpath where the camera stood, not on a landmark's centroid (60 m off costs 37%). For non-Urban, pin the matching countryside, not the nearest town centre.
6. **The agent geocodes its own place names.** A human turning a place name into coordinates costs x0.5 (R8), which pays only if the agent's own point is more than 100 m off (Urban) and the human can pin within 10 m.
7. **Multiple-choice questions are cheap; cues are expensive.**

| Action | Factor | Pays only if expected theta rises by more than |
|---|---|---|
| 1 MCQ | 0.95 | 5.3% |
| 3 MCQs | 0.857 | 16.6% |
| 1 human cue | 0.8 | 25% |
| Human geocode | 0.5 | 100% |

8. **Ask before listing, or do not ask.** Committing some ranks before a question and the rest after is never optimal in expectation, so the agent decides once (ask or not) and then emits one list. We also assume the conservative reading of R9: any interaction penalises the whole list (Q2).
9. **Teach the agent beforehand.** Anything a human would say as a cue belongs in the system prompt before the run, where it is free.

## 4. Rule compliance (hard constraints)

| Rule | Constraint | How the system enforces it |
|---|---|---|
| R1 | At most 10 entries, one `(lat,lng)` each | `allocate()` emits exactly 10; validated before export |
| R6 | Cues at most 1000 characters, no direct or indirect reference to locations or sites, x0.8 each | Server-side length cap, location-reference lint, confirm dialog showing the new multiplier |
| R7 | MCQs have at most 4 options and are generated by the agent, never suggested by the team, x0.95 each | Buttons render only from the agent's `ask_multiple_choice` call; no free-text field on that path |
| R8 | Human-chosen coordinate for an agent-named area, x0.5 | Separate "last resort" control, only enabled when the agent has named a place |
| R9 | Penalties apply to subsequent candidates for that panorama | Penalty ledger per panorama; multiplier stamped on every entry |
| Brief p.2 | Humans may feed only text and multiple-choice clicks into the agent | The UI has exactly three input controls (section 8); the panorama, label and timestamp are loaded from the organisers' files, never typed |
| Brief p.1 | All interactions recorded in JSON | Append-only event log, one export per panorama (section 9) |

Humans may use any other tools on other equipment (brief p.2), for example a second laptop with street-level imagery to judge whether a proposed location is plausible. What they learn there may reach the agent only as an MCQ click or a compliant cue.

## 5. System overview

```
panorama.jpg + label + timestamp
        |
   pano.py  ->  overview + perspective views
        |
   agent loop (Claude, tools)  <->  tools: view_crop, sun_position, search_places,
        |                                  overpass_query, streetview_lookup,
        |                                  satellite_tile, web_search
        |  update_candidates (hypotheses with probabilities)
        v
   allocate.py  ->  10 ranked (lat,lng)  ->  export JSON
        ^
   operator UI: MCQ buttons | cue box | last-resort geocode   (all penalised, all logged)
```

The model proposes weighted hypotheses; code builds the final list. The model never hand-ranks the 10 slots.

**Stack:** Python 3.11+, `anthropic` (async), `pydantic`, `opencv-python`, `numpy`, `Pillow`, `httpx`, `pvlib` or `astral`, FastAPI with server-sent events and one static HTML page (Leaflet map), `typer` CLI.

```
geoagent/
  config.py        # model, effort, budgets, keys, feature flags
  pano.py          # equirect -> rectilinear, overview with yaw ruler, initial view set
  prompts.py       # frozen system prompt: cue playbook, scoring economics
  tools/           # schemas.py, view_crop.py, sun.py, places.py, overpass.py, streetview.py, satellite.py
  loop.py          # async agent loop, deadlines, MCQ and cue queues
  penalties.py     # penalty ledger
  allocate.py      # hypotheses -> 10 ranked entries
  scoring.py       # haversine, theta, score_list, expected_value
  eventlog.py      # JSONL writer and per-panorama export
  runner.py        # parallel orchestration, watchdog, fallback answer
server/app.py  server/static/index.html
cli.py             # run <pano> | batch <dir> | export | eval
eval/              # build_set.py, run_eval.py, data/
runs/              # logs and exports (gitignored)
tests/             # test_scoring.py, test_penalties.py, test_allocate.py
```

## 6. Agent design

### 6.1 Model and request settings

- Model `claude-opus-5-5`, effort `high` (`xhigh` for the Special One), adaptive thinking with summarised display so the reasoning lands in the log.
- A hand-written async Messages API loop (about 100 lines), not the Agent SDK: we need full logging of each request, deadline pre-emption, and the ability to pause for an MCQ click.
- Conversation history is append-only; the system prompt and tool list are byte-stable (no timestamps) so prompt caching works.
- Tool choice cannot be forced on this model, so the harness never depends on the model calling `submit_locations` (section 6.5).
- Handle `tool_use`, `end_turn`, `pause_turn`, `max_tokens` and `refusal` stop reasons. The system prompt states that this is an organiser-sanctioned geolocation competition on organiser-supplied images.

### 6.2 Panorama pre-processing

A 6080 x 3040 image sent whole is downscaled to about 7 px/degree (native is 16.9), which makes signs unreadable. Every image sent to the model is capped at 2000 px per side, because requests with more than 20 images enforce that limit.

Initial view set, each preceded by a text label:
1. Equirectangular overview at 2000 x 1000 with a yaw ruler along the top edge.
2. Eight rectilinear views at 45° yaw steps, 90° FOV, pitch 0, about 1456 px.
3. One upward view (sky, sun, wires, pole tops) and one downward view (road surface, markings) at 1024 px.

Everything else is on demand through `view_crop`. Crops narrower than about 30° FOV exceed native resolution; upscale 2x with Lanczos for legibility.

### 6.3 Tools

All client tools use strict schemas; option counts, coordinate ranges and the 10-entry cap are validated in code.

| Tool | Purpose | Backend | Priority |
|---|---|---|---|
| `view_crop(yaw, pitch, fov, enhance)` | Zoom on signs, plates, shopfronts, distant landmarks | Local, `cv2.remap` | Must |
| `update_candidates(hypotheses[])` | Record `{lat, lng, probability, radius_m, label, evidence}`; free; the harness keeps the latest as best-so-far | Local | Must |
| `submit_locations(hypotheses[], reasoning_summary)` | Final hypotheses; the harness builds the list | Local | Must |
| `search_places(query, countrycodes, viewbox)` | Geocode names read off signs and the agent's own place names | Nominatim, then Photon; Google Geocoding/Places if a key exists | Must |
| `web_search` / `web_fetch` | Look up business names, phone numbers, landmarks | Claude server tools | Must |
| `ask_multiple_choice(question, options[2..4], why_it_matters)` | One question to the operator; costs x0.95 | Operator UI | Must |
| `streetview_lookup(lat, lng, radius_m, headings[])` | Street-level views plus the pano's exact coordinate and date, for visual comparison | Google Street View Static API (metadata calls are free); Mapillary as second source | Should |
| `satellite_tile(lat, lng, zoom)` | Aerial image, north up, with scale bar: road layout, roofs, field patterns, coastline | Esri World Imagery export; national orthophotos as alternates | Should |
| `overpass_query(ql)` | Find feature combinations in OSM, e.g. church within 200 m of a roundabout; wind turbines, masts, reservoirs | Overpass API with retry, backoff and a mirror | Should |
| `sun_position(sun_yaw, sun_pitch, candidates[])` | Compass offset of the panorama and sun-elevation mismatch per candidate | Local, `pvlib` | Should |

Tool implementation requirements:
- Every external call has a timeout, returns `is_error` instead of raising, and is cached to disk keyed by request. Shared hackathon Wi-Fi will hit Nominatim (1 request/s) and Overpass (429 and 504 were seen today) from every team at once.
- A global semaphore of 2 on Nominatim and Overpass; a custom User-Agent on OSM services.
- `streetview_lookup` calls metadata first and returns the snapped pano coordinate. When a match is found, the answer is that pano's own coordinate.
- Scope Overpass queries to a district (`ISO3166-2`) or a bounding box; country-wide regex queries are too slow.

### 6.4 Reasoning procedure (system prompt)

The prompt instructs the agent to work coarse to fine:

1. **Survey.** Look at all initial views; list evidence before naming any place: language and text, road markings and signs, bollards, poles, plates, architecture, paving, vegetation and land use, terrain, coast, season.
2. **Hypothesise.** Give country, region and municipality hypotheses with probabilities, and state what observation would discriminate the top ones. Call `update_candidates` within the first two turns.
3. **Read text.** Zoom on anything legible (shop names, phone prefixes, postcodes, road numbers, plates) and resolve it with `search_places` and `web_search`.
4. **Orient.** Locate the sun, call `sun_position` to get the compass heading, and restate observations in compass terms ("sea to the west").
5. **Generate candidates.** Geocoded text, or OSM feature combinations through `overpass_query`.
6. **Verify.**
   - Urban: compare orientation-matched street-level views, step along the street, and stop when a pano matches or the deadline arrives.
   - Non-Urban: check field patterns, tracks and distant features on satellite imagery; stop at about 2 km estimated error.
7. **Decide on a question.** Ask an MCQ only if the gate in section 7.2 passes.
8. **Submit** hypotheses with probabilities and uncertainty radii.

The prompt also carries:
- **A regional cue playbook** for Portugal, Spain and France (and the islands: Azores, Madeira, Canaries, Balearics, Corsica): sign languages and place-name vocabulary, postcode and phone-prefix formats, road-numbering schemes, bollards and poles, brands and street furniture, architecture by region, vegetation and land-use zones, coast types. Draft it from Plonk It, geotips.net and geometas, and have a team member check it against those pages before freezing the prompt; most of the draft list is from memory.
- **The scoring economics** from section 3, so the agent knows what a question costs and that precision matters for Urban only.
- **A warning** that confident wrong answers are the dominant failure mode, and that street names are rare here.

### 6.5 Guaranteed answer

- The harness persists a provisional 10-entry list on every `update_candidates`.
- On soft deadline, the loop appends a "commit now" notice after the tool results. On hard deadline, crash or refusal, the harness submits the latest provisional list.
- If no hypothesis exists at all, it submits a label-specific prior point (configurable; default central mainland Portugal).

## 7. Answer construction

### 7.1 Allocator (`allocate.py`)

```
inputs: hypotheses x_i with probability p_i; label; HEDGE in {off, on}
s   = 100 (Urban) or 10000 (non-Urban)
v_i = SUM_j p_j * theta(d(x_i, x_j), s)
add centroids of tight clusters (< 30 m Urban, < 3 km non-Urban) as extra candidates; recompute v
sort by v descending; rho = v_2 / v_1

HEDGE off (default):   10 x x_1
HEDGE on:
   rho < 0.67          10 x x_1
   0.67 <= rho < 0.9   8 x x_1, then 2 x x_2
   rho >= 0.9          6 x x_1, then 4 x x_2
always: descending v, exactly 10 entries, 6 decimals
```

Config flag `ALLOW_DUPLICATES=true`. If the organisers reject duplicates (Q3), the fallback is the top 10 distinct points by `v`.

### 7.2 Question gate

The agent may call `ask_multiple_choice` only when all of these hold:
- The top hypotheses are far apart relative to the scale `s` and `0.95 * a * (p_1 + ... + p_k) > p_1`, with answer accuracy `a = 0.9` and `k <= 4` options. In practice: the posterior is truly multi-modal.
- The question is one a human can answer better than the agent, typically "which of these candidates matches?" with each option described by visual features the operator can check on other equipment. Questions about what is visible in the panorama are pointless; the agent already sees it.
- Fewer than 3 MCQs have been asked for this panorama (`MAX_MCQ=3`).

The harness enforces the count and the operator toggle "MCQ allowed"; when disabled, the tool returns an error at no penalty.

## 8. Operator UI

One page per run, with a tile per panorama showing: the panorama, current hypotheses on a map, the provisional list, the live multiplier, time used, and the agent's reasoning stream. The Special One is flagged.

Exactly three input controls, each owned by the backend penalty ledger:

1. **MCQ buttons.** Appear only from an agent `ask_multiple_choice` call, 2–4 buttons, no text field. x0.95 is applied when the question is asked. After 90 s without a click the tool returns "no answer; proceed".
2. **Cue box.** Hidden behind a toggle by default. 1000-character hard limit enforced on the server, lint for coordinates and place names (gazetteer of PT/ES/FR toponyms), confirm dialog showing the multiplier before and after. Send button labelled "Send cue (x0.8)".
3. **Last-resort geocode.** Enabled only when the agent has named a place. Operator clicks the map; x0.5 applies. Behind a confirm dialog.

A fully autonomous mode (`--no-human`) disables all three.

## 9. JSON interaction log

The brief requires JSON but gives no schema (Q4). We write append-only JSONL per panorama at `runs/<run_id>/<panorama_id>.events.jsonl`, flushed per event, and export one JSON file per panorama.

Event envelope:

```json
{"schema_version": "1.0", "seq": 17, "ts": "2026-10-11T10:04:31.512Z", "t_rel_s": 271.5,
 "run_id": "...", "panorama_id": "...", "actor": "agent|human|harness|tool", "type": "...",
 "penalty_state": {"cues": 0, "mcqs": 1, "human_geocodes": 0, "multiplier": 0.95},
 "data": {}}
```

| Type | Data |
|---|---|
| `run_start` | panorama filename and sha256, label, capture timestamp, model, effort, system prompt text, tool definitions, git SHA |
| `model_request` / `model_response` | messages appended this turn (images as `{sha256, path, yaw, pitch, fov}`), full response content including thinking summaries, stop reason, token usage, latency |
| `tool_call` / `tool_result` | tool name, input, output, error flag, duration, external URL called |
| `mcq_asked` / `mcq_answered` | question, options, selected index, multiplier before and after |
| `human_cue` | text, character count, lint verdict, multiplier before and after |
| `human_geocode` | agent's place label, chosen lat/lng, multiplier before and after |
| `candidates_update` | hypotheses and the derived provisional list |
| `final_submission` | 10 ranked entries with per-entry multiplier and origin (`agent`, `harness_fallback`, `human_geocode`), allocator settings |
| `run_end` | totals: tokens, cost, wall time, turns |

Export file: `{schema_version, team, panorama, config, events, final: {locations, penalty_state}, totals}`. Images are referenced by hash and path, with an option to embed base64.

**Action:** post a sample export to the Discord channel before 19:00 to have the format confirmed.

## 10. Run orchestration

- All 6 panoramas start in parallel at t = 0 (`asyncio.gather`); human attention, not machine time, is the constraint.
- `cli.py batch <dir> --concurrency 6 --no-human` runs the training and trial sets and writes one export per panorama plus `summary.csv`.

| Budget | Standard | Special One |
|---|---|---|
| Effort | `high` | `xhigh` |
| Soft deadline ("commit now") | 10 min | 15 min |
| Hard deadline (use best-so-far) | 14 min | 20 min |
| Max turns | 30 | 45 |
| Max spend | $8 | $15 |

Scoring-run timeline (60 minutes):

| Wall clock | Phase |
|---|---|
| 0–2 min | Load 6 images and labels, flag the Special One, launch |
| 2–12 min | Autonomous pass; a valid 10-entry answer and log exist for every panorama |
| 12–26 min | Operator review of the Special One: plausibility check on other equipment, MCQs if the gate fires |
| 26–52 min | Review of the other 5, Urban first; non-Urban gets 3–4 min once the region looks right |
| 52–55 min | Freeze: validate JSON, 10 entries each, penalty ledger |
| 55–60 min | Buffer for submission |

A global watchdog at T+50 min finalises everything. The tie-break on time is nearly irrelevant because scores are continuous; do not trade score for speed.

**Live on-stage panorama:** same pipeline, autonomous mode, 3–4 minute hard deadline.

## 11. Evaluation

True locations are never disclosed, so we need our own ground truth.

- `eval/build_set.py`: 30–50 panoramas with known coordinates from Mapillary 360° imagery in PT/ES/FR, mixed urban and rural including tracks, resized to 6080 x 3040 with metadata stripped, labelled Urban/non-Urban by hand.
- `eval/run_eval.py`: mean score per panorama, median distance, share within 100 m / 1 km / 10 km, cost and time, split by label. Exclude each panorama's own source imagery from `streetview_lookup` to avoid leakage.
- Use it to compare effort levels, view sets, tools on and off, and the hedge setting.
- For the organisers' sets, a team member judges plausibility on a map, as the brief expects.
- Unit tests: `scoring.py` against hand-computed values and against https://gis.tools/distance-calculator, the penalty ledger, and the allocator.

## 12. Build plan

| Milestone | Scope |
|---|---|
| **M1, before the 19:00 trial** | `pano.py`, `view_crop`, `update_candidates`, `submit_locations`, `search_places`, `web_search`; agent loop with deadlines and best-so-far fallback; `scoring.py`, `allocate.py`, penalty ledger; JSONL log and export; CLI batch mode; minimal UI with MCQ buttons. Sample log posted to Discord. |
| **M2, Saturday night** | `streetview_lookup`, `satellite_tile`, `overpass_query`, `sun_position`; evaluation set and harness; cue box and last-resort geocode; six-way parallel hardening; cue playbook checked and frozen. |
| **Stretch** | Mapillary as second street-level source; 2–3 independent runs merged for the Special One; Cloud Vision landmark detection on crops; GeoCLIP as an independent prior; DEM skyline matching for mountainous non-Urban scenes. |
| **Out of scope** | Fine-tuning any model; PIGEON (weights not released); Google Street View tiles API (its policy prohibits machine analysis); Google Lens scraping. |

**Keys to obtain now**
- Anthropic API key: check the organisation's rate-limit tier and spend cap in the Console; dry-run six parallel panoramas during the trial.
- Google Cloud project with billing: Street View Static, Geocoding, Places, Maps Static. Needs a credit card; free monthly caps should cover the weekend if candidates are filtered with the free metadata call first.
- Mapillary client token (free).
- No key: Nominatim, Photon, Overpass, Esri World Imagery, DGT / PNOA / IGN orthophotos, OpenTopoData.

## 13. Questions for the organisers (ask on Discord now)

Each has a default we build to until answered; each default is a config flag.

| # | Question | Default |
|---|---|---|
| Q1 | May the agent itself use the internet: web search, geocoding, street-level and satellite imagery APIs? | **Critical.** Assume yes, with `ALLOW_WEB` able to switch every external tool off |
| Q2 | Do R6–R8 penalties apply only to entries produced after the interaction, or to the whole final list? | Whole list |
| Q3 | Are exact duplicate coordinates scored at every rank? | Yes, per the brief |
| Q4 | Required JSON log schema, one file per panorama or per run, where and when to submit? | Our schema, one file per panorama |
| Q5 | Is the capture timestamp UTC or local time? | Unknown; `sun_position` evaluates both and the result is a weak prior only |
| Q6 | Is theta = 2 / (1 + d/scale), so an exact rank-1 hit scores 2000? | Yes; strategy does not depend on it |
| Q7 | Is an MCQ whose options are candidate places, checked by a human with tools on other equipment, acceptable under R7? | Yes ("geographic zones" are named in R7) |
| Q8 | Do the label and timestamp, passed as text, count as a cue? Does the system prompt? | No; they are task input and preparation |
| Q9 | What counts as an indirect location reference in a cue (country, language of signs, vegetation)? | Only visual-feature descriptions; no toponyms, countries or regions |
| Q10 | When does the 60-minute clock start, and can a submission be revised inside the window? | One clock from hand-over; last submission counts |
| Q11 | Answer format: order, datum, file or form? | `lat,lng`, decimal WGS84, 6 decimals |
| Q12 | Rules and time limit for the live panorama? | Same rules, a few minutes, autonomous |

## 14. Risks

| Risk | Mitigation |
|---|---|
| External tools ruled out by the organisers (Q1) | `ALLOW_WEB=false` mode: model reasoning, `view_crop`, sun compass and an offline gazetteer only; test it during the trial |
| All 10 slots on a confidently wrong point | Calibrate on the evaluation set; hedge flag; MCQ gate for multi-modal posteriors |
| Urban pin right town, wrong street (worth under 10%) | Street-level compare-and-walk loop is the M2 priority; operator MCQ on candidate streets |
| Public OSM services throttled on shared Wi-Fi | Disk cache, Photon and an Overpass mirror wired before the trial, phone hotspot as backup |
| Model refuses or never submits | Competition context in the prompt, refusal handling, best-so-far list |
| Anthropic rate limit or spend cap mid-run | Check the tier today, pre-fund, second key as backup |
| Operator types a cue that references a location, breaching R6 | Cue box hidden by default, lint, confirm dialog; the log shows compliance |
| Per-turn latency higher than budgeted | Measure at the trial; drop to `medium` effort or fewer turns |
| Google Maps terms on automated analysis of imagery | Use the Static API with a key, keep Mapillary and national orthophotos as alternates; mention usage to the organisers if asked |
