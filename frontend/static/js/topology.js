/* topology.js — D3 force-directed topology visualizer */

const API_BASE = "http://localhost:8000";

const COLOR = {
  router:   "#38bdf8",
  firewall: "#f97316",
  switch:   "#a78bfa",
  unknown:  "#94a3b8",
};

const RADIUS = {
  router: 22,
  firewall: 24,
  switch: 20,
  unknown: 18,
};

// ── State ──────────────────────────────────────────────────────
let topologyData = null;
let simulation = null;
let selectedNode = null;

// ── DOM refs ───────────────────────────────────────────────────
const fileInput     = document.getElementById("fileInput");
const uploadZone    = document.getElementById("uploadZone");
const fileList      = document.getElementById("fileList");
const parseBtn      = document.getElementById("parseBtn");
const demoBtn       = document.getElementById("demoBtn");
const emptyState    = document.getElementById("emptyState");
const toolbar       = document.getElementById("toolbar");
const statsSection  = document.getElementById("statsSection");
const legendSection = document.getElementById("legendSection");
const devicePanel   = document.getElementById("devicePanel");
const tooltip       = document.getElementById("tooltip");

// ── File upload UX ─────────────────────────────────────────────
let selectedFiles = [];

uploadZone.addEventListener("dragover", e => { e.preventDefault(); uploadZone.classList.add("bg-slate-100", "dark:bg-slate-700/80", "border-brand-500"); });
uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("bg-slate-100", "dark:bg-slate-700/80", "border-brand-500"));
uploadZone.addEventListener("drop", e => {
  e.preventDefault();
  uploadZone.classList.remove("bg-slate-100", "dark:bg-slate-700/80", "border-brand-500");
  addFiles([...e.dataTransfer.files]);
});
fileInput.addEventListener("change", () => {
  addFiles([...fileInput.files]);
  fileInput.value = "";
});

function addFiles(files) {
  files.forEach(f => {
    if (!selectedFiles.find(x => x.name === f.name)) selectedFiles.push(f);
  });
  renderFileList();
}

function renderFileList() {
  fileList.innerHTML = selectedFiles.map(f =>
    `<div class="flex items-center gap-2 p-2 bg-slate-50 dark:bg-slate-700/50 rounded-md border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-300">
      <svg class="w-4 h-4 text-brand-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
      <span class="truncate">${f.name}</span>
    </div>`
  ).join("");
  parseBtn.disabled = selectedFiles.length === 0;
}

// ── Parse & render ─────────────────────────────────────────────
parseBtn.addEventListener("click", async () => {
  if (!selectedFiles.length) return;
  const formData = new FormData();
  selectedFiles.forEach(f => formData.append("files", f));
  await fetchAndRender("/api/parse", { method: "POST", body: formData });
});

demoBtn.addEventListener("click", async () => {
  await fetchAndRender("/api/parse-demo", { method: "POST" });
});

async function fetchAndRender(url, options) {
  parseBtn.textContent = "Parsing...";
  parseBtn.disabled = true;
  try {
    const res = await fetch(API_BASE + url, options);
    if (!res.ok) {
      const err = await res.json();
      alert("Error: " + (err.detail?.message || JSON.stringify(err.detail)));
      return;
    }
    topologyData = await res.json();
    renderTopology(topologyData);
    updateStats(topologyData);
  } catch (e) {
    alert("Could not connect to backend. Is FastAPI running on port 8000?\n\n" + e.message);
  } finally {
    parseBtn.textContent = "Visualize Topology";
    parseBtn.disabled = selectedFiles.length === 0;
  }
}

// ── Stats ──────────────────────────────────────────────────────
function updateStats(data) {
  const subnets = new Set(data.links.map(l => l.subnet)).size;
  document.getElementById("statDevices").textContent = data.nodes.length;
  document.getElementById("statLinks").textContent = data.links.length;
  document.getElementById("statSubnets").textContent = subnets;
  statsSection.classList.remove("hidden");
  legendSection.classList.remove("hidden");
}

