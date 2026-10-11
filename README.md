# astrolabio

Panorama localisation agent for the Albatroz Challenge (JunctionX Lisbon 2026). It takes a 360°
equirectangular panorama with its `Urban` / `non-Urban` label and capture timestamp, and returns
10 ranked `(lat, lng)` entries plus a JSON log of every interaction. Design and rules: `SPEC.md`.

## Setup

```
uv sync                      # Python 3.11+, creates .venv
cp .env.example .env         # then fill in the keys
uv run pytest -q             # offline; no key or network needed
```

| Key | Needed for |
|---|---|
| `OPENAI_API_KEY` | Every real run. Without it each panorama gets the fallback prior point and an `api_error` event. |
| `GOOGLE_MAPS_API_KEY` | Street View lookups, and Google results in `search_places`. Optional. |
| `MAPILLARY_TOKEN` | Second street-level source, and building the evaluation set. Optional. |

Nominatim, Photon, Overpass and Esri World Imagery need no key. Responses are cached under
`.cache/http` and never expire; delete the directory to force fresh results.

## Input

A directory of panoramas (`.jpg`, `.jpeg`, `.png`). Label, timestamp and the Special One flag are
read from, in increasing priority:

1. an `Urban/` or `non-Urban/` sub-directory holding the image;
2. the file name (`20261011093000_Urban.jpg`, `*_non-Urban_*`, `*_special_*`);
3. a sidecar `<name>.txt` / `<name>.json`. In a text sidecar the Special One must be stated on a
   line of its own (`special`, `Special One: yes`); the word inside a sentence is ignored;
4. a manifest: any CSV, TSV, TXT or JSON table in the directory, whatever its name, with or
   without a header line (`filename,label,timestamp,special`). Labels may be `Urban`, `non-Urban`,
   `U`, `NU` or a boolean `urban` column; timestamps may omit the seconds.

Files whose name starts with a dot are skipped (macOS writes `._name.jpg` next to every image on a
USB stick or in a zip). `--special NAME` marks the Special One by file name. A panorama with no
label is refused unless `--label` gives a default, and that default is applied to **every**
unlabelled panorama, so use it only when they really share it.

Before launching, every command prints one line per panorama with the label, timestamp and
Special One flag it parsed, followed by warnings (a defaulted label, an unreadable timestamp,
several Special Ones). Check that table: a wrong label silently changes the scoring function, the
allocator and the fallback point.

## Web console

```
uv run python cli.py serve        # opens http://127.0.0.1:8000
```

One command starts everything; the rest happens in the browser (design: `UI-SPEC.md`):

- **Runs**: every run under `runs/`, live or on disk. A run that was killed is listed as
  interrupted and "Rebuild exports" finishes it from its logs.
- **New run**: drop the panoramas (or a zip, or pick a folder on the machine), check the parsed
  labels, timestamps and Special One in the preflight table, choose a preset (autonomous batch,
  scoring run, live on stage, evaluation, custom) and launch.
- **Run dashboard and panorama focus**: the tiles with the three penalised controls (below), stop
  and finalize, the reasoning stream, and a replay of any finished panorama.
- **Submission**: the checklist, `answers.csv`, and the zip to hand in.
- **Evaluation** and **Settings**: build and label the ground-truth set, score and compare runs;
  keys, defaults for new runs, health.

Options: `--port N`, `--no-open` (do not open the browser), and the old ones. With a directory,
`serve data/scoring --special <file>` also launches that run at once, as it always did; it and
every other run still going are finalised and exported when the server stops.

The server binds 127.0.0.1 only, answers only under its own address (`127.0.0.1`, `localhost` or
`[::1]` with the port) and refuses state-changing requests from any other origin, so another page
open in the same browser cannot charge a penalty. A second laptop can join only after "LAN
access" is switched on in Settings and the server restarted: the join link with its token is
printed on this terminal, and the directory browser and key editing are off while it is on.
`--host` with a non-loopback address is refused otherwise.

- **Demo and rehearsal without the API:** `ASTROLABIO_FAKE_MODEL=1 uv run python cli.py serve` runs
  every panorama with a scripted model: no model call, no cost, made-up answers. Every preset can
  be launched, so the scoring hour (phase guide, questions, cues, freeze, submission) and the
  stage view can be rehearsed without spending. Such a run keeps its preset but is a `training`
  run marked as fake: the submission checklist fails on "Real model" and the zip asks before it is
  built. The health page does not contact OpenAI, Google or Mapillary while the demo model is on
  ("not checked: demo model"). The variable must be in the command's own environment; in `.env`
  it is ignored with a warning.
