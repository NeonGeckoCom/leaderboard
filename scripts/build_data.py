#!/usr/bin/env python3
# NEON AI (TM) SOFTWARE, Software Development Kit & Application Development System
# All trademark and other rights reserved by their respective owners
# Copyright 2008-2025 Neongecko.com Inc.
# BSD-3 License
#
# Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
# following conditions are met:
# 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following
# disclaimer.
# 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
# disclaimer in the documentation and/or other materials provided with the distribution.
# 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products
# derived from this software without specific prior written permission.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
# INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
# DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
# SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
# SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
# WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
# THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
"""Build the static dashboard data bundle (``data.js``) for the Neon leaderboard.

This reads the leaderboard's own source of truth -- ``run.json`` plus the
profile YAMLs -- and recomputes picks, the Pareto front, disqualifications,
verdicts, and per-metric win/loss tallies using logic faithful to
``router/pareto.py`` and ``router/reports/leaderboard.py`` in the neon-router
repo. The output is a single ``data.js`` file that assigns
``window.LEADERBOARD_DATA`` so the dashboard loads with no server / no CORS.

Usage:
    python scripts/build_data.py \
        --run-json /path/to/reports/dashboard/raw/run.json \
        --profiles-dir /path/to/configs/profiles \
        --out ../data.js

Defaults point at a sibling ``neon-router`` checkout.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

try:
    import yaml
except ImportError:  # pragma: no cover
    raise SystemExit("PyYAML is required: pip install pyyaml")


# ---------------------------------------------------------------------------
# Profile model (mirror of router.pareto.ProfilePreference, subset we need)
# ---------------------------------------------------------------------------
@dataclass
class Profile:
    name: str
    latency_budget_ms: Optional[float] = None
    generation_latency_budget_ms: Optional[float] = None
    cost_ceiling_per_query_usd: Optional[float] = None
    accuracy_floor_mrr: Optional[float] = None
    accuracy_floor_generation_acc: Optional[float] = None
    corpus_profile: Optional[str] = None
    query_mix: Dict[str, float] = field(default_factory=dict)
    deployment_constraint: Optional[str] = None
    quality_weight: float = 0.7
    latency_penalty_per_ms: float = 0.0001
    generation_latency_penalty_per_ms: float = 0.0
    cost_penalty_per_token: float = 0.0
    metric: str = "mrr"


# Fields the dashboard reads off each aggregate row.
NUMERIC_FIELDS = [
    "mrr", "hit_at_1", "hit_at_5", "ndcg_at_10",
    "p50_retrieval_latency_ms", "p95_retrieval_latency_ms",
    "avg_retrieval_latency_ms", "index_build_seconds",
    "est_cost_per_query_usd", "generation_acc",
    "p50_generation_latency_ms", "avg_generation_latency_ms",
    "generation_tokens_per_sec", "est_generation_cost_per_query_usd",
    "paraphrase_drop", "shift_drop", "n_queries",
]

DQ_LATENCY, DQ_COST, DQ_ACCURACY = "latency", "cost", "accuracy"

# Models served/fine-tuned by Neon.ai (vs. retrieval-only baselines and any
# external references). Edit this set to control the "Neon" badge in the UI.
# Match on the candidate's `model` name (the first ``::`` segment).
NEON_MODELS = {
    "devstral-123b",
    "ministral-14b-reasoning",
    "magistral-small",
    "devstral-small-24b",
    "mistral-small-3.2-24b",
    "granite-4-30b",
}


def _get(agg: dict, key: str):
    return agg.get(key)


def _acc_axis(agg: dict, metric: str) -> float:
    return float(agg.get(metric) or 0.0)


def _cost_per_query(agg: dict) -> float:
    return float(agg.get("est_cost_per_query_usd") or 0.0)


# ---------------------------------------------------------------------------
# Faithful port of router.pareto
# ---------------------------------------------------------------------------
def apply_hard_constraints(aggs: List[dict], p: Profile) -> Tuple[List[dict], List[Tuple[dict, str]]]:
    survivors: List[dict] = []
    dq: List[Tuple[dict, str]] = []
    for agg in aggs:
        reason: Optional[str] = None
        avg_lat = agg.get("avg_retrieval_latency_ms")
        avg_gen_lat = agg.get("avg_generation_latency_ms")
        if p.latency_budget_ms is not None and avg_lat is not None and avg_lat > p.latency_budget_ms:
            reason = DQ_LATENCY
        elif (
            p.generation_latency_budget_ms is not None
            and avg_gen_lat is not None
            and avg_gen_lat > p.generation_latency_budget_ms
        ):
            reason = DQ_LATENCY
        elif (
            p.cost_ceiling_per_query_usd is not None
            and p.cost_ceiling_per_query_usd > 0.0
            and _cost_per_query(agg) > p.cost_ceiling_per_query_usd
        ):
            reason = DQ_COST
        elif (
            p.accuracy_floor_generation_acc is not None
            and agg.get("generation_acc") is not None
            and agg.get("generation_acc") < p.accuracy_floor_generation_acc
        ):
            reason = DQ_ACCURACY
        elif (
            p.accuracy_floor_mrr is not None
            and p.metric == "mrr"
            and _acc_axis(agg, p.metric) < p.accuracy_floor_mrr
        ):
            reason = DQ_ACCURACY
        if reason is None:
            survivors.append(agg)
        else:
            dq.append((agg, reason))
    return survivors, dq


def pareto_front(aggs: List[dict], metric: str = "mrr") -> List[dict]:
    front: List[dict] = []
    for a in aggs:
        dominated = False
        for b in aggs:
            if a is b:
                continue
            a_lat = a.get("avg_retrieval_latency_ms") or 0.0
            b_lat = b.get("avg_retrieval_latency_ms") or 0.0
            a_build = a.get("index_build_seconds") or 0.0
            b_build = b.get("index_build_seconds") or 0.0
            ge = (
                _acc_axis(b, metric) >= _acc_axis(a, metric)
                and b_lat <= a_lat
                and b_build <= a_build
            )
            gt = (
                _acc_axis(b, metric) > _acc_axis(a, metric)
                or b_lat < a_lat
                or b_build < a_build
            )
            if ge and gt:
                dominated = True
                break
        if not dominated:
            front.append(a)
    return front


def select_winner(aggs: List[dict], p: Profile) -> Optional[dict]:
    survivors, _ = apply_hard_constraints(aggs, p)
    front = pareto_front(survivors, metric=p.metric)
    if not front:
        return None

    def utility(agg: dict) -> float:
        accuracy = _acc_axis(agg, p.metric)
        lat = agg.get("avg_retrieval_latency_ms") or 0.0
        gen_lat = agg.get("avg_generation_latency_ms") or 0.0
        return (
            p.quality_weight * accuracy
            - p.latency_penalty_per_ms * lat
            - p.generation_latency_penalty_per_ms * gen_lat
        )

    return sorted(front, key=utility, reverse=True)[0]


def _wilson_ci(n_succ: float, n_total: int, z: float = 1.96) -> Tuple[float, float]:
    if n_total == 0:
        return (0.0, 0.0)
    pp = n_succ / n_total
    denom = 1.0 + z * z / n_total
    centre = (pp + z * z / (2.0 * n_total)) / denom
    margin = z * math.sqrt(pp * (1.0 - pp) / n_total + z * z / (4.0 * n_total * n_total)) / denom
    return (max(0.0, centre - margin), min(1.0, centre + margin))


def value_add_verdict(aggs: List[dict], p: Profile) -> str:
    survivors, _ = apply_hard_constraints(aggs, p)
    if len(survivors) < 2:
        return "no signal"

    def key(a: dict) -> float:
        if p.metric == "generation_acc" and a.get("generation_acc") is not None:
            return a["generation_acc"]
        return a.get("mrr") or 0.0

    ranked = sorted(survivors, key=key, reverse=True)
    winner, runner = ranked[0], ranked[1]
    n = int(winner.get("n_queries") or 0)
    w_lo, _ = _wilson_ci(key(winner) * n, n)
    _, r_hi = _wilson_ci(key(runner) * n, n)
    return "winner clear" if w_lo > r_hi else "inconclusive"


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------
def load_profiles(profiles_dir: Path) -> List[Profile]:
    valid = set(Profile.__dataclass_fields__)
    profiles: List[Profile] = []
    for path in sorted(profiles_dir.glob("*.yaml")):
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        clean = {k: v for k, v in raw.items() if k in valid}
        profiles.append(Profile(**clean))
    return profiles


def split_candidate(cid: str) -> Tuple[str, str, str]:
    parts = cid.split("::")
    return (parts[0], parts[1], parts[2]) if len(parts) == 3 else (cid, "", "")


def _embedding_short(model: str) -> str:
    """Friendly short name for an embedding model repo id."""
    if not model:
        return ""
    tail = model.split("/")[-1]
    return {
        "bge-m3": "bge-m3",
        "bge-large-en-v1.5": "bge-large",
    }.get(tail, tail)


def retriever_components(params: dict) -> List[dict]:
    """Decompose a retriever's params into ordered component badges.

    Mirrors configs/axes.retrieval.yaml: a retriever is some combination of
    BM25 (lexical), dense Embedding (bge-m3 / bge-large), SPLADE (learned
    sparse), and optional live Web search.
    """
    params = params or {}
    comps: List[dict] = []
    if params.get("enable_bm25"):
        comps.append({"key": "bm25", "label": "BM25"})
    if params.get("enable_embedding"):
        comps.append({
            "key": "emb",
            "label": "Embedding",
            "detail": _embedding_short(params.get("embedding_model", "")),
        })
    if params.get("enable_splade"):
        comps.append({"key": "splade", "label": "SPLADE"})
    if params.get("enable_web_search"):
        comps.append({"key": "web", "label": "Web"})
    return comps


# Mirror of leaderboard.py _GLOSSARY (kept in sync with the source report).
GLOSSARY = {
    "model": "The generation model in the pipeline. 'retrieval-only' means no LLM generation step was run for this row.",
    "retriever": "Retrieval strategy used to fetch candidate documents (e.g. hybrid = BM25 + dense embeddings; bm25-only = lexical; splade-only = learned sparse).",
    "reranker": "Cross-encoder reranker applied after retrieval ('none' = no reranking; minilm / mxbai are reranker models).",
    "MRR": "Mean Reciprocal Rank \u2014 average of 1/rank for the first relevant doc retrieved per query. Range 0\u20131; higher is better.",
    "H@1": "Hit@1 \u2014 fraction of queries where the top-1 retrieved doc is relevant. Higher is better.",
    "H@5": "Hit@5 \u2014 fraction of queries where any of the top-5 retrieved docs is relevant. Higher is better.",
    "nDCG": "Normalized Discounted Cumulative Gain @10 \u2014 position-weighted relevance of the top-10 results. Higher is better.",
    "P50": "Median (50th percentile) per-query retrieval latency in milliseconds. Lower is better.",
    "P95": "95th percentile retrieval latency \u2014 the tail (worst-case) cost per query, in milliseconds. Lower is better.",
    "build": "Index build time in seconds for this benchmark corpus. Lower is better.",
    "gen": "Generation score (task-dependent): for multiple-choice benchmarks, the fraction of questions answered correctly given retrieved context; for the language-following benchmark, the fraction of responses written in the user's language. Higher is better.",
    "gen ms": "Median per-query generation latency (time-to-first-token + generation) in milliseconds. Lower is better.",
    "tok/s": "LLM output tokens generated per second on this benchmark. Higher is better.",
    "gen $": "Estimated generation cost per query in USD (token usage \u00d7 model price). Lower is better.",
    "$/kq": "Total estimated cost per 1,000 queries in USD (retrieval + generation). Lower is better.",
    "par": "Paraphrase robustness \u2014 MRR on paraphrased queries minus MRR on originals. Near zero is expected; large negative means fragile exact-match retrieval.",
    "shift": "Held-out (domain-shifted) slice MRR \u2014 measures out-of-distribution generalization on an unseen query subset.",
    "n": "Number of queries evaluated for this row.",
    "verdict": "Whether the winning candidate is statistically distinct from the runner-up. 'winner clear' = winner's Wilson CI lower bound exceeds runner-up's upper bound; 'inconclusive' = confidence intervals overlap (within noise); 'no signal' = too few valid candidates; 'all disqualified' = every candidate failed a hard gate.",
    "Pareto": "Pareto front \u2014 a pipeline not dominated by any other on (accuracy, latency, build-cost) simultaneously. Marked with \u2605.",
    "DQ": "Disqualified \u2014 violated one of the profile's hard gates: DQ:latency (p50 over budget), DQ:cost (cost per query over ceiling), or DQ:accuracy (MRR or generation score below the floor).",
    "pick": "The router's single recommended pipeline (model / retriever / reranker) for this client profile on this benchmark.",
    "profile": "A client requirements file (not a model) declaring latency / cost / accuracy hard gates plus utility weights used to rank surviving candidates.",
}

# Per-metric definitions used by the Compare and Metrics tabs.
# key -> (label, field, higher_is_better, fmt, tooltip-key, display_scale)
# display_scale multiplies the stored value for presentation only (the raw
# field is left untouched so hard-constraint gates keep using true values).
METRICS = [
    ("mrr", "MRR", "mrr", True, "f3", "MRR", 1),
    ("h1", "H@1", "hit_at_1", True, "f2", "H@1", 1),
    ("h5", "H@5", "hit_at_5", True, "f2", "H@5", 1),
    ("ndcg", "nDCG", "ndcg_at_10", True, "f3", "nDCG", 1),
    ("p50", "P50 ms", "p50_retrieval_latency_ms", False, "f0", "P50", 1),
    ("p95", "P95 ms", "p95_retrieval_latency_ms", False, "f0", "P95", 1),
    ("build", "Build s", "index_build_seconds", False, "f1", "build", 1),
    ("gen", "gen", "generation_acc", True, "f3", "gen", 1),
    ("gen_ms", "gen ms", "p50_generation_latency_ms", False, "f0", "gen ms", 1),
    ("tok_s", "tok/s", "generation_tokens_per_sec", True, "f0", "tok/s", 1),
    ("gen_cost", "gen $", "est_generation_cost_per_query_usd", False, "f5", "gen $", 1),
    ("cost", "$/kq", "est_cost_per_query_usd", False, "f2", "$/kq", 1000),
    ("par", "par", "paraphrase_drop", True, "f3", "par", 1),
    ("shift", "shift", "shift_drop", True, "f3", "shift", 1),
]


def build(run_json: Path, profiles_dir: Path) -> dict:
    raw = json.loads(run_json.read_text(encoding="utf-8"))
    profiles = load_profiles(profiles_dir)
    benchmarks: List[str] = list(raw.get("benchmarks", []))
    aggregates: List[dict] = raw.get("aggregates", [])
    candidates_meta: List[dict] = raw.get("candidates", [])

    # Candidate metadata map keyed by candidate_id, plus retriever / reranker
    # composition maps shared across rows.
    cand_map: Dict[str, dict] = {}
    retrievers: Dict[str, dict] = {}
    rerankers: Dict[str, dict] = {}
    for c in candidates_meta:
        llm = c.get("llm", {}) or {}
        retr = c.get("retriever", {}) or {}
        rer = c.get("reranker", {}) or {}
        rname = retr.get("name")
        if rname and rname not in retrievers:
            comps = retriever_components(retr.get("params", {}))
            parts = [
                (cp["label"] + (" (" + cp["detail"] + ")" if cp.get("detail") else ""))
                for cp in comps
            ]
            retrievers[rname] = {
                "name": rname,
                "components": comps,
                "summary": " + ".join(parts) if parts else rname,
            }
        rerk = rer.get("name")
        if rerk and rerk not in rerankers:
            rerankers[rerk] = {"name": rerk, "model": rer.get("model")}
        cid = f"{llm.get('name')}::{retr.get('name')}::{rer.get('name')}"
        cand_map[cid] = {
            "id": cid,
            "model": llm.get("name"),
            "model_adapter": llm.get("adapter"),
            "model_repo": llm.get("model"),
            "retriever": retr.get("name"),
            "retriever_adapter": retr.get("adapter"),
            "reranker": rer.get("name"),
            "reranker_model": rer.get("model"),
            "is_neon": llm.get("name") in NEON_MODELS,
            "is_retrieval_only": llm.get("name") == "retrieval-only",
        }

    # Trim aggregates to the fields the dashboard needs + identity.
    def trim(agg: dict) -> dict:
        model, retriever, reranker = split_candidate(agg["candidate_id"])
        out = {
            "candidate_id": agg["candidate_id"],
            "benchmark": agg["benchmark"],
            "model": model,
            "retriever": retriever,
            "reranker": reranker,
            "is_neon": model in NEON_MODELS,
            "error": agg.get("error"),
        }
        for f in NUMERIC_FIELDS:
            out[f] = agg.get(f)
        return out

    trimmed = [trim(a) for a in aggregates]

    by_bench: Dict[str, List[dict]] = {}
    for a in trimmed:
        by_bench.setdefault(a["benchmark"], []).append(a)

    # ----- Picks (per benchmark x profile) -----
    picks: Dict[str, Dict[str, dict]] = {}
    for bench in benchmarks:
        aggs = by_bench.get(bench, [])
        picks[bench] = {}
        for p in profiles:
            winner = select_winner(aggs, p)
            if winner is None:
                survivors, _ = apply_hard_constraints(aggs, p)
                status = "all disqualified" if not survivors else "no winner"
                picks[bench][p.name] = {"pick": None, "verdict": status}
                continue
            verdict = value_add_verdict(aggs, p)
            metric_val = (
                winner.get("generation_acc")
                if p.metric == "generation_acc"
                else winner.get("hit_at_1")
            )
            picks[bench][p.name] = {
                "pick": winner["candidate_id"],
                "model": winner["model"],
                "retriever": winner["retriever"],
                "reranker": winner["reranker"],
                "mrr": winner.get("mrr"),
                "metric": p.metric,
                "metric_val": metric_val,
                "p50": winner.get("p50_retrieval_latency_ms"),
                "verdict": verdict,
            }

    # ----- Per-benchmark ordering, Pareto, DQ -----
    bench_tables: Dict[str, dict] = {}
    for bench in benchmarks:
        aggs = sorted(by_bench.get(bench, []), key=lambda a: a.get("mrr") or 0.0, reverse=True)
        front_ids = {a["candidate_id"] for a in pareto_front(aggs)}
        dq_by_id: Dict[str, str] = {}
        for p in profiles:
            _, dqs = apply_hard_constraints(aggs, p)
            for agg, reason in dqs:
                dq_by_id.setdefault(agg["candidate_id"], reason)
        bench_tables[bench] = {
            "order": [a["candidate_id"] for a in aggs],
            "pareto": sorted(front_ids),
            "dq": dq_by_id,
        }

    # ----- Per-metric win / loss tally across benchmarks -----
    EPS = 1e-9
    metric_stats: Dict[str, dict] = {}
    for key, label, fieldname, higher, _fmt, _tip, _scale in METRICS:
        per_cand: Dict[str, dict] = {}
        for bench in benchmarks:
            vals = [
                (a["candidate_id"], a.get(fieldname))
                for a in by_bench.get(bench, [])
                if a.get(fieldname) is not None
            ]
            if not vals:
                continue
            best = (max if higher else min)(v for _, v in vals)
            worst = (min if higher else max)(v for _, v in vals)
            for cid, v in vals:
                s = per_cand.setdefault(cid, {"wins": 0, "losses": 0, "sum": 0.0, "count": 0})
                s["sum"] += v
                s["count"] += 1
                if abs(v - best) <= EPS:
                    s["wins"] += 1
                if abs(v - worst) <= EPS and abs(best - worst) > EPS:
                    s["losses"] += 1
        for cid, s in per_cand.items():
            s["mean"] = s["sum"] / s["count"] if s["count"] else None
            del s["sum"]
        metric_stats[key] = per_cand

    profiles_out = []
    for p in profiles:
        gates = []
        if p.latency_budget_ms:
            gates.append(f"p50 \u2264 {p.latency_budget_ms:g} ms")
        if p.generation_latency_budget_ms:
            gates.append(f"gen \u2264 {p.generation_latency_budget_ms:g} ms")
        if p.cost_ceiling_per_query_usd:
            gates.append(f"$/q \u2264 {p.cost_ceiling_per_query_usd:g}")
        if p.accuracy_floor_mrr:
            gates.append(f"MRR \u2265 {p.accuracy_floor_mrr:g}")
        if p.accuracy_floor_generation_acc:
            gates.append(f"gen \u2265 {p.accuracy_floor_generation_acc:g}")
        profiles_out.append({
            "name": p.name,
            "metric": p.metric,
            "gates": gates,
            "corpus_profile": p.corpus_profile,
            "query_mix": p.query_mix,
            "deployment_constraint": p.deployment_constraint,
            "quality_weight": p.quality_weight,
        })

    header = raw.get("provenance", {}) or {}
    date_str = ""
    merged_at = header.get("merged_at")
    if merged_at:
        date_str = merged_at[:10]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "date": date_str,
        "benchmarks": benchmarks,
        "candidates": cand_map,
        "retrievers": retrievers,
        "rerankers": rerankers,
        "aggregates": trimmed,
        "profiles": profiles_out,
        "picks": picks,
        "bench_tables": bench_tables,
        "metric_stats": metric_stats,
        "metrics_def": [
            {"key": k, "label": l, "field": f, "higher": h, "fmt": fmt, "tip": t, "scale": sc}
            for (k, l, f, h, fmt, t, sc) in METRICS
        ],
        "glossary": GLOSSARY,
        "provenance": header,
        "n_candidates": len({a["candidate_id"] for a in trimmed}),
        "n_queries": (trimmed[0].get("n_queries") if trimmed else None),
    }


def main() -> None:
    here = Path(__file__).resolve().parent
    default_repo = here.parent.parent / "neon-router"
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--run-json",
        type=Path,
        default=default_repo / "reports" / "dashboard" / "raw" / "run.json",
    )
    ap.add_argument(
        "--profiles-dir",
        type=Path,
        default=default_repo / "configs" / "profiles",
    )
    ap.add_argument("--out", type=Path, default=here.parent / "data.js")
    args = ap.parse_args()

    if not args.run_json.exists():
        raise SystemExit(f"run.json not found: {args.run_json}")
    if not args.profiles_dir.exists():
        raise SystemExit(f"profiles dir not found: {args.profiles_dir}")

    data = build(args.run_json, args.profiles_dir)
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    js_header = (
        "/*\n"
        " * NEON AI (TM) SOFTWARE, Software Development Kit & Application Development System\n"
        " * All trademark and other rights reserved by their respective owners\n"
        " * Copyright 2008-2025 Neongecko.com Inc.\n"
        " * BSD-3 License\n"
        " *\n"
        " * Redistribution and use in source and binary forms, with or without modification, are permitted provided that the\n"
        " * following conditions are met:\n"
        " * 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following\n"
        " * disclaimer.\n"
        " * 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following\n"
        " * disclaimer in the documentation and/or other materials provided with the distribution.\n"
        " * 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products\n"
        " * derived from this software without specific prior written permission.\n"
        " *\n"
        " * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \"AS IS\" AND ANY EXPRESS OR IMPLIED WARRANTIES,\n"
        " * INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE\n"
        " * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,\n"
        " * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR\n"
        " * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,\n"
        " * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF\n"
        " * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.\n"
        " */\n"
    )
    args.out.write_text(
        js_header +
        "// Auto-generated by scripts/build_data.py - do not edit by hand.\n"
        "window.LEADERBOARD_DATA = " + payload + ";\n",
        encoding="utf-8",
    )
    # Also emit a plain JSON sidecar for non-browser consumers.
    (args.out.parent / "data.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Wrote {args.out} ({args.out.stat().st_size/1024:.1f} KB)")
    print(f"  benchmarks={len(data['benchmarks'])} "
          f"candidates={data['n_candidates']} "
          f"aggregates={len(data['aggregates'])} "
          f"profiles={len(data['profiles'])}")


if __name__ == "__main__":
    main()