// ── D3 Topology ────────────────────────────────────────────────
function renderTopology(data) {
  emptyState.classList.add("hidden");
  toolbar.classList.remove("hidden");

  const svgEl = document.getElementById("topology");
  svgEl.classList.remove("hidden");
  svgEl.innerHTML = "";

  const W = svgEl.clientWidth || window.innerWidth - 260;
  const H = svgEl.clientHeight || window.innerHeight;

  const svg = d3.select("#topology");

  // Zoom behaviour
  const zoomG = svg.append("g").attr("class", "zoom-group");
  const zoom = d3.zoom()
    .scaleExtent([0.2, 4])
    .on("zoom", e => zoomG.attr("transform", e.transform));
  svg.call(zoom);

  // Toolbar zoom controls
  document.getElementById("btnZoomIn").onclick  = () => svg.transition().call(zoom.scaleBy, 1.3);
  document.getElementById("btnZoomOut").onclick = () => svg.transition().call(zoom.scaleBy, 0.77);
  document.getElementById("btnFit").onclick     = () => svg.transition().call(zoom.transform, d3.zoomIdentity);
  document.getElementById("btnExport").onclick  = exportSVG;

  // Prepare D3 nodes/links (need object references for simulation)
  const nodes = data.nodes.map(d => ({ ...d }));
  const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
  const links = data.links
    .map(l => ({ ...l, source: nodeById[l.source], target: nodeById[l.target] }))
    .filter(l => l.source && l.target);

  // Force simulation
  simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(120))
    .force("charge", d3.forceManyBody().strength(-350))
    .force("center", d3.forceCenter(W / 2, H / 2))
    .force("collision", d3.forceCollide().radius(d => RADIUS[d.device_type] + 18));

  // Draw links
  const linkG = zoomG.append("g").attr("class", "links");
  const linkLines = linkG.selectAll("line")
    .data(links)
    .join("line")
    .attr("class", "link-line");

  // Link labels (subnet)
  const linkLabels = linkG.selectAll("text")
    .data(links)
    .join("text")
    .attr("class", "link-label")
    .text(d => d.subnet || "");

  // Draw nodes
  const nodeG = zoomG.append("g").attr("class", "nodes");
  const nodeGroups = nodeG.selectAll("g")
    .data(nodes)
    .join("g")
    .attr("class", "node-group")
    .call(
      d3.drag()
        .on("start", (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag",  (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end",   (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
    )
    .on("click", (e, d) => { e.stopPropagation(); selectNode(d); })
    .on("mouseover", (e, d) => showTooltip(e, d))
    .on("mousemove", e => moveTooltip(e))
    .on("mouseout", hideTooltip);

  // Device shape: router=circle, firewall=hexagon, switch=rounded-rect, unknown=circle
  nodeGroups.each(function(d) {
    const g = d3.select(this);
    const color = COLOR[d.device_type] || COLOR.unknown;
    const r = RADIUS[d.device_type] || 18;

    if (d.device_type === "firewall") {
      g.append("polygon")
        .attr("points", hexPoints(r))
        .attr("fill", color + "22")
        .attr("stroke", color)
        .attr("stroke-width", 2)
        .attr("class", "node-circle");
    } else if (d.device_type === "switch") {
      g.append("rect")
        .attr("x", -r).attr("y", -r * 0.65)
        .attr("width", r * 2).attr("height", r * 1.3)
        .attr("rx", 5)
        .attr("fill", color + "22")
        .attr("stroke", color)
        .attr("stroke-width", 2)
        .attr("class", "node-circle");
    } else {
      g.append("circle")
        .attr("r", r)
        .attr("fill", color + "22")
        .attr("stroke", color)
        .attr("stroke-width", 2)
        .attr("class", "node-circle");
    }

    // Device type icon (text)
    g.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("font-size", "11px")
      .attr("fill", color)
      .attr("pointer-events", "none")
      .text(deviceIcon(d.device_type));
  });

  // Node labels
  nodeGroups.append("text")
    .attr("class", "node-label")
    .attr("dy", d => (RADIUS[d.device_type] || 18) + 14)
    .text(d => d.hostname);

  // Simulation tick
  simulation.on("tick", () => {
    linkLines
      .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x).attr("y2", d => d.target.y);

    linkLabels
      .attr("x", d => (d.source.x + d.target.x) / 2)
      .attr("y", d => (d.source.y + d.target.y) / 2 - 4);

    nodeGroups.attr("transform", d => `translate(${d.x},${d.y})`);
  });

  // Deselect on canvas click
  svg.on("click", () => deselectNode());
}

// ── Node interaction ───────────────────────────────────────────
function selectNode(d) {
  selectedNode = d;
  devicePanel.classList.remove("hidden");
  document.getElementById("deviceDetail").innerHTML = renderDeviceDetail(d);

  // Highlight selected node
  d3.selectAll(".node-circle").classed("selected", n => n.id === d.id);
}

function deselectNode() {
  selectedNode = null;
  d3.selectAll(".node-circle").classed("selected", false);
  devicePanel.classList.add("hidden");
}

function renderDeviceDetail(d) {
  const typeColors = { router: "#38bdf8", firewall: "#f97316", switch: "#a78bfa", unknown: "#94a3b8" };
  const col = typeColors[d.device_type] || "#94a3b8";

  let html = `
    <div class="mb-4">
      <div class="font-bold text-lg" style="color:${col}">${d.hostname}</div>
      <div class="text-xs text-slate-500 dark:text-slate-400 mt-1">${d.vendor} · ${d.device_type} · <span class="font-mono bg-slate-100 dark:bg-slate-700 px-1 py-0.5 rounded">${d.filename}</span></div>
    </div>
    <div class="space-y-2 max-h-64 overflow-y-auto scrollbar-hide pr-1">
  `;

  if (!d.interfaces || d.interfaces.length === 0) {
    html += `<div class="text-xs italic text-slate-500 dark:text-slate-500">No interfaces parsed.</div>`;
  } else {
    d.interfaces.forEach(i => {
      const isUp = i.status === "up";
      const statusColor = isUp ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800" : "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400 border-rose-200 dark:border-rose-800";
      const dotColor = isUp ? "bg-emerald-500" : "bg-rose-500";
      
      html += `
        <div class="p-2 rounded-md border ${statusColor} text-xs">
          <div class="flex items-center justify-between mb-1">
            <div class="font-semibold flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full ${dotColor}"></span>${i.name}</div>
          </div>
          ${i.ip ? `<div class="font-mono mt-0.5 opacity-90">${i.ip} ${i.subnet ? `<span class="opacity-70">/ ${i.subnet}</span>` : ""}</div>` : ""}
          ${i.description ? `<div class="mt-1 opacity-80 italic">${i.description}</div>` : ""}
          ${i.nameif ? `<div class="mt-1 flex items-center gap-2"><span class="px-1.5 py-0.5 bg-black/5 dark:bg-white/10 rounded text-[10px] font-medium tracking-wider uppercase">${i.nameif}</span>${i.security_level !== null ? `<span class="opacity-70 text-[10px]">sec ${i.security_level}</span>` : ""}</div>` : ""}
        </div>`;
    });
  }

  html += `</div>`;
  return html;
}

// ── Tooltip ────────────────────────────────────────────────────
function showTooltip(e, d) {
  const ifaces = d.interfaces || [];
  const upCount = ifaces.filter(i => i.status === "up").length;
  tooltip.innerHTML = `
    <div class="font-bold text-sm mb-1">${d.hostname}</div>
    <div class="flex flex-col gap-0.5 opacity-90">
      <div><span class="opacity-70">Type:</span> ${d.device_type}</div>
      <div><span class="opacity-70">Vendor:</span> ${d.vendor}</div>
      <div><span class="opacity-70">Interfaces:</span> ${ifaces.length} (${upCount} up)</div>
    </div>
  `;
  tooltip.classList.remove('hidden');
  moveTooltip(e);
}

function moveTooltip(e) {
  const rect = document.querySelector("main").getBoundingClientRect();
  tooltip.style.left = (e.clientX - rect.left + 14) + "px";
  tooltip.style.top  = (e.clientY - rect.top  + 14) + "px";
}

function hideTooltip() {
  tooltip.classList.add('hidden');
}

// ── Helpers ────────────────────────────────────────────────────
function hexPoints(r) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    return `${r * Math.cos(a)},${r * Math.sin(a)}`;
  }).join(" ");
}

function deviceIcon(type) {
  return { router: "R", firewall: "FW", switch: "SW", unknown: "?" }[type] || "?";
}

function exportSVG() {
  const svgEl = document.getElementById("topology");
  const data = new XMLSerializer().serializeToString(svgEl);
  const blob = new Blob([data], { type: "image/svg+xml" });
  const url  = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: "topology.svg" });
  a.click();
  URL.revokeObjectURL(url);
}