- **A scratch copy for trying things:** `RUNS_DIR`, `CACHE_DIR`, `ASTROLABIO_DATA_DIR` (uploaded
  sets and saved settings), `ASTROLABIO_EVAL_DATA_DIR` (the evaluation set) and `ASTROLABIO_ENV_FILE`
  (the file Settings writes keys to) each move one directory or file, so a second server can run
  beside the real one without touching its runs, its evaluation labels or `.env`.
- **The old page:** `uv run python cli.py serve data/scoring --special <file> --legacy` starts the
  single-run server exactly as it was before the console. Inside the console the same page is at
  `/legacy` for any run the server is holding.

## Commands

The CLI keeps working for scripts; nothing exists only there.

| Run | Command |
|---|---|
| Training / trial set, autonomous | `uv run python cli.py batch data/set1 --concurrency 6 --no-human` |
| Scoring run, launched from the terminal | `uv run python cli.py serve data/scoring --special <file>` (the console opens on it) |
| Live on-stage panorama | `uv run python cli.py run pano.jpg --label Urban --live` |
| One panorama | `uv run python cli.py run pano.jpg --label non-Urban [--special]` |
| Rebuild exports from the logs | `uv run python cli.py export runs/<run_id> [--embed-images]` |
| Evaluation against our own ground truth | `uv run python cli.py eval run` (see `eval/README.md`) |

Common flags: `--no-web` (no external tools), `--hedge`, `--run-id NAME`, `--live` (3.5 minute
hard deadline). `run` and `batch` are autonomous by default because they have no UI to answer a
question; `serve` keeps the human channels on unless `--no-human` is given.

Stopping and restarting:

- Ctrl-C, `kill` (SIGTERM) and a closed terminal (SIGHUP) all finalise every panorama and write
  the exports before the process exits. `serve` gives open browser tabs 3 seconds to disconnect.
- After a hard kill (`kill -9`, power loss) "Rebuild exports" in the console, or
  `cli.py export runs/<run_id>`, rebuilds the files from the logs. A panorama that never reached a final submission is exported with its last
  `update_candidates` list, re-stamped with the penalties recorded in the log; its `stop_reason`
  is `recovered_from_provisional` and the row keeps a "no final_submission" problem so that it
  is looked at.
- Reusing a `--run-id` appends to the same logs and carries over what they record: the penalty
  counts, the best-so-far hypotheses and a human geocode (that panorama is not run again). There
  is no way to resume a conversation; a restarted panorama starts a new one.

Each run writes to `runs/<run_id>/`:

- `<panorama_id>.events.jsonl`: the append-only interaction log, flushed per event.
- `<panorama_id>.json`: the export to submit (`docs/sample_export.json` is an example, produced by
  the offline end-to-end test with a scripted model, so its content is synthetic).
- `answers.csv` (`panorama_id,rank,lat,lng`, 6 decimals) and `summary.csv` (one row per panorama;
  a non-empty `problems` column means that export failed validation).
- `<panorama_id>/images/`: every view sent to the model, named by sha256.

Every panorama always ends with exactly 10 entries: the agent's submission, else its latest
`update_candidates`, else the label's prior point (`origin: harness_fallback`).

## Answer construction

`astrolabio/allocate.py` turns the agent's hypotheses into the list (SPEC 7.1): by default the single
point with the highest expected theta, ten times. Two details go beyond the SPEC's pseudo-code and
reduce to it exactly in its own setting:

- `radius_m` is used. A hypothesis means "the camera is within `radius_m` of this point with this
  probability", so its probability is spread over that disc when candidates are valued. A vague
  "somewhere in this town, 60%, radius 1500 m" no longer takes all ten slots from a verified spot
  at 40% with a 15 m radius. With radii of 10 m or less the formula is the SPEC's point-mass one.
- With `--hedge` / `HEDGE=true`, the second point is the best candidate outside the first one's
  tight cluster (30 m Urban, 3 km non-Urban), not a near-duplicate of it. Hedging is off by default
  and lowers the expected score in every case; leave it off unless there is a reason.

## API failures and time limits

- Every request goes to the OpenAI Responses API, streamed, with `max_output_tokens=64000`
  (reasoning counts toward it). If a turn is still cut off, the tool calls completed before the
  cut are executed; only the one being written is answered with an error.
- Transient failures (connection errors before or during the stream, timeouts, 408/409/429/5xx,
  and errors reported inside an open stream, such as `server_error`) are retried with capped
  backoff until the panorama's hard deadline; `retry-after` is honoured when it fits in the time
  left. 400/401/403/404/413/422 and a 429 with code `insufficient_quota` (no credit left) end the
  run on the best-so-far answer at once. So do an in-stream error that names a request parameter
  and a fourth consecutive in-stream error that carries no code at all.
