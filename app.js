/*
 * NEON AI (TM) SOFTWARE, Software Development Kit & Application Development System
 * All trademark and other rights reserved by their respective owners
 * Copyright 2008-2025 Neongecko.com Inc.
 * BSD-3 License
 *
 * Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
 * following conditions are met:
 * 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following
 * disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
 * disclaimer in the documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products
 * derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
 * INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
/* Neon Leaderboard - static dashboard.
   All data is precomputed in data.js (window.LEADERBOARD_DATA) by
   scripts/build_data.py, faithful to the neon-router report logic. */
(function () {
  "use strict";
  const D = window.LEADERBOARD_DATA;
  if (!D) { document.body.innerHTML = "<p style='padding:30px'>data.js failed to load.</p>"; return; }

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const el = (tag, attrs, kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k.startsWith("on") && typeof attrs[k] === "function") n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    if (kids) (Array.isArray(kids) ? kids : [kids]).forEach(c => c != null && n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return n;
  };

  const GLOSS = D.glossary || {};
  const METRICS = D.metrics_def;            // [{key,label,field,higher,fmt,tip}]
  const BENCH = D.benchmarks;
  const AGG = D.aggregates;
  const CANDS = D.candidates;               // map id -> meta

  const aggBy = {};                         // benchmark -> [agg]
  const aggByCand = {};                     // candidate_id -> [agg] (across benchmarks)
  AGG.forEach(a => {
    (aggBy[a.benchmark] = aggBy[a.benchmark] || []).push(a);
    (aggByCand[a.candidate_id] = aggByCand[a.candidate_id] || []).push(a);
  });
  const CAND_IDS = Object.keys(CANDS);
  const MODEL_NAMES = Array.from(new Set(CAND_IDS.map(id => CANDS[id].model)));
  // Prefer a Neon model with generation data as the default detail selection.
  const DEFAULT_CAND = CAND_IDS.find(id => CANDS[id].is_neon) || CAND_IDS[0];

  // ---- formatting ----
  function num(v, code) {
    if (v == null || v === "") return "";
    const d = { f0: 0, f1: 1, f2: 2, f3: 3, f5: 5 }[code];
    return Number(v).toFixed(d == null ? 3 : d);
  }
  function pipeLabel(c) {
    const r = c.reranker && c.reranker !== "none" ? " · " + c.reranker : "";
    return c.model + " · " + c.retriever + r;
  }
  function benchShort(b) { return b.replace(/^dataset-/, "").replace(/-qa$/, ""); }

  // ---- tooltip ----
  const tip = $("#tip");
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.style.opacity = "1";
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 16;
    if (left + r.width > innerWidth - 8) left = x - r.width - 12;
    if (top + r.height > innerHeight - 8) top = y - r.height - 12;
    tip.style.left = Math.max(6, left) + "px"; tip.style.top = Math.max(6, top) + "px";
  }
  function hideTip() { tip.style.opacity = "0"; }
  function bindTip(node, html) {
    if (!html) return node;
    node.addEventListener("mousemove", e => showTip(html, e.clientX, e.clientY));
    node.addEventListener("mouseleave", hideTip);
    return node;
  }
  function glossTip(term, extra) {
    const def = GLOSS[term];
    if (!def && !extra) return null;
    return "<b>" + term + "</b><br>" + (def || "") + (extra ? "<br><br>" + extra : "");
  }

  // ---- color heat (diverging, low-glare) ----
  function heatStyle(v, min, max, higher) {
    if (v == null || v === "" || max === min) return "";
    let t = (v - min) / (max - min);            // 0..1, 1 = numerically max
    if (!higher) t = 1 - t;                       // 1 = good
    const intensity = Math.abs(t - 0.5) * 2;      // 0 mid .. 1 extreme
    const hue = t >= 0.5 ? 168 : 28;
    const dark = document.documentElement.getAttribute("data-theme") !== "light";
    const light = dark ? 46 : 60;
    const sat = dark ? 52 : 62;
    const alpha = (0.05 + intensity * 0.30).toFixed(3);
    return "background:hsla(" + hue + "," + sat + "%," + light + "%," + alpha + ")";
  }

  // ---- searchable combobox (single select) ----
  function Combo(host, opts) {
    // opts: {options:[{value,label,sub,neon}], value, placeholder, onChange, width}
    let value = opts.value;
    let open = false, kbd = -1, filtered = opts.options;
    host.className = "combo";
    const btn = el("button", { class: "field", style: "text-align:left;min-width:" + (opts.width || 180) + "px;display:flex;align-items:center;gap:6px" });
    const menu = el("div", { class: "menu" });
    const search = el("input", { class: "field", placeholder: "Type to search…", style: "width:100%;margin-bottom:5px" });
    const list = el("div");
    menu.appendChild(search); menu.appendChild(list);
    host.appendChild(btn); host.appendChild(menu);

    function curLabel() { const o = opts.options.find(o => o.value === value); return o ? o.label : (opts.placeholder || "Select…"); }
    function paintBtn() {
      btn.innerHTML = "";
      const o = opts.options.find(o => o.value === value);
      if (o && o.neon) btn.appendChild(el("span", { class: "badge neon", text: "NEON" }));
      btn.appendChild(el("span", { text: curLabel(), style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }));
      btn.appendChild(el("span", { text: "▾", style: "color:var(--text-faint);font-size:10px" }));
    }
    function paintList() {
      list.innerHTML = "";
      filtered.forEach((o, i) => {
        const row = el("div", { class: "opt" + (o.value === value ? " sel" : "") + (i === kbd ? " kbd" : "") });
        if (o.neon) row.appendChild(el("span", { class: "badge neon", text: "NEON" }));
        row.appendChild(el("span", { text: o.label }));
        if (o.sub) row.appendChild(el("small", { text: o.sub }));
        row.addEventListener("click", () => { value = o.value; close(); opts.onChange && opts.onChange(value); });
        list.appendChild(row);
      });
      if (!filtered.length) list.appendChild(el("div", { class: "opt", style: "color:var(--text-faint)", text: "No matches" }));
    }
    function doFilter() {
      const q = search.value.trim().toLowerCase();
      filtered = !q ? opts.options : opts.options.filter(o =>
        (o.label + " " + (o.sub || "")).toLowerCase().includes(q));
      kbd = filtered.length ? 0 : -1; paintList();
    }
    function openMenu() { open = true; host.classList.add("open"); search.value = ""; doFilter(); setTimeout(() => search.focus(), 0); }
    function close() { open = false; host.classList.remove("open"); paintBtn(); }
    btn.addEventListener("click", e => { e.stopPropagation(); open ? close() : openMenu(); });
    search.addEventListener("input", doFilter);
    search.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { kbd = Math.min(filtered.length - 1, kbd + 1); paintList(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { kbd = Math.max(0, kbd - 1); paintList(); e.preventDefault(); }
      else if (e.key === "Enter" && filtered[kbd]) { value = filtered[kbd].value; close(); opts.onChange && opts.onChange(value); }
      else if (e.key === "Escape") close();
    });
    document.addEventListener("click", e => { if (open && !host.contains(e.target)) close(); });
    paintBtn();
    return {
      get value() { return value; },
      set value(v) { value = v; paintBtn(); },
      setOptions(o, v) { opts.options = o; if (v !== undefined) value = v; paintBtn(); }
    };
  }

  // ===================================================================
  // State
  // ===================================================================
  const S = {
    tab: "compare",
    cmpMode: "byBench",
    bench: BENCH[0],
    cand: null,            // selected pipeline id (byModel)
    filterModel: "__all__",
    sortKey: "mrr",
    sortDir: -1,           // -1 desc, 1 asc
    neonOnly: false,
    showDQ: true,
    heat: true,
    metricMode: "scores",
    metricSort: "mrr",
    metricNeonOnly: false,
    metricHeat: true,
    pageCand: null,
  };

  // ===================================================================
  // Header / footer
  // ===================================================================
  $("#headerMeta").textContent = (D.date || "") + " · " + D.n_candidates + " pipelines · " +
    BENCH.length + " benchmarks · " + (D.n_queries || "?") + " queries";
  const prov = D.provenance || {};
  $("#provFoot").textContent = (prov.weekly ? "weekly roster sweep" : "sweep") + (prov.merged_at ? " · merged " + prov.merged_at.slice(0, 19).replace("T", " ") + "Z" : "");
  function paintLegendSwatches() {
    $("#lgGood").style.cssText = "width:11px;height:11px;border-radius:3px;display:inline-block;" + heatStyle(1, 0, 1, true);
    $("#lgBad").style.cssText = "width:11px;height:11px;border-radius:3px;display:inline-block;" + heatStyle(0, 0, 1, true);
  }

  // ===================================================================
  // Tabs
  // ===================================================================
  const CTLS = { compare: "#ctl-compare", picks: "#ctl-picks", models: "#ctl-models", metrics: "#ctl-metrics", guide: "#ctl-guide" };
  $$("#tabs button").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
  function setTab(t) {
    S.tab = t;
    try { history.replaceState(null, "", "#" + t); } catch (e) {}
    $$("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === t));
    $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + t));
    for (const k in CTLS) $(CTLS[k]).style.display = (k === t ? "flex" : "none");
    render();
  }

  // ===================================================================
  // Compare controls
  // ===================================================================
  const benchCombo = Combo($("#benchCombo"), {
    options: BENCH.map(b => ({ value: b, label: benchShort(b), sub: b })),
    value: S.bench, width: 170, onChange: v => { S.bench = v; render(); }
  });
  const candOptions = () => CAND_IDS.map(id => ({ value: id, label: pipeLabel(CANDS[id]), neon: CANDS[id].is_neon, sub: CANDS[id].is_neon ? "Neon" : (CANDS[id].is_retrieval_only ? "retrieval" : "") }));
  const modelCombo = Combo($("#modelCombo"), { options: candOptions(), value: DEFAULT_CAND, width: 230, onChange: v => { S.cand = v; render(); } });
  S.cand = DEFAULT_CAND;
  const filterCombo = Combo($("#filterCombo"), {
    options: [{ value: "__all__", label: "All models" }].concat(MODEL_NAMES.map(m => ({ value: m, label: m, neon: (CANDS[CAND_IDS.find(id => CANDS[id].model === m)] || {}).is_neon }))),
    value: "__all__", width: 160, onChange: v => { S.filterModel = v; render(); }
  });
  const sortSel = $("#sortSel");
  function fillSortSel() {
    sortSel.innerHTML = "";
    sortSel.appendChild(el("option", { value: "pipe", text: "Pipeline (A–Z)" }));
    METRICS.forEach(m => sortSel.appendChild(el("option", { value: m.field, text: m.label })));
    sortSel.value = S.sortKey;
  }
  fillSortSel();
  sortSel.addEventListener("change", () => { S.sortKey = sortSel.value; render(); });
  $("#sortDir").addEventListener("click", () => { S.sortDir *= -1; $("#sortDir").textContent = S.sortDir < 0 ? "▾" : "▴"; render(); });
  $$("#cmpModeSeg button").forEach(b => b.addEventListener("click", () => {
    S.cmpMode = b.dataset.mode;
    $$("#cmpModeSeg button").forEach(x => x.classList.toggle("active", x === b));
    $("#benchPickWrap").style.display = S.cmpMode === "byBench" ? "flex" : "none";
    $("#modelPickWrap").style.display = S.cmpMode === "byModel" ? "flex" : "none";
    render();
  }));
  $("#neonOnly").addEventListener("change", e => { S.neonOnly = e.target.checked; render(); });
  $("#showDQ").addEventListener("change", e => { S.showDQ = e.target.checked; render(); });
  $("#heat").addEventListener("change", e => { S.heat = e.target.checked; render(); });

  // ===================================================================
  // Compare render
  // ===================================================================
  function activeMetricCols(rows) {
    return METRICS.filter(m => rows.some(r => r[m.field] != null && r[m.field] !== ""));
  }
  function renderCompare() {
    const table = $("#cmpTable");
    table.innerHTML = "";
    let rows, flagFor, leftHead, leftCell;

    if (S.cmpMode === "byBench") {
      const bt = D.bench_tables[S.bench] || { order: [], pareto: [], dq: {} };
      const paretoSet = new Set(bt.pareto);
      rows = (aggBy[S.bench] || []).slice();
      if (S.filterModel !== "__all__") rows = rows.filter(r => r.model === S.filterModel);
      if (S.neonOnly) rows = rows.filter(r => r.is_neon);
      if (!S.showDQ) rows = rows.filter(r => !bt.dq[r.candidate_id]);
      flagFor = r => ({ pareto: paretoSet.has(r.candidate_id), dq: bt.dq[r.candidate_id] });
      leftHead = "pipeline"; leftCell = r => pipeCell(r, flagFor(r));
    } else {
      rows = (aggByCand[S.cand] || []).slice();
      flagFor = () => ({});
      leftHead = "benchmark";
      leftCell = r => bindTip(el("td", { class: "txt" }, el("span", { class: "pipe", text: benchShort(r.benchmark) })), "<b>" + r.benchmark + "</b>");
    }

    const cols = activeMetricCols(rows);
    // sort
    rows.sort((a, b) => {
      if (S.sortKey === "pipe") {
        const av = S.cmpMode === "byBench" ? pipeLabel(CANDS[a.candidate_id]) : a.benchmark;
        const bv = S.cmpMode === "byBench" ? pipeLabel(CANDS[b.candidate_id]) : b.benchmark;
        return av < bv ? S.sortDir : av > bv ? -S.sortDir : 0;
      }
      const av = a[S.sortKey], bv = b[S.sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1;
      return (av - bv) * S.sortDir;
    });

    // column ranges for heat
    const ranges = {};
    cols.forEach(m => {
      const vs = rows.map(r => r[m.field]).filter(v => v != null && v !== "");
      ranges[m.field] = vs.length ? { min: Math.min(...vs), max: Math.max(...vs) } : null;
    });

    // head
    const thead = el("thead");
    const htr = el("tr");
    htr.appendChild(bindTip(el("th", { class: "txt lbl sortable", onclick: () => sortByCol("pipe"), html: leftHead + (S.sortKey === "pipe" ? " <span class='arrow'>" + (S.sortDir < 0 ? "▼" : "▲") + "</span>" : "") }),
      S.cmpMode === "byBench" ? glossTip("pipeline", "model · retriever · reranker") : "<b>benchmark</b><br>The evaluation dataset for this row."));
    cols.forEach(m => {
      const arrow = S.sortKey === m.field ? " <span class='arrow'>" + (S.sortDir < 0 ? "▼" : "▲") + "</span>" : "";
      htr.appendChild(bindTip(el("th", { class: "sortable", onclick: () => sortByCol(m.field), html: m.label + arrow }),
        glossTip(m.tip, (m.higher ? "Higher is better." : "Lower is better."))));
    });
    thead.appendChild(htr); table.appendChild(thead);

    // body
    const tb = el("tbody");
    if (!rows.length) { tb.appendChild(el("tr", null, el("td", { colspan: cols.length + 1, class: "empty", text: "No rows match the current filters." }))); }
    rows.forEach(r => {
      const tr = el("tr", { class: r.is_neon ? "neon" : "" });
      tr.appendChild(leftCell(r));
      cols.forEach(m => {
        const v = r[m.field];
        const td = el("td", { text: num(v, m.fmt) });
        if (S.heat && ranges[m.field]) td.style.cssText = heatStyle(v, ranges[m.field].min, ranges[m.field].max, m.higher);
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
  }
  function sortByCol(k) { if (S.sortKey === k) S.sortDir *= -1; else { S.sortKey = k; S.sortDir = (k === "pipe") ? 1 : -1; } sortSel.value = k; $("#sortDir").textContent = S.sortDir < 0 ? "▾" : "▴"; render(); }

  function pipeCell(r, flag) {
    const c = CANDS[r.candidate_id];
    const inner = el("span", { class: "pipe" });
    if (flag.pareto) inner.appendChild(el("span", { class: "star", text: "★ " }));
    inner.appendChild(el("b", { text: c.model }));
    inner.appendChild(el("small", { text: "  " + c.retriever + (c.reranker !== "none" ? " · " + c.reranker : "") }));
    const td = el("td", { class: "txt" });
    if (c.is_neon) td.appendChild(el("span", { class: "badge neon", text: "NEON", style: "margin-right:6px" }));
    td.appendChild(inner);
    if (flag.dq) td.appendChild(el("span", { class: "badge dq", text: "DQ:" + flag.dq, style: "margin-left:7px" }));
    return bindTip(td, "<b>" + pipeLabel(c) + "</b>" +
      (c.model_repo ? "<br>repo: " + c.model_repo : "") +
      (flag.dq ? "<br><br>Disqualified by a profile's <b>" + flag.dq + "</b> gate." : "") +
      (flag.pareto ? "<br><br>★ On the Pareto front (not dominated on accuracy / latency / build-cost)." : ""));
  }

  // ===================================================================
  // Picks render
  // ===================================================================
  const VCLASS = { "winner clear": "v-clear", "inconclusive": "v-inconclusive", "all disqualified": "v-dq", "no winner": "v-none", "no signal": "v-none" };
  function renderPicks() {
    const table = $("#picksTable"); table.innerHTML = "";
    const profs = D.profiles;
    const thead = el("thead"); const htr = el("tr");
    htr.appendChild(el("th", { class: "txt", text: "benchmark", style: "text-align:left" }));
    profs.forEach(p => {
      const extra = "Hard gates: " + (p.gates.join(" · ") || "—") + "<br>Ranks on: " + p.metric +
        (p.corpus_profile ? "<br>Corpus: " + p.corpus_profile : "") +
        (p.deployment_constraint ? "<br>Deploy: " + p.deployment_constraint : "");
      htr.appendChild(bindTip(el("th", { html: p.name.replace(/_/g, " ") }), glossTip("profile", extra)));
    });
    thead.appendChild(htr); table.appendChild(thead);

    const tb = el("tbody");
    BENCH.forEach(b => {
      const tr = el("tr");
      tr.appendChild(bindTip(el("th", { text: benchShort(b) }), "<b>" + b + "</b>"));
      const row = D.picks[b] || {};
      profs.forEach(p => {
        const cell = row[p.name];
        const td = el("td");
        if (cell && cell.pick) {
          const c = CANDS[cell.pick];
          const wrap = el("div");
          const line = el("div", { style: "font-family:var(--mono);font-size:11.5px;margin-bottom:4px" });
          if (c && c.is_neon) line.appendChild(el("span", { class: "badge neon", text: "NEON", style: "margin-right:5px" }));
          line.appendChild(el("span", { text: cell.model + " · " + cell.retriever }));
          wrap.appendChild(line);
          const mv = cell.metric === "generation_acc" ? "gen " + num(cell.metric_val, "f2") : "H@1 " + num(cell.metric_val, "f2");
          wrap.appendChild(bindTip(el("span", { class: "verdict " + (VCLASS[cell.verdict] || "v-none"), text: cell.verdict }),
            glossTip("verdict") ));
          wrap.appendChild(el("span", { class: "cell-sub", text: "MRR " + num(cell.mrr, "f3") + " · " + mv + " · p50 " + num(cell.p50, "f0") + "ms" }));
          td.appendChild(wrap);
        } else {
          td.appendChild(el("span", { class: "verdict " + (VCLASS[(cell && cell.verdict)] || "v-dq"), text: (cell && cell.verdict) || "—" }));
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
  }

  // ===================================================================
  // Models render
  // ===================================================================
  const modelPageCombo = Combo($("#modelPageCombo"), { options: candOptions(), value: DEFAULT_CAND, width: 240, onChange: v => { S.pageCand = v; render(); } });
  S.pageCand = DEFAULT_CAND;
  function renderModels() {
    const host = $("#modelPage"); host.innerHTML = "";
    const id = S.pageCand; const c = CANDS[id];
    const rows = (aggByCand[id] || []).slice().sort((a, b) => benchShort(a.benchmark) < benchShort(b.benchmark) ? -1 : 1);
    $("#modelPageBadge").innerHTML = c.is_neon ? "<span class='badge neon'>NEON.ai model</span>" : (c.is_retrieval_only ? "<span class='badge pareto'>retrieval baseline</span>" : "");

    // aggregate stats
    const mean = f => { const vs = rows.map(r => r[f]).filter(v => v != null); return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null; };
    let paretoCount = 0; BENCH.forEach(b => { const bt = D.bench_tables[b]; if (bt && bt.pareto.includes(id)) paretoCount++; });
    let dqCount = 0; BENCH.forEach(b => { const bt = D.bench_tables[b]; if (bt && bt.dq[id]) dqCount++; });

    // left card
    const left = el("div", { class: "card" });
    left.appendChild(el("h3", { style: "margin:0 0 10px;font-size:14px", text: c.model }));
    const kvs = [
      ["pipeline", c.retriever + (c.reranker !== "none" ? " · " + c.reranker : "")],
      ["model repo", c.model_repo || "—"],
      ["serving", c.model_adapter || "—"],
      ["benchmarks", String(rows.length)],
      ["type", c.is_neon ? "Neon.ai model" : (c.is_retrieval_only ? "retrieval-only" : "external")],
    ];
    kvs.forEach(([k, v]) => left.appendChild(el("div", { class: "kv" }, [el("span", { class: "k", text: k }), el("span", { class: "v", text: v })])));
    const stats = el("div", { class: "stat-row", style: "margin-top:14px" });
    const stat = (n, l, tipTerm) => { const s = el("div", { class: "stat" }, [el("div", { class: "n", text: n }), bindTip(el("div", { class: "l", text: l }), glossTip(tipTerm))]); stats.appendChild(s); };
    stat(num(mean("mrr"), "f3"), "mean MRR", "MRR");
    const gm = mean("generation_acc"); stat(gm == null ? "—" : num(gm, "f2"), "mean gen", "gen");
    stat(num(mean("p50_retrieval_latency_ms"), "f0"), "p50 ms", "P50");
    stat(String(paretoCount), "Pareto ★", "Pareto");
    stat(String(dqCount), "DQ count", "DQ");
    left.appendChild(stats);
    host.appendChild(left);

    // right card: metrics across benchmarks
    const right = el("div", { class: "card scroll" });
    const cols = activeMetricCols(rows);
    const table = el("table");
    const thead = el("thead"); const htr = el("tr");
    htr.appendChild(el("th", { class: "txt", text: "benchmark", style: "text-align:left;position:sticky;top:0;background:var(--bg-elev)" }));
    cols.forEach(m => htr.appendChild(bindTip(el("th", { html: m.label, style: "position:sticky;top:0;background:var(--bg-elev)" }), glossTip(m.tip, m.higher ? "Higher is better." : "Lower is better."))));
    thead.appendChild(htr); table.appendChild(thead);
    const ranges = {}; cols.forEach(m => { const vs = rows.map(r => r[m.field]).filter(v => v != null); ranges[m.field] = vs.length ? { min: Math.min(...vs), max: Math.max(...vs) } : null; });
    const tb = el("tbody");
    rows.forEach(r => {
      const bt = D.bench_tables[r.benchmark];
      const tr = el("tr");
      const star = bt && bt.pareto.includes(id) ? el("span", { class: "star", text: "★ " }) : null;
      const dq = bt && bt.dq[id] ? el("span", { class: "badge dq", text: "DQ:" + bt.dq[id], style: "margin-left:6px" }) : null;
      const tdL = el("td", { class: "txt" }); if (star) tdL.appendChild(star); tdL.appendChild(el("span", { text: benchShort(r.benchmark) })); if (dq) tdL.appendChild(dq);
      tr.appendChild(tdL);
      cols.forEach(m => { const v = r[m.field]; const td = el("td", { text: num(v, m.fmt) }); if (ranges[m.field]) td.style.cssText = heatStyle(v, ranges[m.field].min, ranges[m.field].max, m.higher); tr.appendChild(td); });
      tb.appendChild(tr);
    });
    table.appendChild(tb); right.appendChild(table); host.appendChild(right);
  }

  // ===================================================================
  // Metrics render
  // ===================================================================
  const metricSortSel = $("#metricSortSel");
  function fillMetricSort() {
    metricSortSel.innerHTML = "";
    metricSortSel.appendChild(el("option", { value: "name", text: "Pipeline (A–Z)" }));
    METRICS.forEach(m => metricSortSel.appendChild(el("option", { value: m.key, text: m.label })));
    metricSortSel.value = S.metricSort;
  }
  fillMetricSort();
  metricSortSel.addEventListener("change", () => { S.metricSort = metricSortSel.value; render(); });
  $$("#metricModeSeg button").forEach(b => b.addEventListener("click", () => { S.metricMode = b.dataset.mode; $$("#metricModeSeg button").forEach(x => x.classList.toggle("active", x === b)); render(); }));
  $("#metricNeonOnly").addEventListener("change", e => { S.metricNeonOnly = e.target.checked; render(); });
  $("#metricHeat").addEventListener("change", e => { S.metricHeat = e.target.checked; render(); });

  function renderMetrics() {
    const table = $("#metricsTable"); table.innerHTML = "";
    const stats = D.metric_stats;          // key -> cid -> {wins,losses,mean,count}
    let ids = CAND_IDS.slice();
    if (S.metricNeonOnly) ids = ids.filter(id => CANDS[id].is_neon);

    // sort rows
    if (S.metricSort === "name") ids.sort((a, b) => pipeLabel(CANDS[a]) < pipeLabel(CANDS[b]) ? -1 : 1);
    else {
      const mdef = METRICS.find(m => m.key === S.metricSort);
      const st = stats[S.metricSort] || {};
      ids.sort((a, b) => {
        const sa = st[a], sb = st[b];
        const va = S.metricMode === "winloss" ? (sa ? sa.wins - sa.losses : -1e9) : (sa && sa.mean != null ? sa.mean : (mdef.higher ? -1e9 : 1e9));
        const vb = S.metricMode === "winloss" ? (sb ? sb.wins - sb.losses : -1e9) : (sb && sb.mean != null ? sb.mean : (mdef.higher ? -1e9 : 1e9));
        return S.metricMode === "winloss" ? (vb - va) : ((vb - va) * (mdef.higher ? 1 : -1));
      });
    }

    const thead = el("thead"); const htr = el("tr");
    htr.appendChild(el("th", { class: "txt", text: "pipeline", style: "text-align:left;position:sticky;left:0;z-index:6" }));
    METRICS.forEach(m => htr.appendChild(bindTip(el("th", { html: m.label }), glossTip(m.tip, m.higher ? "Higher is better." : "Lower is better."))));
    thead.appendChild(htr); table.appendChild(thead);

    // ranges for mean heat per metric
    const ranges = {};
    METRICS.forEach(m => { const vs = ids.map(id => (stats[m.key][id] || {}).mean).filter(v => v != null); ranges[m.key] = vs.length ? { min: Math.min(...vs), max: Math.max(...vs) } : null; });

    const tb = el("tbody");
    ids.forEach(id => {
      const c = CANDS[id];
      const tr = el("tr", { class: c.is_neon ? "neon" : "" });
      const th = el("th", { style: "font-family:var(--mono);font-size:11.5px" });
      if (c.is_neon) th.appendChild(el("span", { class: "badge neon", text: "NEON", style: "margin-right:5px" }));
      th.appendChild(el("span", { text: pipeLabel(c) }));
      bindTip(th, "<b>" + pipeLabel(c) + "</b>" + (c.model_repo ? "<br>repo: " + c.model_repo : ""));
      tr.appendChild(th);
      METRICS.forEach(m => {
        const s = (stats[m.key] || {})[id];
        const td = el("td");
        if (!s) { td.textContent = ""; }
        else if (S.metricMode === "winloss") {
          td.innerHTML = "<span style='color:var(--neon)'>" + s.wins + "</span> – <span style='color:#ff9b7d'>" + s.losses + "</span>";
          const net = s.wins - s.losses;
          if (S.metricHeat) td.style.cssText = heatStyle(net, -3, 3, true);
        } else {
          td.textContent = num(s.mean, m.fmt);
          if (S.metricHeat && ranges[m.key]) td.style.cssText = heatStyle(s.mean, ranges[m.key].min, ranges[m.key].max, m.higher);
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
  }

  // ===================================================================
  // Guide render
  // ===================================================================
  function renderGuide() {
    const host = $("#guideGrid"); host.innerHTML = "";
    // left: glossary
    const left = el("div", { class: "guide-col" });
    left.appendChild(el("h3", { text: "Metrics glossary" }));
    const gt = el("table", { class: "gloss" });
    const order = ["MRR", "H@1", "H@5", "nDCG", "P50", "P95", "build", "gen", "gen ms", "tok/s", "gen $", "$/q", "par", "shift", "n", "Pareto", "DQ", "verdict"];
    order.forEach(k => { if (GLOSS[k]) gt.appendChild(el("tr", null, [el("td", { class: "term", text: k }), el("td", { class: "def", text: GLOSS[k] })])); });
    left.appendChild(gt); host.appendChild(left);
    // right: profiles + provenance
    const right = el("div", { class: "guide-col" });
    right.appendChild(el("h3", { text: "Client profiles (hard gates)" }));
    D.profiles.forEach(p => {
      const box = el("div", { class: "prof" });
      box.appendChild(el("h4", { text: p.name.replace(/_/g, " ") + "  —  ranks on " + p.metric }));
      const gates = el("div", { class: "gates" });
      (p.gates.length ? p.gates : ["no hard gates"]).forEach(g => gates.appendChild(el("span", { class: "gate", text: g })));
      box.appendChild(gates);
      const sub = [];
      if (p.corpus_profile) sub.push("corpus: " + p.corpus_profile);
      if (p.deployment_constraint) sub.push("deploy: " + p.deployment_constraint);
      if (sub.length) box.appendChild(el("div", { style: "color:var(--text-faint);font-size:11px;margin-top:6px", text: sub.join("  ·  ") }));
      right.appendChild(box);
    });
    right.appendChild(el("h3", { text: "Provenance", style: "margin-top:10px" }));
    const pv = el("div", { class: "prof" });
    const sources = (prov.merged_from || []);
    pv.appendChild(el("div", { style: "font-size:11.5px;color:var(--text-dim)", text: "Type: " + (prov.weekly ? "weekly roster sweep" : "sweep") }));
    if (prov.merged_at) pv.appendChild(el("div", { style: "font-size:11.5px;color:var(--text-dim)", text: "Merged at: " + prov.merged_at }));
    sources.forEach(s => pv.appendChild(el("div", { style: "font-family:var(--mono);font-size:10.5px;color:var(--text-faint);margin-top:3px", text: s })));
    right.appendChild(pv);
    host.appendChild(right);
  }

  // ===================================================================
  // Theme
  // ===================================================================
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("nlb-theme", t); } catch (e) {}
    paintLegendSwatches(); render();
  }
  $("#themeBtn").addEventListener("click", () => applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light"));
  let savedTheme = "dark"; try { savedTheme = localStorage.getItem("nlb-theme") || "dark"; } catch (e) {}
  const qTheme = new URLSearchParams(location.search).get("theme");
  if (qTheme === "light" || qTheme === "dark") savedTheme = qTheme;
  document.documentElement.setAttribute("data-theme", savedTheme);

  // ===================================================================
  // Master render
  // ===================================================================
  function render() {
    if (S.tab === "compare") renderCompare();
    else if (S.tab === "picks") renderPicks();
    else if (S.tab === "models") renderModels();
    else if (S.tab === "metrics") renderMetrics();
    else if (S.tab === "guide") renderGuide();
  }

  paintLegendSwatches();
  const initTab = (location.hash || "").replace("#", "");
  if (["compare", "picks", "models", "metrics", "guide"].includes(initTab)) setTab(initTab);
  else render();
})();
