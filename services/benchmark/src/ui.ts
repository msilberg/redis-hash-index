// The live UI (US-007). One self-contained HTML page: no build step, no CDN, no framework.
// The chart is drawn on a <canvas> in plain JS — it is a single line series and a dependency-free
// page is one fewer thing that can rot. See US-007.md and docs/API.md for the `/ws` frame shapes.
//
// It is exported as a string (not a static file) so the multi-stage Dockerfile — which copies only
// `dist/` — carries it with no extra plumbing.

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Redis cache invalidation — KEYS scan vs. hashed index</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0d1117; color: #d6dee7;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b98a6; margin: 0 0 20px; }
  #controls { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
  button {
    font: inherit; padding: 8px 14px; border-radius: 6px; cursor: pointer;
    border: 1px solid #30363d; background: #21262d; color: #d6dee7;
  }
  button:hover:not(:disabled) { background: #2d333b; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  #btn-v1 { border-color: #7a2f2b; }
  #btn-v2 { border-color: #2f6b4f; }
  #status {
    display: flex; flex-wrap: wrap; gap: 6px 18px; margin-bottom: 12px;
    color: #8b98a6; font-size: 13px;
  }
  #status b { color: #d6dee7; font-weight: 600; }
  .conn-open { color: #3fb27f; }
  .conn-closed, .conn-connecting { color: #e5a13d; }
  #seedbox { margin-bottom: 12px; }
  #seedbox progress { width: 240px; vertical-align: middle; }
  #chart-wrap {
    background: #10161f; border: 1px solid #21262d; border-radius: 8px;
    padding: 8px; height: 58vh; min-height: 320px;
  }
  canvas { width: 100%; height: 100%; display: block; }
  #marker-legend {
    display: flex; flex-wrap: wrap; gap: 4px 18px; margin-top: 8px;
    color: #8b98a6; font-size: 12px;
  }
  #marker-legend .sw {
    display: inline-block; width: 0; height: 12px; margin-right: 6px;
    border-left: 2px dashed; vertical-align: middle;
  }
  #legend {
    margin-top: 18px; padding: 14px 16px; background: #10161f;
    border: 1px solid #21262d; border-radius: 8px; max-width: 780px;
  }
  #legend p { margin: 6px 0; }
  #legend .k { color: #e5554e; font-weight: 600; }
  #legend .h { color: #3fb27f; font-weight: 600; }
</style>
</head>
<body>
<h1>Redis cache invalidation: legacy <code>KEYS</code> scan vs. a hashed per-entity index</h1>
<p class="sub">One sample per second from one client. The y axis is logarithmic — the two modes differ by ~4 orders of magnitude.</p>

<div id="controls">
  <button id="btn-v1" disabled>Measure legacy (KEYS) eviction</button>
  <button id="btn-v2" disabled>Measure hashed index eviction</button>
  <button id="btn-stop" disabled>Stop</button>
  <button id="btn-seed" hidden>Seed fixture</button>
</div>

<div id="status">
  <span>seed <b id="st-seed">&hellip;</b></span>
  <span id="st-keys-wrap" hidden><b id="st-keys"></b></span>
  <span>mode <b id="st-mode">idle</b></span>
  <span>elapsed <b id="st-elapsed">&mdash;</b></span>
  <span>webhook job <b id="st-job">&mdash;</b></span>
  <span>connection <b id="st-conn" class="conn-connecting">connecting</b></span>
</div>

<div id="seedbox" hidden>
  seeding&hellip; <progress id="seedprog" max="1" value="0"></progress> <span id="seedpct">0%</span>
</div>

<div id="chart-wrap"><canvas id="chart"></canvas></div>
<div id="marker-legend">
  <span><i class="sw" style="border-color:#9aa7b4"></i>eviction batch dispatched</span>
  <span><i class="sw" style="border-color:#3fb27f"></i>eviction completed</span>
  <span><i class="sw" style="border-color:#e5a13d"></i>eviction stopped before it finished</span>
  <span><i class="sw" style="border-color:#e5554e"></i>eviction failed for some users</span>
</div>

<section id="legend">
  <p><span class="k">Legacy (KEYS):</span> latency steps from ~1 ms to seconds on the first scan and
  stays there. The batch is not expected to finish &mdash; that is the point. Press Stop whenever you
  have seen enough.</p>
  <p><span class="h">Hashed index:</span> latency does not move. 1,000 users are invalidated in well
  under a second.</p>