- A stream that delivers nothing for `API_READ_TIMEOUT_S` (default 60 s) is dropped and the turn
  re-issued. The longest silence measured in a healthy stream was 11 s.
- After every batch of tool results the agent is told the time used, the turn number and how much
  of its image budget (80 images or about 24 MB of base64 per conversation) is spent; the real
  deadlines of the run are in its first message. The budget is the harness's own: above 272,000
  input tokens the API bills the whole request at its long-context rates (twice the input price,
  1.5 times the output price). A full-size view costs about 2,540 input tokens, so 80 images are
  about 200K and leave some 55K for instructions, tools, text and echoed reasoning.
- Nothing is stored on the API side (`store=False`): the whole history, reasoning items included,
  is re-sent on every turn, and prompt caching makes the repeated prefix cheap. Each panorama has
  its own `prompt_cache_key`. `cost_usd` in the log is an estimate at the Standard-tier prices in
  `astrolabio/config.py`, including $10 per 1,000 `web_search` calls.
- One `overpass_query` is limited to 60 s across both servers; a timeout moves on to the mirror
  instead of retrying. `search_places` waits at most 30 s for Nominatim before using Photon.

## Operator controls

Each tile of a run's dashboard shows the panorama, the hypotheses on a map, the provisional list,
the live multiplier, elapsed time and the reasoning stream; the Special One is listed first. The
only inputs that reach the agent are the three penalised ones:

1. **MCQ buttons** (x0.95, charged when the agent asks). They appear only when the agent calls
   `ask_multiple_choice`; no answer within 90 s returns "no answer; proceed". The per-tile
   "MCQ allowed" toggle makes the tool refuse at no cost. The harness also refuses, at no cost, a
   question asked in the same turn as `submit_locations` or with less than 150 s to the hard
   deadline, since the answer could not be used.
2. **Cue box** (x0.8). At most 1000 characters; a lint blocks coordinates (also coarse or spelled
   out), postcodes, phone numbers, URLs, road numbers, place names, street and landmark names,
   country codes, demonyms, language names and any capitalised word in mid-sentence; a confirm
   dialog shows the multiplier before and after. **The lint is a backstop, not the R6 guarantee**:
   no gazetteer is complete, and a place name typed in lower case that it does not know passes.
   The operator answers for what they type.
3. **Last-resort geocode** (x0.5). Click the map for a place the agent has named. It makes the
   human point the final answer immediately and ends that panorama, so no question or cue can be
   charged afterwards.

**Cues and questions only work while a tile is still running.** Once the agent has submitted (or
its hard deadline has passed: 14 minutes, 20 for the Special One) the cue box is disabled and the
only remaining control is the x0.5 geocode. Review of the Special One therefore has to start
inside its 15 to 20 minute window, not after it; the review phases at minutes 12 to 52 in SPEC
section 10 cannot use cues or questions on panoramas that have already finished. A cue sent while
the agent is writing its submission is delivered first (the submission is held for one turn); a
cue in the last 30 s before the hard deadline is refused at no cost; a cue that was charged but
could not be delivered is logged as `human_cue_undelivered` and keeps its penalty.

"Finalize now", "Finalize all", "Stop run", "Retry" and the exports are harness controls and send
nothing to the agent. Exports are written when a run ends, after every geocode and finalize, and
when the server stops, so the files on disk always match what the page shows. Every penalised
request carries an idempotency key: a double click or a retry after a timeout charges once, and
"Check" on a cue runs the lint without leaving any trace in the log. Map tiles are the only thing
the page loads from the internet; without them the maps show a coordinate grid.

## Flags for the organiser questions (SPEC section 13)

Set these in `.env`. The defaults are what we build to until the organisers answer.

| # | Question | Flag or behaviour | Default |
|---|---|---|---|
| Q1 | May the agent use the internet? | `ALLOW_WEB=false` or `--no-web` removes every external tool | on |
| Q2 | Do penalties apply to the whole list? | `PENALTY_SCOPE=whole_list` or `subsequent` | `whole_list` |
| Q3 | Are duplicate coordinates scored at every rank? | `ALLOW_DUPLICATES=false` gives 10 distinct points | duplicates |
| Q4 | Log schema and file layout | One JSON per panorama; `EMBED_IMAGES=true` or `export --embed-images` inlines images | by reference |
| Q5 | Is the timestamp UTC or local? | No flag: `sun_position` evaluates both and reports it as a weak prior | both |
| Q6 | Is theta = 2 / (1 + d/scale)? | No flag: constants in `astrolabio/scoring.py` and `Label.scale_m` | yes |
| Q7 | Are MCQs about candidate places allowed? | `MCQ_ALLOWED=false`, `MAX_MCQ=0`, or the per-tile toggle | allowed, 3 max |
| Q8 | Do label and timestamp count as a cue? | No flag: they are passed as task input | no |
| Q9 | What is an indirect location reference? | No flag: `astrolabio/cuelint.py` blocks toponyms, countries, regions, demonyms, languages | strict |
| Q10 | When does the clock start; can we resubmit? | `GLOBAL_WATCHDOG_S` finalises everything; exports can be rebuilt at any time | 3000 s |
| Q11 | Answer format | No flag: `answers.csv`, `lat,lng`, decimal WGS84, 6 decimals | as shown |
| Q12 | Rules for the live panorama | `--live` budget (`Settings.live`), autonomous | 210 s hard deadline |

