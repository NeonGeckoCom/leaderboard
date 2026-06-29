---
title: Neon Leaderboard
emoji: 📊
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
short_description: Single-viewport dashboard for the Neon model leaderboard
---

# Neon Leaderboard

A single-page, single-viewport dashboard for exploring the
[`neon-router`](https://github.com/NeonGeckoCom/neon-router) weekly leaderboard —
Neon.ai models and retrieval pipelines evaluated across seven QA benchmarks.

Everything is **static**: no backend, no build step at serve time. The page reads
one precomputed file (`data.js`) and renders entirely in the browser, so it deploys
identically to a Hugging Face *Static* Space or GitHub Pages.

## What's inside

| Tab | What it shows |
|---|---|
| **Compare** | The full results grid. Pick a benchmark and see every pipeline ranked, or switch to **By model** to follow one pipeline across all benchmarks. Searchable benchmark / model dropdowns, sort by any metric (MRR, speed, cost…), filter to a single model, toggle Neon-only / disqualified rows, and relative color heat per column. |
| **Picks** | The router's single recommended pipeline per client **profile** × benchmark, with a statistical verdict (winner clear / inconclusive / all disqualified). Hover a profile header for its hard gates. |
| **Models** | A summary page for any model: pipeline, repo, mean MRR / gen / latency, Pareto and DQ counts, and its metrics across every benchmark. |
| **Metrics** | All models × all metrics — either **mean scores** (color-coded) or **wins / losses** per metric. Sortable by any metric. |
| **Guide** | Full metrics glossary, every client profile's hard gates, and run provenance. |

Hover any column header anywhere for a plain-language definition (e.g. *P50 = 50th
percentile latency*, *MRR = Mean Reciprocal Rank*). A light/dark toggle (◐) sits in
the top-right; append `?theme=light` to the URL to share a light-mode link, and
`#picks` / `#models` / `#metrics` / `#guide` to deep-link a tab.

## Faithfulness to the source

`data.js` is generated from the leaderboard's own source of truth — `run.json` plus
the profile YAMLs — and the picks, Pareto front, disqualifications, verdicts, and
win/loss tallies are recomputed with logic ported directly from
`router/pareto.py` and `router/reports/leaderboard.py`. Spot-checked to match
`reports/dashboard/leaderboard.md` exactly.

## Regenerating the data

When the leaderboard is re-run, rebuild `data.js` from a `neon-router` checkout:

```bash
python scripts/build_data.py \
  --run-json   /path/to/neon-router/reports/dashboard/raw/run.json \
  --profiles-dir /path/to/neon-router/configs/profiles \
  --out data.js
```

With a `neon-router` clone sitting next to this folder, the defaults already point
at it, so `python scripts/build_data.py` is enough. The script needs only
`pyyaml` (`pip install pyyaml`).

To change which models get the **NEON** badge, edit the `NEON_MODELS` set near the
top of `scripts/build_data.py` and re-run it.

## Deploying

### Hugging Face Static Space (BrainForge)

1. Create a new Space → SDK **Static** under the `BrainForge` org.
2. Push `index.html`, `app.js`, `data.js`, and this `README.md` (its front-matter
   above configures the Space). That's the whole site.

```bash
# from this folder, with the Space repo as the remote
git lfs install --skip-repo
git add index.html app.js data.js README.md scripts/build_data.py
git commit -m "Neon leaderboard dashboard"
git push
```

### GitHub Pages (NeonGeckoCom)

1. Put these files at the repo root (or in `/docs`).
2. Settings → Pages → deploy from branch, root (or `/docs`).
No build step is required — it's plain static files.

## Local preview

```bash
python -m http.server 8000
# open http://localhost:8000/
```

Files:

```
index.html            # markup + styles (single viewport shell)
app.js                # all rendering / interactions (vanilla JS, no deps)
data.js               # precomputed dataset (window.LEADERBOARD_DATA)
data.json             # same data as plain JSON (for non-browser consumers)
scripts/build_data.py # regenerates data.js / data.json from run.json + profiles
```

## License

BSD-3-Clause — Copyright 2008-2025 Neongecko.com Inc. See [`LICENSE.md`](LICENSE.md).
The leaderboard figures are derived from the proprietary `neon-router` benchmark
pipeline; this repository covers the dashboard presentation code.
