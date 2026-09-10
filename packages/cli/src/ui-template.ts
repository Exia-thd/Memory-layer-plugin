/**
 * The viewer, as one HTML file with the data baked in.
 *
 * No server, no build step, no framework. It opens from the filesystem, which is
 * the difference between a thing people look at and a thing they mean to set up
 * one day.
 *
 * Read-only on purpose. Every write in this system is a short-lived process, and
 * that is what lets several sessions run at once without fighting over the store;
 * a page holding a write connection would break exactly that. Where an action
 * would change something, the page hands you the command instead.
 */

/** Pinned, not floated. A range would let the graph change shape on its own. */
const FORCE_GRAPH_3D = 'https://cdn.jsdelivr.net/npm/3d-force-graph@1.80.0/dist/3d-force-graph.min.js';

export interface UiPayload {
  project: string;
  generatedAt: string;
  stats: { nodes: number; edges: number; symbols: number; files: number };
  health: Array<{ name: string; status: string; detail: string }>;
  graph: {
    nodes: Array<{ id: string; label: string; kind: string; group: string; detail?: string }>;
    links: Array<{ source: string; target: string; kind: string }>;
  };
  memories: Array<{
    id: string;
    layer: string;
    title: string;
    body: string;
    sourceRef: string;
    importance: number;
    ageDays: number;
    edges: number;
    contested: boolean;
  }>;
  truncated: { nodes: number } | null;
}

export function renderUi(payload: UiPayload): string {
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(payload.project)} — memory</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --line: #21262d; --ink: #e6edf3;
    --muted: #8b949e; --accent: #2f81f7; --warn: #d29922; --bad: #f85149;
    --semantic: #a371f7; --episodic: #3fb950; --procedural: #db6d28; --artifact: #58a6ff;
    --mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
    padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--panel); }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  .sub { color: var(--muted); font-size: 12px; font-family: var(--mono); }
  nav { margin-left: auto; display: flex; gap: 4px; }
  nav button { background: transparent; color: var(--muted); border: 1px solid transparent;
    padding: 5px 12px; border-radius: 6px; cursor: pointer; font: inherit; }
  nav button[aria-selected="true"] { background: var(--bg); color: var(--ink); border-color: var(--line); }
  nav button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  main { position: relative; height: calc(100vh - 52px); }
  section { display: none; height: 100%; }
  section[data-active] { display: block; }

  #graph { width: 100%; height: 100%; }
  .legend { position: absolute; left: 14px; bottom: 14px; background: rgba(22,27,34,.92);
    border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; font-size: 12px; }
  .legend div { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .hint { position: absolute; right: 14px; top: 14px; color: var(--muted); font-size: 12px;
    background: rgba(22,27,34,.92); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
  #fallback { display: none; padding: 40px; max-width: 620px; }
  #fallback code { font-family: var(--mono); background: var(--panel); padding: 2px 6px; border-radius: 4px; }

  .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 420px); height: 100%; }
  .list { overflow: auto; border-right: 1px solid var(--line); }
  .controls { display: flex; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line);
    position: sticky; top: 0; background: var(--bg); flex-wrap: wrap; }
  .controls input, .controls select { background: var(--panel); color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px; padding: 5px 9px; font: inherit; }
  .controls input { flex: 1; min-width: 180px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); font-weight: 500; padding: 8px 14px; border-bottom: 1px solid var(--line); }
  td { padding: 8px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--panel); }
  tbody tr[aria-selected="true"] { background: var(--panel); }
  .pill { font-family: var(--mono); font-size: 11px; padding: 1px 7px; border-radius: 999px;
    border: 1px solid currentColor; white-space: nowrap; }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; }
  .detail { overflow: auto; padding: 16px 18px; }
  .detail h2 { font-size: 15px; margin: 0 0 4px; }
  .detail pre { white-space: pre-wrap; word-break: break-word; background: var(--panel);
    border: 1px solid var(--line); border-radius: 8px; padding: 12px; font-family: var(--mono); font-size: 12px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 12px; margin: 12px 0; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; font-family: var(--mono); word-break: break-all; }
  .empty { color: var(--muted); padding: 40px 18px; }

  .health { padding: 14px 18px; }
  .health div { display: grid; grid-template-columns: 150px 60px 1fr; gap: 12px;
    padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 13px; align-items: start; }
  .health .st { font-family: var(--mono); font-size: 11px; }
  .ok { color: var(--episodic); } .warn { color: var(--warn); } .fail { color: var(--bad); }
  .note { color: var(--muted); font-size: 12px; padding: 0 18px 18px; max-width: 70ch; }
  .note code { font-family: var(--mono); background: var(--panel); padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(payload.project)}</h1>
  <span class="sub">${payload.stats.nodes} memories · ${payload.stats.symbols} declarations · ${payload.stats.files} files · ${escapeHtml(payload.generatedAt.slice(0, 16).replace('T', ' '))}</span>
  <nav role="tablist">
    <button role="tab" aria-selected="true" data-tab="graph">Graph</button>
    <button role="tab" aria-selected="false" data-tab="memories">Memories</button>
    <button role="tab" aria-selected="false" data-tab="health">Health</button>
  </nav>