Other settings (`HEDGE`, `NO_HUMAN`, `TEAM_NAME`, `RUNS_DIR`, `CACHE_DIR`, `ASTROLABIO_MODEL`,
`ASTROLABIO_IMAGE_DETAIL`, `API_READ_TIMEOUT_S`) are listed in `.env.example`; budgets, `max_tokens`
(sent as `max_output_tokens`), prices, prior points and service URLs are fields of `Settings` in
`astrolabio/config.py`. The default model is `gpt-6.1-sol` at effort `high` (`xhigh` for the Special
One); `ASTROLABIO_MODEL=gpt-6-astra` selects the stronger model at five times the price.

## Before the scoring run

- What has been run against the live OpenAI API (`gpt-6.1-sol`, `openai` 3.28.0):
  - One panorama end to end through `RunManager`, at effort `low`, 6 turns, web on, no operator:
    submitted by the agent after 5 turns and 47 s for $0.17, with a valid export. Eight of the ten
    tools were called with schema-valid arguments, the hosted `web_search` among them.
  - The client on its own: multi-turn tool calls with images inside tool outputs, the reasoning
    items echoed back at effort `high`, a tool call cut off at the output limit and a turn cut
    off inside reasoning (both recovered), a hosted search with its billed count, and the
    logged cost recomputed by hand from the usage.
  - Errors: an unknown model (404), a bad key (401), a missing key and two kinds of 400. Each
    ended the run with `api_error` and the fallback answer, without retries. A stalled stream
    surfaced as a retryable `APITimeoutError`.
  - Stream silence at efforts `high` and `xhigh`, up to a 155 s turn with 11,578 reasoning tokens.
- What has not, and is covered by tests against the installed SDK with a mock transport only:
  - A full-length run: the Special One's `xhigh` budget, 45 turns, the 80-image budget, six
    panoramas in parallel, and an operator answering a question or sending a cue.
  - `satellite_tile` and `ask_multiple_choice` called by the real model, and `streetview_lookup`
    with a Google or Mapillary key (without one it returned its "unavailable" error).
  - A 429 (rate limit or `insufficient_quota`) with its `retry-after`, a `response.failed`, an
    in-stream `error` event, and the fallback for an organisation that cannot get reasoning
    summaries (this key can).
  - Efforts `max` and `medium`, and any model other than `gpt-6.1-sol`.
  - The price of cache writes against an invoice: the harness charges $2.50 per million, about
    $0.11 for a panorama's first turn.
- Run one real panorama at the full budget before the scoring run.
- Check the key's rate limits before running six panoramas in parallel: cached tokens count toward
  the tokens-per-minute limit, and every turn re-sends the whole conversation. A 429 is retried
  with backoff, so a limit that is too low shows up as `api_retry` events and slow turns.
- Reasoning summaries (the "thinking" lines in the log and the UI) may require a verified
  organisation. If the API rejects them the client stops asking and the run continues without them.
- At the trial, on the venue network, read `image_payload_chars` and `latency_ms` from the
  `model_request` / `model_response` events of one run. The whole image history is re-uploaded on
  every turn; the initial views are encoded at JPEG quality 80 to limit that, at the sizes SPEC 6.2
  fixes. If turns are slow because of upload, lower `INITIAL_JPEG_QUALITY` in `astrolabio/pano.py`.
- Watch for `api_retry` events with `error_class: APITimeoutError` during long reasoning turns. If a
  healthy stream is being cut, raise `API_READ_TIMEOUT_S`: the 60 s default is five times the
  longest silence seen in four measured streams (11 s inside reasoning, 4 s inside a hosted search),
  the API documents no bound, and effort `max` was not measured.
- Brief the operators: the cue lint is a backstop, cues and questions only work on running tiles,
  and a geocode ends the panorama.
- Have a team member check the regional playbook in `astrolabio/prompts.py` against Plonk It,
  geotips.net and geometas; it was drafted from memory (SPEC 6.4).
- Post `docs/sample_export.json` to the organisers' Discord to have the log format confirmed.