</section>

<script>
(function () {
  "use strict";

  var C_V1 = "#e5554e", C_V2 = "#3fb27f", C_BATCH = "#9aa7b4";
  // The completion marker is coloured by the job's terminal state: green must mean it finished.
  var C_DONE = "#3fb27f", C_STOPPED = "#e5a13d", C_FAILED = "#e5554e";
  var COMPLETION_COLORS = { done: C_DONE, stopped: C_STOPPED, failed: C_FAILED };

  var chart = document.getElementById("chart");
  // Prefer a software-backed canvas: accelerated Chrome canvases can lose chart pixels
  // between redraws on some GPU/driver combinations. This small 1 Hz chart needs no GPU.
  var ctx = chart.getContext("2d", { willReadFrequently: true });

  var state = {
    conn: "connecting",
    seed: null,          // last GET /api/seed/status
    seedProgress: null,  // last {t:'seed-progress'} frame
    run: null,           // { runId, mode, startedAt, batchSec, completedSec, completionState,
                         //   completion: {processed,total,removed,incomplete}, stopped, samples: [] }
    job: null            // last webhook job counters seen on a sample/history
  };

  // ---- helpers ----------------------------------------------------------------
  function post(path, body) {
    var opts = { method: "POST" };
    if (body) {
      opts.headers = { "content-type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).catch(function () {});
  }

  function fmtInt(n) {
    return (n || 0).toLocaleString();
  }

  function markerSec(ts, startedAt) {
    return Math.round(ts - startedAt) / 1000;
  }

  function newRun(runId, mode, startedAt) {
    return {
      runId: runId, mode: mode, startedAt: startedAt,
      batchSec: null, completedSec: null, completionState: null, completion: null,
      stopped: false, samples: []
    };
  }

  function completionLabel(run) {
    var c = run.completion || {};
    if (run.completionState === "done") {
      return "eviction completed (" + fmtInt(c.processed) + " users, " + fmtInt(c.removed) + " keys)";
    }
    if (run.completionState === "stopped") {
      return "eviction stopped after " + fmtInt(c.processed) + " of " + fmtInt(c.total);
    }
    return "eviction failed \\u2014 " + fmtInt(c.incomplete) + " entities incomplete";
  }

  function powLabel(v) {
    return v >= 1000 ? (v / 1000) + " s" : v + " ms";
  }

  // ---- seed status polling --------------------------------------------------
  function refreshStatus() {
    fetch("/api/seed/status")
      .then(function (r) { return r.json(); })
      .then(function (s) { state.seed = s; render(); })
      .catch(function () {});
  }
  setInterval(refreshStatus, 2000);
  refreshStatus();

  // ---- websocket ------------------------------------------------------------
  var ws = null;
  var backoff = 500;

  function connect() {
    state.conn = "connecting";
    render();
    var proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(proto + "://" + location.host + "/ws");
    ws.onopen = function () { state.conn = "open"; backoff = 500; render(); };
    ws.onmessage = function (ev) {
      try { handleFrame(JSON.parse(ev.data)); } catch (e) {}
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onclose = function () {
      state.conn = "closed";
      render();
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    };
  }

  function adoptRun(runId, mode, startedAt) {
    if (!state.run || state.run.runId !== runId) {
      state.run = newRun(runId, mode, startedAt || Date.now());
    }
    return state.run;
  }

  function handleFrame(f) {
    if (f.t === "seed-progress") {
      state.seedProgress = f;
      if (f.percent >= 1) refreshStatus();
    } else if (f.t === "run-started") {
      state.run = newRun(f.runId, f.mode, f.ts);
      state.job = null;
    } else if (f.t === "history") {
      state.run = newRun(f.runId, f.mode, f.startedAt);
      state.run.batchSec = f.batchAt != null ? markerSec(f.batchAt, f.startedAt) : null;
      if (f.completedAt != null) {
        state.run.completedSec = markerSec(f.completedAt, f.startedAt);
        state.run.completionState = f.completionState;
        state.run.completion = f.completion;
      }
      state.run.samples = (f.samples || []).slice();
      var last = state.run.samples[state.run.samples.length - 1];
      if (last && last.job) state.job = last.job;
    } else if (f.t === "sample") {
      var run = adoptRun(f.runId, f.mode, f.ts - f.elapsedSec * 1000);
      run.samples.push(f);
      if (f.job) state.job = f.job;
    } else if (f.t === "batch") {
      adoptRun(f.runId, f.mode, f.ts - f.elapsedSec * 1000).batchSec = f.elapsedSec;
    } else if (f.t === "batch-completed") {
      // stop() can report a run's completion after the next run started; never adopt a stale run.
      if (state.run && state.run.runId === f.runId) {
        state.run.completedSec = f.elapsedSec;
        state.run.completionState = f.state;
        state.run.completion = {
          processed: f.processed, total: f.total, removed: f.removed, incomplete: f.incomplete
        };
        // no sample follows a stop, so the status strip would otherwise stay on "running"
        state.job = { processed: f.processed, total: f.total, removed: f.removed, state: f.state };
      }
    } else if (f.t === "run-stopped") {
      if (state.run && state.run.runId === f.runId) state.run.stopped = true;
    }
    render();
  }

  // ---- rendering ----------------------------------------------------------
  function render() {
    var s = state.seed;
    var ready = !!s && s.state === "ready";
    var seeding = !!s && s.state === "seeding";
    var run = state.run;
    var running = !!run && !run.stopped;

    document.getElementById("st-seed").textContent = s ? s.state : "\\u2026";
    var keysWrap = document.getElementById("st-keys-wrap");
    if (s && (s.cacheKeys || s.indexKeys)) {
      keysWrap.hidden = false;
      var total = (s.cacheKeys || 0) + (s.indexKeys || 0);
      var mem = s.memoryHuman && s.memoryHuman !== "0" ? " \\u00b7 " + s.memoryHuman : "";
      document.getElementById("st-keys").textContent = fmtInt(total) + " keys" + mem;
    } else {
      keysWrap.hidden = true;
    }

    document.getElementById("st-mode").textContent = run
      ? (run.mode === "v1" ? "legacy (KEYS)" : "hashed index") + (run.stopped ? " \\u2014 stopped" : "")
      : "idle";

    document.getElementById("st-elapsed").textContent = run
      ? Math.max(0, Math.round((Date.now() - run.startedAt) / 1000)) + "s"
      : "\\u2014";

    var job = state.job;
    document.getElementById("st-job").textContent = job
      ? fmtInt(job.processed) + " / " + fmtInt(job.total) + " (" + job.state + ")"
      : "\\u2014";

    var connEl = document.getElementById("st-conn");
    connEl.textContent = state.conn;
    connEl.className = "conn-" + state.conn;

    document.getElementById("btn-v1").disabled = !ready || running;
    document.getElementById("btn-v2").disabled = !ready || running;
    document.getElementById("btn-stop").disabled = !running;

    var seedBtn = document.getElementById("btn-seed");
    seedBtn.hidden = ready;
    seedBtn.disabled = seeding;

    var box = document.getElementById("seedbox");
    if (seeding) {
      box.hidden = false;
      var p = state.seedProgress ? state.seedProgress.percent : (s ? s.progress || 0 : 0);
      document.getElementById("seedprog").value = p;
      document.getElementById("seedpct").textContent = Math.round(p * 100) + "%";
    } else {
      box.hidden = true;
    }

    draw();
  }

  // ---- chart ------------------------------------------------------------
  function resize() {
    var dpr = window.devicePixelRatio || 1;
    chart.width = Math.max(1, chart.clientWidth * dpr);
    chart.height = Math.max(1, chart.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  window.addEventListener("resize", resize);

  function draw() {
    var w = chart.clientWidth, h = chart.clientHeight;
    ctx.clearRect(0, 0, w, h);

    var padL = 66, padR = 18, padT = 18, padB = 34;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    if (plotW <= 0 || plotH <= 0) return;

    var run = state.run;
    var samples = run ? run.samples : [];

    var maxX = 30;
    for (var i = 0; i < samples.length; i++) {
      if (samples[i].elapsedSec > maxX) maxX = samples[i].elapsedSec;
    }
    if (run && run.completedSec != null && run.completedSec > maxX) maxX = Math.ceil(run.completedSec);

    var yMin = 0.1, yMax = 100;
    for (var j = 0; j < samples.length; j++) {
      if (samples[j].latencyMs > yMax) yMax = samples[j].latencyMs;
    }
    yMax = Math.pow(10, Math.ceil(Math.log(yMax) / Math.LN10));
    var logMin = Math.log(yMin) / Math.LN10;
    var logMax = Math.log(yMax) / Math.LN10;

    function X(sec) { return padL + (sec / maxX) * plotW; }
    function Y(ms) {
      var v = Math.max(ms, yMin);
      return padT + plotH - ((Math.log(v) / Math.LN10 - logMin) / (logMax - logMin)) * plotH;
    }

    // y grid — one line per power of ten (the log scale made visible)
    ctx.strokeStyle = "#1e2a36";
    ctx.fillStyle = "#7d8ea0";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (var e = Math.ceil(logMin); e <= logMax + 1e-9; e++) {
      var yy = Y(Math.pow(10, e));
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(w - padR, yy);
      ctx.stroke();
      ctx.fillText(powLabel(Math.pow(10, e)), padL - 8, yy);
    }

    // x axis
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var xstep = maxX <= 30 ? 5 : (maxX <= 120 ? 15 : (maxX <= 600 ? 60 : 300));
    for (var xs = 0; xs <= maxX + 1e-9; xs += xstep) {
      ctx.fillText(xs + "s", X(xs), h - padB + 6);
    }

    // markers: dispatch, then completion — dashed, full plot height
    function marker(x, color) {
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    var batchLabel = null; // { x, width } of the dispatch label, for the collision check
    if (run && run.batchSec != null) {
      var bx = X(run.batchSec);
      var bText = "eviction batch dispatched";
      var bWidth = ctx.measureText(bText).width;
      marker(bx, C_BATCH);
      ctx.fillStyle = C_BATCH;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(bText, Math.min(bx + 4, w - padR - bWidth), padT + 2);
      batchLabel = { x: bx, width: bWidth };
    }

    if (run && run.completedSec != null) {
      var cx = X(run.completedSec);
      var cColor = COMPLETION_COLORS[run.completionState] || C_FAILED;
      var cText = completionLabel(run);
      var cWidth = ctx.measureText(cText).width;
      marker(cx, cColor);
      ctx.fillStyle = cColor;
      ctx.textBaseline = "top";
      // On v2 the two lines are a fraction of a second apart: drop to a second row rather than overlap.
      var cRowY = batchLabel && Math.abs(cx - batchLabel.x) < batchLabel.width + 8 ? padT + 16 : padT + 2;
      if (cx + 4 + cWidth > w - padR) {
        ctx.textAlign = "right";
        ctx.fillText(cText, Math.max(cx - 4, padL + cWidth), cRowY);
      } else {
        ctx.textAlign = "left";
        ctx.fillText(cText, cx + 4, cRowY);
      }
    }

    if (!samples.length) {
      ctx.fillStyle = "#5b6b7b";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        run ? "waiting for the first sample\\u2026" : "no run yet \\u2014 pick a measurement above",
        padL + plotW / 2, padT + plotH / 2
      );
      return;
    }

    var lineColor = run.mode === "v1" ? C_V1 : C_V2;

    // connecting line
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (var k = 0; k < samples.length; k++) {
      var px = X(samples[k].elapsedSec), py = Y(samples[k].latencyMs);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // points — timeouts (ok:false) drawn as a distinct hollow red cross
    for (var m = 0; m < samples.length; m++) {
      var sx = X(samples[m].elapsedSec), sy = Y(samples[m].latencyMs);
      if (samples[m].ok === false) {
        ctx.strokeStyle = C_V1;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(sx - 3.5, sy - 3.5); ctx.lineTo(sx + 3.5, sy + 3.5);
        ctx.moveTo(sx + 3.5, sy - 3.5); ctx.lineTo(sx - 3.5, sy + 3.5);
        ctx.stroke();
      } else {
        ctx.fillStyle = lineColor;
        ctx.beginPath();
        ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ---- controls --------------------------------------------------------
  document.getElementById("btn-v1").onclick = function () { post("/api/run", { mode: "v1" }); };
  document.getElementById("btn-v2").onclick = function () { post("/api/run", { mode: "v2" }); };
  document.getElementById("btn-stop").onclick = function () { post("/api/run/stop"); };
  document.getElementById("btn-seed").onclick = function () {
    post("/api/seed").then(function () { setTimeout(refreshStatus, 300); });
  };

  // elapsed / job state tick even between frames
  setInterval(render, 1000);

  resize();
  connect();
})();
</script>
</body>
</html>
`;