</header>

<main>
  <section data-panel="graph" data-active>
    <div id="graph"></div>
    <div class="hint">drag to orbit · scroll to zoom · click a node</div>
    <div class="legend">
      <div><span class="dot" style="background:#8b949e"></span> file</div>
      <div><span class="dot" style="background:#e6edf3"></span> declaration</div>
      <div><span class="dot" style="background:var(--semantic)"></span> semantic</div>
      <div><span class="dot" style="background:var(--episodic)"></span> episodic</div>
      <div><span class="dot" style="background:var(--procedural)"></span> procedural</div>
      <div><span class="dot" style="background:var(--artifact)"></span> artifact</div>
    </div>
    <div id="fallback">
      <h2>The 3D view could not load</h2>
      <p>It is fetched from a CDN, so this page needs a network the first time it
        is opened. The other tabs work regardless — they carry their data inline.</p>
      <p>For a diagram that needs nothing at all: <code>memory map --format mermaid</code></p>
    </div>
  </section>

  <section data-panel="memories">
    <div class="split">
      <div class="list">
        <div class="controls">
          <input id="q" type="search" placeholder="Filter by title, body or path" aria-label="Filter memories">
          <select id="layer" aria-label="Filter by layer">
            <option value="">every layer</option>
            <option value="semantic">semantic</option>
            <option value="episodic">episodic</option>
            <option value="procedural">procedural</option>
            <option value="artifact">artifact</option>
          </select>
          <select id="sort" aria-label="Sort">
            <option value="importance">most important</option>
            <option value="age">newest</option>
            <option value="edges">most connected</option>
          </select>
        </div>
        <table>
          <thead><tr><th>Layer</th><th>Title</th><th class="num">Imp</th><th class="num">Age</th><th class="num">Links</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
        <p class="empty" id="none" hidden>Nothing matches that filter.</p>
      </div>
      <div class="detail" id="detail"><p class="empty">Select a memory.</p></div>
    </div>
  </section>

  <section data-panel="health">
    <div class="health" id="health"></div>
    <p class="note">
      This page is read-only. Every write in this system is a short-lived process,
      which is what lets several sessions run at once without fighting over the
      store — a page holding a write connection would break that. To change
      something, run the command: <code>memory prune</code>,
      <code>memory ingest --force</code>, <code>memory embed --force</code>,
      <code>memory merge</code>. Re-run <code>memory ui</code> afterwards; this
      file is a snapshot, not a live view.
    </p>
  </section>
</main>

<script>window.__MEMORY__ = ${data};</script>
<script src="${FORCE_GRAPH_3D}" onerror="window.__GRAPH_FAILED__ = true"></script>
<script>
(function () {
  var data = window.__MEMORY__;

  // ---- tabs ----
  var buttons = document.querySelectorAll('nav button');
  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      buttons.forEach(function (other) { other.setAttribute('aria-selected', String(other === button)); });
      document.querySelectorAll('section').forEach(function (section) {
        if (section.dataset.panel === button.dataset.tab) section.setAttribute('data-active', '');
        else section.removeAttribute('data-active');
      });
    });
  });

  // ---- graph ----
  var COLOR = {
    file: '#8b949e', symbol: '#e6edf3',
    semantic: '#a371f7', episodic: '#3fb950', procedural: '#db6d28', artifact: '#58a6ff',
  };

  if (window.__GRAPH_FAILED__ || typeof ForceGraph3D !== 'function') {
    // Said out loud. A blank canvas reads as "there is nothing in the graph",
    // which is a different and much worse message than "the library is missing".
    document.getElementById('graph').style.display = 'none';
    document.getElementById('fallback').style.display = 'block';
  } else {
    var graph = ForceGraph3D()(document.getElementById('graph'))
      .backgroundColor('#0d1117')
      .graphData({
        nodes: data.graph.nodes.map(function (n) { return Object.assign({}, n); }),
        links: data.graph.links.map(function (l) { return Object.assign({}, l); }),
      })
      .nodeLabel(function (n) { return n.label + (n.detail ? '\\n' + n.detail : ''); })
      .nodeColor(function (n) { return COLOR[n.group] || '#8b949e'; })
      .nodeVal(function (n) { return n.group === 'file' ? 6 : n.group === 'symbol' ? 3 : 2; })
      .linkColor(function (l) { return l.kind === 'CONTRADICTS' ? '#f85149' : '#30363d'; })
      .linkWidth(function (l) { return l.kind === 'CONTRADICTS' ? 2 : 0.5; })
      .linkOpacity(0.5)
      .onNodeClick(function (node) {
        // Fly to it, then show the memory behind it if there is one.
        var distance = 90;
        var ratio = 1 + distance / Math.hypot(node.x || 1, node.y || 1, node.z || 1);
        graph.cameraPosition(
          { x: (node.x || 0) * ratio, y: (node.y || 0) * ratio, z: (node.z || 0) * ratio },
          node, 900,
        );
        var memory = data.memories.find(function (m) { return m.id === node.id; });
        if (memory) { select(memory); document.querySelector('nav button[data-tab="memories"]').click(); }
      });

    window.addEventListener('resize', function () {
      graph.width(window.innerWidth).height(window.innerHeight - 52);
    });
    graph.width(window.innerWidth).height(window.innerHeight - 52);
  }

  // ---- memories ----
  var rows = document.getElementById('rows');
  var none = document.getElementById('none');
  var detail = document.getElementById('detail');
  var q = document.getElementById('q');
  var layer = document.getElementById('layer');
  var sort = document.getElementById('sort');
  var selected = null;

  function text(value) { return String(value == null ? '' : value); }

  function visible() {
    var needle = q.value.trim().toLowerCase();
    var want = layer.value;
    var list = data.memories.filter(function (m) {
      if (want && m.layer !== want) return false;
      if (!needle) return true;
      return (m.title + ' ' + m.body + ' ' + m.sourceRef).toLowerCase().indexOf(needle) !== -1;
    });
    var key = sort.value;
    return list.sort(function (a, b) {
      if (key === 'age') return a.ageDays - b.ageDays;
      if (key === 'edges') return b.edges - a.edges;
      return b.importance - a.importance;
    });
  }

  function select(memory) {
    selected = memory.id;
    detail.innerHTML =
      '<h2></h2><div class="kv"></div><pre></pre>';
    detail.querySelector('h2').textContent = memory.title;
    var kv = detail.querySelector('.kv');
    [['layer', memory.layer], ['source', memory.sourceRef], ['importance', memory.importance],
     ['age', memory.ageDays + ' days'], ['links', memory.edges],
     ['contested', memory.contested ? 'yes — a person settles this' : 'no'],
     ['id', memory.id]].forEach(function (pair) {
      var dt = document.createElement('dt'); dt.textContent = pair[0];
      var dd = document.createElement('dd'); dd.textContent = text(pair[1]);
      kv.appendChild(dt); kv.appendChild(dd);
    });
    detail.querySelector('pre').textContent = memory.body;
    render();
  }

  function render() {
    var list = visible();
    rows.textContent = '';
    none.hidden = list.length > 0;

    list.forEach(function (memory) {
      var tr = document.createElement('tr');
      if (memory.id === selected) tr.setAttribute('aria-selected', 'true');

      var layerCell = document.createElement('td');
      var pill = document.createElement('span');
      pill.className = 'pill';
      pill.style.color = COLOR[memory.layer] || '#8b949e';
      pill.textContent = memory.layer;
      layerCell.appendChild(pill);

      var titleCell = document.createElement('td');
      titleCell.textContent = memory.title;
      if (memory.contested) {
        var flag = document.createElement('span');
        flag.className = 'pill'; flag.style.color = '#f85149';
        flag.style.marginLeft = '8px'; flag.textContent = 'contested';
        titleCell.appendChild(flag);
      }

      [layerCell, titleCell].forEach(function (cell) { tr.appendChild(cell); });
      [memory.importance, memory.ageDays + 'd', memory.edges].forEach(function (value) {
        var cell = document.createElement('td');
        cell.className = 'num';
        cell.textContent = text(value);
        tr.appendChild(cell);
      });

      tr.addEventListener('click', function () { select(memory); });
      rows.appendChild(tr);
    });
  }

  [q, layer, sort].forEach(function (control) { control.addEventListener('input', render); });
  render();

  // ---- health ----
  var health = document.getElementById('health');
  data.health.forEach(function (check) {
    var row = document.createElement('div');
    var name = document.createElement('span'); name.textContent = check.name;
    var status = document.createElement('span');
    status.className = 'st ' + (check.status === 'ok' ? 'ok' : check.status === 'warn' ? 'warn' : 'fail');
    status.textContent = check.status.toUpperCase();
    var note = document.createElement('span'); note.textContent = check.detail;
    row.appendChild(name); row.appendChild(status); row.appendChild(note);
    health.appendChild(row);
  });

  if (data.truncated) {
    var warning = document.createElement('div');
    warning.innerHTML = '<span>snapshot</span><span class="st warn">WARN</span>';
    var note = document.createElement('span');
    note.textContent = 'Showing ' + data.graph.nodes.length + ' of ' + data.truncated.nodes +
      ' nodes. Narrow it with a path: memory ui src/store';
    warning.appendChild(note);
    health.appendChild(warning);
  }
}());
</script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
