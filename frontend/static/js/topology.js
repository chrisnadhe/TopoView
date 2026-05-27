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

const DEVICE_TYPES = ["router", "firewall", "switch", "unknown"];

// ── State ──────────────────────────────────────────────────────
let topologyData = null;
let simulation = null;
let selectedNode = null;
let linkEditMode = false;
let linkDragSource = null;
let manualLinks = [];
let parsedLinks = [];   // module-level so deleteLink can mutate it
let linkG = null;       // module-level D3 selection for link group
let svgSelection = null;
let zoomGroupSelection = null;
let allNodesData = [];
let allLinksData = [];
let nodeGroupsSel = null;
let linkLinesSel = null;
let linkLabelsSel = null;
let portLabelsSrcSel = null;
let portLabelsDstSel = null;

// Global type-level stencil icons (apply to all nodes of that type unless overridden per-node)
const typeIcons = { router: null, firewall: null, switch: null, unknown: null };

// Current layout mode: "force" | "hierarchical" | "circular" | "free"
let layoutMode = "force";

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
    manualLinks = []; // reset manual links on new parse
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

  // Remove any existing label editor
  const existingEditor = document.getElementById("nodeLabelEditor");
  if (existingEditor) existingEditor.remove();

  const W = svgEl.clientWidth || window.innerWidth - 260;
  const H = svgEl.clientHeight || window.innerHeight;

  svgSelection = d3.select("#topology");
  const svg = svgSelection;

  // Zoom behaviour
  zoomGroupSelection = svg.append("g").attr("class", "zoom-group");
  const zoomG = zoomGroupSelection;
  const zoom = d3.zoom()
    .scaleExtent([0.2, 4])
    .on("zoom", e => zoomG.attr("transform", e.transform));
  svg.call(zoom);

  // Toolbar zoom controls
  document.getElementById("btnZoomIn").onclick  = () => svg.transition().call(zoom.scaleBy, 1.3);
  document.getElementById("btnZoomOut").onclick = () => svg.transition().call(zoom.scaleBy, 0.77);
  document.getElementById("btnFit").onclick     = () => svg.transition().call(zoom.transform, d3.zoomIdentity);
  document.getElementById("btnExport").onclick  = exportSVG;

  // ── Link Edit Mode toggle ──────────────────────────────────
  const btnLinkEdit = document.getElementById("btnLinkEdit");
  if (btnLinkEdit) {
    btnLinkEdit.onclick = () => {
      linkEditMode = !linkEditMode;
      updateLinkEditMode(btnLinkEdit, svg);
    };
  }

  // Prepare D3 nodes/links (need object references for simulation)
  const nodes = data.nodes.map(d => ({ ...d, label: d.label || null, note: d.note || null, customIcon: d.customIcon || null }));
  const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
  allNodesData = nodes;

  parsedLinks = data.links
    .map(l => ({ ...l, source: nodeById[l.source], target: nodeById[l.target] }))
    .filter(l => l.source && l.target);

  allLinksData = parsedLinks;

  // Force simulation
  simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(parsedLinks).id(d => d.id).distance(130))
    .force("charge", d3.forceManyBody().strength(-400))
    .force("center", d3.forceCenter(W / 2, H / 2))
    .force("collision", d3.forceCollide().radius(d => RADIUS[d.device_type] + 22));

  // ── Draw links layer ───────────────────────────────────────
  linkG = zoomG.append("g").attr("class", "links");

  // Rubber-band line for link drawing mode
  const rubberBand = zoomG.append("line")
    .attr("class", "rubber-band")
    .attr("stroke", "#f59e0b")
    .attr("stroke-width", 2)
    .attr("stroke-dasharray", "6,4")
    .attr("opacity", 0)
    .attr("pointer-events", "none");

  function buildAllLinks() {
    return [...parsedLinks, ...manualLinks];
  }

  function redrawLinks() {
    const allLinks = buildAllLinks();

    // Link lines
    const lines = linkG.selectAll("line.link-line")
      .data(allLinks, d => `${d.source.id || d.source}-${d.target.id || d.target}-${d.subnet || "manual"}`);

    const linesEnter = lines.enter().append("line").attr("class", "link-line");
    linkLinesSel = linesEnter.merge(lines);
    lines.exit().remove();

    linkLinesSel = linkG.selectAll("line.link-line");
    linkLinesSel
      .attr("stroke-dasharray", d => (d.link_type === "subnet") ? "4,4" : (d.link_type === "manual") ? "8,5" : "none")
      .attr("stroke-width", d => d.link_type === "cdp" ? 2.5 : d.link_type === "manual" ? 2 : 1.5)
      .attr("stroke", d => d.link_type === "manual" ? "#f59e0b" : null)
      .attr("class", d => `link-line${d.link_type === "manual" ? " manual-link" : ""}`)
      .style("cursor", "context-menu")
      .on("contextmenu", (e, d) => {
        e.preventDefault();
        showLinkContextMenu(e, d);
      });

    // Subnet / CDP labels at midpoint
    const midLabels = linkG.selectAll("text.link-label")
      .data(allLinks, d => `mid-${d.source.id || d.source}-${d.target.id || d.target}`);
    const midEnter = midLabels.enter().append("text").attr("class", "link-label");
    midLabels.exit().remove();
    linkLabelsSel = midEnter.merge(midLabels);
    linkLabelsSel = linkG.selectAll("text.link-label");
    linkLabelsSel.text(d => {
      if (d.link_type === "cdp") return "CDP/LLDP";
      if (d.link_type === "manual") return d.manual_label || "Manual";
      return d.subnet || "";
    });

    // Port labels — source side (near source node)
    const srcLabels = linkG.selectAll("text.port-label-src")
      .data(allLinks, d => `src-${d.source.id || d.source}-${d.target.id || d.target}`);
    const srcEnter = srcLabels.enter().append("text").attr("class", "port-label-src link-port-label");
    srcLabels.exit().remove();
    portLabelsSrcSel = srcEnter.merge(srcLabels);
    portLabelsSrcSel = linkG.selectAll("text.port-label-src");
    portLabelsSrcSel.text(d => d.source_iface || "");

    // Port labels — target side (near target node)
    const dstLabels = linkG.selectAll("text.port-label-dst")
      .data(allLinks, d => `dst-${d.source.id || d.source}-${d.target.id || d.target}`);
    const dstEnter = dstLabels.enter().append("text").attr("class", "port-label-dst link-port-label");
    dstLabels.exit().remove();
    portLabelsDstSel = dstEnter.merge(dstLabels);
    portLabelsDstSel = linkG.selectAll("text.port-label-dst");
    portLabelsDstSel.text(d => d.target_iface || "");
  }

  redrawLinks();

  // ── Draw nodes ────────────────────────────────────────────
  const nodeG = zoomG.append("g").attr("class", "nodes");
  const nodeGroups = nodeG.selectAll("g")
    .data(nodes)
    .join("g")
    .attr("class", "node-group");

  nodeGroupsSel = nodeGroups;

  // Drag behaviour — adapts to current layoutMode
  const normalDrag = d3.drag()
    .on("start", (e, d) => {
      if (linkEditMode) return;
      if (layoutMode === "force") {
        if (!e.active) simulation.alphaTarget(0.3).restart();
      }
      d.fx = d.x; d.fy = d.y;
    })
    .on("drag", (e, d) => {
      if (linkEditMode) return;
      d.fx = e.x; d.fy = e.y;
      d.x  = e.x; d.y  = e.y;
      if (layoutMode !== "force") applyTick(); // manual position update
    })
    .on("end", (e, d) => {
      if (linkEditMode) return;
      if (layoutMode === "force") {
        if (!e.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null; // release pin in force mode
      }
      // non-force modes: keep fx/fy so node stays where dropped
    });

  nodeGroups.call(normalDrag);

  // Click → select node (only in normal mode)
  nodeGroups.on("click", (e, d) => {
    if (linkEditMode) return;
    e.stopPropagation();
    selectNode(d);
  });

  // Double-click → label editor
  nodeGroups.on("dblclick", (e, d) => {
    e.stopPropagation();
    openLabelEditor(e, d, svg, zoom);
  });

  // Tooltip
  nodeGroups
    .on("mouseover", (e, d) => { if (!linkEditMode) showTooltip(e, d); })
    .on("mousemove", e => moveTooltip(e))
    .on("mouseout", hideTooltip);

  // ── Link Edit Mode — draw link on drag over nodes ──────────
  nodeGroups.on("mousedown.linkEdit", (e, d) => {
    if (!linkEditMode) return;
    e.stopPropagation();
    linkDragSource = d;
    hideTooltip();

    // Get SVG coordinates
    const [mx, my] = d3.pointer(e, zoomG.node());
    rubberBand
      .attr("x1", d.x).attr("y1", d.y)
      .attr("x2", mx).attr("y2", my)
      .attr("opacity", 1);
  });

  svg.on("mousemove.linkEdit", (e) => {
    if (!linkEditMode || !linkDragSource) return;
    const [mx, my] = d3.pointer(e, zoomG.node());
    rubberBand.attr("x2", mx).attr("y2", my);
  });

  nodeGroups.on("mouseup.linkEdit", (e, d) => {
    if (!linkEditMode || !linkDragSource) return;
    if (d.id === linkDragSource.id) {
      cancelLinkDraw(rubberBand);
      return;
    }
    // Create manual link
    const src = linkDragSource;
    const tgt = d;
    cancelLinkDraw(rubberBand);

    showManualLinkDialog(src, tgt, () => {
      redrawLinks();
      simulation.alpha(0.1).restart();
    });
  });

  svg.on("mouseup.linkEdit", (e) => {
    if (!linkEditMode) return;
    const target = e.target;
    // If mouseup landed on the SVG background (not a node), cancel
    if (!target.closest(".node-group")) {
      cancelLinkDraw(rubberBand);
    }
  });

  // Device shapes — drawn via helper so they can be redrawn on edit
  nodeGroups.each(function(d) { updateNodeAppearance(d3.select(this), d); });

  // Node labels (hostname / custom label)
  nodeGroups.append("text")
    .attr("class", "node-label")
    .attr("dy", d => (RADIUS[d.device_type] || 18) + 14)
    .text(d => d.label || d.hostname);

  // Note indicator (small italic annotation below label)
  nodeGroups.append("text")
    .attr("class", "node-note")
    .attr("dy", d => (RADIUS[d.device_type] || 18) + 25)
    .attr("text-anchor", "middle")
    .attr("font-size", "9px")
    .attr("fill", "#f59e0b")
    .attr("font-style", "italic")
    .attr("pointer-events", "none")
    .text(d => d.note ? `📝 ${d.note.slice(0, 20)}${d.note.length > 20 ? "…" : ""}` : "");

  // Simulation tick — calls shared applyTick()
  simulation.on("tick", applyTick);

  // Wire layout mode buttons
  initLayoutButtons();

  // Deselect on canvas click
  svg.on("click", () => {
    if (!linkEditMode) deselectNode();
    closeLinkContextMenu();
  });

  function buildAllLinks() {
    const manualMapped = manualLinks.map(l => ({
      ...l,
      source: typeof l.source === "object" ? l.source : nodeById[l.source],
      target: typeof l.target === "object" ? l.target : nodeById[l.target],
    }));
    return [...parsedLinks, ...manualMapped];
  }
}

// ── Link Edit Mode helpers ─────────────────────────────────────
function cancelLinkDraw(rubberBand) {
  linkDragSource = null;
  rubberBand.attr("opacity", 0);
}

function updateLinkEditMode(btn, svg) {
  const svgEl = document.getElementById("topology");
  if (linkEditMode) {
    btn.classList.add("bg-amber-500", "text-white");
    btn.classList.remove("text-slate-600", "dark:text-slate-300");
    svgEl.style.cursor = "crosshair";
  } else {
    btn.classList.remove("bg-amber-500", "text-white");
    btn.classList.add("text-slate-600", "dark:text-slate-300");
    svgEl.style.cursor = "";
    linkDragSource = null;
  }
}

// Context menu for deleting any link
let contextMenuEl = null;

function showLinkContextMenu(e, d) {
  closeLinkContextMenu();
  const menu = document.createElement("div");
  menu.id = "linkContextMenu";
  menu.className = "fixed z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl text-sm overflow-hidden";
  menu.style.left = e.clientX + "px";
  menu.style.top = e.clientY + "px";

  const typeLabel = d.link_type === "manual" ? "Manual Link" : d.link_type === "cdp" ? "CDP / LLDP Link" : "Subnet Link";
  const subnetRow = (d.subnet && d.link_type !== "manual")
    ? `<div class="px-4 py-1 text-[10px] font-mono text-slate-400 dark:text-slate-500">${d.subnet}</div>`
    : "";
  const srcInfo = (d.source_iface || d.target_iface)
    ? `<div class="px-4 pb-1 text-[10px] font-mono text-blue-400">${d.source_iface || "—"} ↔ ${d.target_iface || "—"}</div>`
    : "";

  menu.innerHTML = `
    <div class="px-4 py-2 text-xs font-semibold text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-700">${typeLabel}</div>
    ${subnetRow}${srcInfo}
    <button id="ctxDeleteLink" class="w-full text-left px-4 py-2 hover:bg-rose-50 dark:hover:bg-rose-900/20 text-rose-600 dark:text-rose-400 flex items-center gap-2">
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
      Delete Link
    </button>
  `;
  document.body.appendChild(menu);
  contextMenuEl = menu;

  document.getElementById("ctxDeleteLink").addEventListener("click", () => deleteLink(d));
}

function deleteLink(d) {
  closeLinkContextMenu();

  // Remove from the correct data array
  if (d.link_type === "manual") {
    manualLinks = manualLinks.filter(l => l !== d);
  } else {
    parsedLinks = parsedLinks.filter(l => l !== d);
  }

  // Update force simulation to drop the link
  if (simulation) {
    const remaining = [
      ...parsedLinks,
      ...manualLinks.map(l => ({
        ...l,
        source: typeof l.source === "object" ? l.source : allNodesData.find(n => n.id === l.source),
        target: typeof l.target === "object" ? l.target : allNodesData.find(n => n.id === l.target),
      }))
    ];
    simulation.force("link").links(remaining);
    simulation.alpha(0.05).restart();
  }

  // Directly remove SVG elements bound to this datum — no full re-render
  if (linkG) {
    linkG.selectAll("line.link-line").filter(l => l === d).remove();
    linkG.selectAll("text.link-label").filter(l => l === d).remove();
    linkG.selectAll("text.port-label-src").filter(l => l === d).remove();
    linkG.selectAll("text.port-label-dst").filter(l => l === d).remove();
  }
}

function closeLinkContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

// ── Manual Link Dialog ─────────────────────────────────────────
function showManualLinkDialog(src, tgt, onComplete) {
  const existing = document.getElementById("manualLinkDialog");
  if (existing) existing.remove();

  const dialog = document.createElement("div");
  dialog.id = "manualLinkDialog";
  dialog.className = "fixed inset-0 z-50 flex items-center justify-center";
  dialog.innerHTML = `
    <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" id="manualLinkBackdrop"></div>
    <div class="relative bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 p-6 w-80 z-10">
      <h3 class="font-bold text-slate-900 dark:text-white mb-1">Add Manual Link</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400 mb-4">
        <span class="font-medium text-brand-400">${src.hostname}</span>
        <svg class="inline w-3 h-3 mx-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/></svg>
        <span class="font-medium text-brand-400">${tgt.hostname}</span>
      </p>
      <div class="space-y-3">
        <div>
          <label class="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">${src.hostname} Port <span class="opacity-50">(optional)</span></label>
          <input id="dlgSrcPort" type="text" placeholder="e.g. Gi0/1" class="w-full text-sm bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500">
        </div>
        <div>
          <label class="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">${tgt.hostname} Port <span class="opacity-50">(optional)</span></label>
          <input id="dlgTgtPort" type="text" placeholder="e.g. Gi0/2" class="w-full text-sm bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500">
        </div>
        <div>
          <label class="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">Label <span class="opacity-50">(optional)</span></label>
          <input id="dlgLabel" type="text" placeholder="e.g. Trunk, Uplink…" class="w-full text-sm bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500">
        </div>
      </div>
      <div class="mt-5 flex gap-2">
        <button id="dlgSave" class="flex-1 py-2 bg-amber-500 hover:bg-amber-600 text-white font-medium rounded-lg text-sm transition-colors">Add Link</button>
        <button id="dlgCancel" class="flex-1 py-2 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-medium rounded-lg text-sm transition-colors">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  const close = () => dialog.remove();

  document.getElementById("manualLinkBackdrop").onclick = close;
  document.getElementById("dlgCancel").onclick = close;
  document.getElementById("dlgSave").onclick = () => {
    const srcPort = document.getElementById("dlgSrcPort").value.trim();
    const tgtPort = document.getElementById("dlgTgtPort").value.trim();
    const label = document.getElementById("dlgLabel").value.trim();
    manualLinks.push({
      source: src,
      target: tgt,
      source_iface: srcPort,
      target_iface: tgtPort,
      manual_label: label || "Manual",
      link_type: "manual",
      subnet: null,
    });
    close();
    onComplete();
  };

  // Auto-focus first input
  setTimeout(() => document.getElementById("dlgSrcPort").focus(), 50);
}

// ── Node Editor (Label, Note, Type, Vendor, Icon) ─────────────
function openLabelEditor(e, d, svg, zoom) {
  e.stopPropagation();
  hideTooltip();

  const existing = document.getElementById("nodeLabelEditor");
  if (existing) existing.remove();

  // Get the screen position of the node
  const svgEl = document.getElementById("topology");
  const svgRect = svgEl.getBoundingClientRect();
  const mainEl = document.querySelector("main");
  const mainRect = mainEl.getBoundingClientRect();

  // Get current zoom/pan transform
  const transform = d3.zoomTransform(svgEl);
  const screenX = transform.applyX(d.x) + svgRect.left - mainRect.left;
  const screenY = transform.applyY(d.y) + svgRect.top - mainRect.top;

  // Position editor — anchor to the right of the node, clamped to viewport
  const editorW = 288;
  const editorLeft = Math.min(Math.max(screenX + 34, 8), mainRect.width - editorW - 8);
  const editorTop  = Math.max(Math.min(screenY - 80, mainRect.height - 520), 8);

  // Type dropdown options
  const typeOptions = DEVICE_TYPES.map(t =>
    `<option value="${t}" ${t === d.device_type ? "selected" : ""}>${t.charAt(0).toUpperCase() + t.slice(1)}</option>`
  ).join("");

  // Current icon preview (if any)
  const iconPreviewHtml = d.customIcon
    ? `<div id="editorIconPreview" class="mt-2 flex items-center gap-2">
        <img src="${d.customIcon}" class="w-10 h-10 rounded-full object-cover border-2 border-brand-400" alt="icon preview">
        <button id="editorIconClear" class="text-xs text-rose-500 hover:text-rose-600 underline">Remove icon</button>
       </div>`
    : `<div id="editorIconPreview" class="hidden"></div>`;

  const editor = document.createElement("div");
  editor.id = "nodeLabelEditor";
  editor.className = "absolute z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl p-4 overflow-y-auto";
  editor.style.left   = editorLeft + "px";
  editor.style.top    = editorTop + "px";
  editor.style.width  = editorW + "px";
  editor.style.maxHeight = (mainRect.height - editorTop - 16) + "px";

  editor.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2">
        <svg class="w-4 h-4 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
        <span class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Device Editor</span>
      </div>
      <span class="text-[10px] font-mono text-slate-400 dark:text-slate-500">${d.hostname}</span>
    </div>

    <div class="space-y-3">

      <!-- Display Label -->
      <div>
        <label class="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">Display Label</label>
        <input id="editorLabel" type="text" value="${d.label || d.hostname}"
          class="w-full text-sm bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-1.5 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500">
      </div>

      <!-- Note / Annotation -->
      <div>
        <label class="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">Note / Annotation</label>
        <textarea id="editorNote" rows="2" placeholder="Add a note…"
          class="w-full text-sm bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-1.5 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none">${d.note || ""}</textarea>
      </div>

      <!-- Device Type -->
      <div>
        <label class="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">Device Type</label>
        <select id="editorType"
          class="w-full text-sm bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-1.5 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500">
          ${typeOptions}
        </select>
      </div>

      <!-- Vendor -->
      <div>
        <label class="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">Vendor</label>
        <input id="editorVendor" type="text" value="${d.vendor || ""}"
          class="w-full text-sm bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg px-3 py-1.5 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500">
      </div>

      <!-- Custom Icon -->
      <div>
        <label class="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">Device Icon</label>
        <label for="editorIconFile"
          class="flex items-center gap-2 cursor-pointer w-full text-sm bg-slate-50 dark:bg-slate-700 border border-dashed border-slate-300 dark:border-slate-500 rounded-lg px-3 py-1.5 text-slate-500 dark:text-slate-400 hover:border-brand-400 hover:text-brand-500 transition-colors">
          <svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
          <span id="editorIconLabel">Upload image…</span>
        </label>
        <input id="editorIconFile" type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif" class="hidden">
        ${iconPreviewHtml}
      </div>

    </div>

    <!-- Actions -->
    <div class="mt-4 flex gap-2">
      <button id="editorSave"   class="flex-1 py-1.5 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-lg text-xs transition-colors">Save</button>
      <button id="editorClear"  class="py-1.5 px-3 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400 rounded-lg text-xs transition-colors" title="Reset label to hostname">↺</button>
      <button id="editorCancel" class="flex-1 py-1.5 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-medium rounded-lg text-xs transition-colors">Cancel</button>
    </div>
  `;

  mainEl.appendChild(editor);

  // ── Icon file handling ─────────────────────────────────────
  let pendingIconDataUrl = null;  // holds new icon before save
  let clearIcon = false;          // set true when user clicks "Remove icon"

  const iconFileInput  = document.getElementById("editorIconFile");
  const iconLabelEl   = document.getElementById("editorIconLabel");
  const iconPreviewEl = document.getElementById("editorIconPreview");

  function showIconPreview(dataUrl) {
    iconPreviewEl.className = "mt-2 flex items-center gap-2";
    iconPreviewEl.innerHTML = `
      <img src="${dataUrl}" class="w-10 h-10 rounded-full object-cover border-2 border-brand-400" alt="icon preview">
      <button id="editorIconClear" class="text-xs text-rose-500 hover:text-rose-600 underline">Remove icon</button>`;
    document.getElementById("editorIconClear").onclick = () => {
      pendingIconDataUrl = null;
      clearIcon = true;
      iconLabelEl.textContent = "Upload image…";
      iconPreviewEl.className = "hidden";
      iconPreviewEl.innerHTML = "";
    };
  }

  // Existing icon clear button
  const existingClearBtn = document.getElementById("editorIconClear");
  if (existingClearBtn) {
    existingClearBtn.onclick = () => {
      pendingIconDataUrl = null;
      clearIcon = true;
      iconLabelEl.textContent = "Upload image…";
      iconPreviewEl.className = "hidden";
      iconPreviewEl.innerHTML = "";
    };
  }

  iconFileInput.addEventListener("change", () => {
    const file = iconFileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      pendingIconDataUrl = ev.target.result;
      clearIcon = false;
      iconLabelEl.textContent = file.name.length > 22 ? file.name.slice(0, 22) + "…" : file.name;
      showIconPreview(pendingIconDataUrl);
    };
    reader.readAsDataURL(file);
  });

  // ── Editor buttons ─────────────────────────────────────────
  const close = () => editor.remove();

  document.getElementById("editorCancel").onclick = close;
  document.getElementById("editorClear").onclick = () => {
    document.getElementById("editorLabel").value = d.hostname;
    document.getElementById("editorNote").value = "";
  };

  document.getElementById("editorSave").onclick = () => {
    const newLabel  = document.getElementById("editorLabel").value.trim();
    const newNote   = document.getElementById("editorNote").value.trim();
    const newType   = document.getElementById("editorType").value;
    const newVendor = document.getElementById("editorVendor").value.trim();

    const typeChanged   = newType !== d.device_type;
    const iconChanged   = pendingIconDataUrl !== null || clearIcon;

    // Apply changes to node data
    d.label       = newLabel && newLabel !== d.hostname ? newLabel : null;
    d.note        = newNote || null;
    d.device_type = newType;
    d.vendor      = newVendor || d.vendor;
    if (pendingIconDataUrl) d.customIcon = pendingIconDataUrl;
    if (clearIcon)          d.customIcon = null;

    // Re-render the node shape/icon in SVG
    d3.selectAll(".node-group").filter(n => n.id === d.id).each(function() {
      const g = d3.select(this);

      // Redraw shape + icon (always safe to redo)
      updateNodeAppearance(g, d);

      // Update text labels
      const r = RADIUS[d.device_type] || 18;
      g.select(".node-label")
        .attr("dy", r + 14)
        .text(d.label || d.hostname);
      g.select(".node-note")
        .attr("dy", r + 25)
        .text(d.note ? `📝 ${d.note.slice(0, 20)}${d.note.length > 20 ? "…" : ""}` : "");
    });

    // Update collision radius in simulation if type changed
    if (typeChanged && simulation) {
      simulation.force("collision", d3.forceCollide().radius(n => RADIUS[n.device_type] + 22));
      simulation.alpha(0.1).restart();
    }

    // Refresh device detail panel if this node is selected
    if (selectedNode && selectedNode.id === d.id) {
      selectedNode = d;
      document.getElementById("deviceDetail").innerHTML = renderDeviceDetail(d);
    }

    close();
  };

  // Close on click outside editor
  const outsideClick = (ev) => {
    if (!editor.contains(ev.target) && !ev.target.closest("#editorIconFile")) {
      close();
      document.removeEventListener("mousedown", outsideClick);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", outsideClick), 100);

  // Focus label input
  setTimeout(() => document.getElementById("editorLabel").focus(), 50);
}

// ── Node interaction ───────────────────────────────────────────
function selectNode(d) {
  selectedNode = d;
  devicePanel.classList.remove("hidden");
  document.getElementById("deviceDetail").innerHTML = renderDeviceDetail(d);
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
      <div class="font-bold text-lg" style="color:${col}">${d.label || d.hostname}</div>
      ${d.label ? `<div class="text-xs text-slate-400 dark:text-slate-500 font-mono">${d.hostname}</div>` : ""}
      ${d.note ? `<div class="mt-1 text-xs text-amber-500 italic">📝 ${d.note}</div>` : ""}
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
  const label = d.label ? `<div class="text-xs text-amber-400 font-mono">${d.hostname}</div>` : "";
  tooltip.innerHTML = `
    <div class="font-bold text-sm mb-0.5">${d.label || d.hostname}</div>
    ${label}
    <div class="flex flex-col gap-0.5 opacity-90 mt-1">
      <div><span class="opacity-70">Type:</span> ${d.device_type}</div>
      <div><span class="opacity-70">Vendor:</span> ${d.vendor}</div>
      <div><span class="opacity-70">Interfaces:</span> ${ifaces.length} (${upCount} up)</div>
      ${d.note ? `<div class="mt-1 text-amber-400 italic text-[10px]">📝 ${d.note}</div>` : ""}
    </div>
    ${linkEditMode ? '<div class="mt-1.5 text-amber-400 text-[10px] font-medium">Click & drag to start a link</div>' : '<div class="mt-1.5 text-slate-400 text-[10px]">Double-click to edit label</div>'}
  `;
  tooltip.classList.remove("hidden");
  moveTooltip(e);
}

function moveTooltip(e) {
  const rect = document.querySelector("main").getBoundingClientRect();
  tooltip.style.left = (e.clientX - rect.left + 14) + "px";
  tooltip.style.top  = (e.clientY - rect.top  + 14) + "px";
}

function hideTooltip() {
  tooltip.classList.add("hidden");
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

/**
 * updateNodeAppearance — redraws the shape and icon for a node group.
 * Stencil mode: shape = thin border ring only; icon = uploaded image at full size (no clipping).
 * Priority: d.customIcon (per-node) > typeIcons[device_type] (type-wide) > letter icon.
 */
function updateNodeAppearance(g, d) {
  const color = COLOR[d.device_type] || COLOR.unknown;
  const r = RADIUS[d.device_type] || 18;

  // Remove previous elements cleanly
  g.select(".node-circle").remove();
  g.select(".device-icon").remove();
  g.select(".node-stencil-img").remove();
  g.select(".node-custom-img").remove();
  g.select(".node-clip-path").remove();
  g.select("defs.node-defs").remove();

  // Effective icon: per-node override > type-level stencil > none
  const effectiveIcon = d.customIcon || typeIcons[d.device_type] || null;

  // ── Shape (always drawn as a ring; fill is transparent when stencil active) ──
  if (d.device_type === "firewall") {
    g.append("polygon")
      .attr("points", hexPoints(r))
      .attr("fill",   effectiveIcon ? "none" : color + "22")
      .attr("stroke", color)
      .attr("stroke-width", effectiveIcon ? 1.5 : 2)
      .attr("class", "node-circle");
  } else if (d.device_type === "switch") {
    g.append("rect")
      .attr("x", -r).attr("y", -r * 0.65)
      .attr("width", r * 2).attr("height", r * 1.3)
      .attr("rx", 5)
      .attr("fill",   effectiveIcon ? "none" : color + "22")
      .attr("stroke", color)
      .attr("stroke-width", effectiveIcon ? 1.5 : 2)
      .attr("class", "node-circle");
  } else {
    g.append("circle")
      .attr("r", r)
      .attr("fill",   effectiveIcon ? "none" : color + "22")
      .attr("stroke", color)
      .attr("stroke-width", effectiveIcon ? 1.5 : 2)
      .attr("class", "node-circle");
  }

  // ── Stencil image or letter icon ────────────────────────────
  if (effectiveIcon) {
    // Render as stencil: image IS the icon, no clipping, aspect ratio preserved
    const imgSize = r * 1.7; // slightly smaller than shape boundary
    g.append("image")
      .attr("href", effectiveIcon)
      .attr("x", -imgSize / 2)
      .attr("y", -imgSize / 2)
      .attr("width",  imgSize)
      .attr("height", imgSize)
      .attr("preserveAspectRatio", "xMidYMid meet")
      .attr("class", d.customIcon ? "node-custom-img" : "node-stencil-img")
      .attr("pointer-events", "none");
  } else {
    // Default letter icon
    g.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("font-size", "11px")
      .attr("fill", color)
      .attr("pointer-events", "none")
      .attr("class", "device-icon")
      .text(deviceIcon(d.device_type));
  }
}

/**
 * refreshTypeSymbol — re-renders all nodes of a given device_type
 * after the type-level stencil icon has changed.
 */
function refreshTypeSymbol(type) {
  if (!nodeGroupsSel) return;
  nodeGroupsSel.filter(d => d.device_type === type && !d.customIcon).each(function(d) {
    updateNodeAppearance(d3.select(this), d);
  });
}

/**
 * initSymbolSidebar — wires up the Device Symbols section in the sidebar.
 * Called once after the DOM is ready.
 */
function initSymbolSidebar() {
  DEVICE_TYPES.forEach(type => {
    const fileInput   = document.getElementById(`symbolFile_${type}`);
    const clearBtn    = document.getElementById(`symbolClear_${type}`);
    const previewImg  = document.getElementById(`symbolPreview_${type}`);

    if (!fileInput) return;

    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        typeIcons[type] = ev.target.result;
        fileInput.value = "";
        updateSymbolRow(type);
        refreshTypeSymbol(type);
      };
      reader.readAsDataURL(file);
    });

    clearBtn.addEventListener("click", () => {
      typeIcons[type] = null;
      updateSymbolRow(type);
      refreshTypeSymbol(type);
    });
  });
}

/** Update the preview image and clear button visibility for a symbol row. */
function updateSymbolRow(type) {
  const previewImg = document.getElementById(`symbolPreview_${type}`);
  const clearBtn   = document.getElementById(`symbolClear_${type}`);
  const labelEl    = document.getElementById(`symbolLabel_${type}`);
  if (typeIcons[type]) {
    previewImg.src = typeIcons[type];
    previewImg.classList.remove("hidden");
    clearBtn.classList.remove("hidden");
    if (labelEl) labelEl.textContent = "Change";
  } else {
    previewImg.src = "";
    previewImg.classList.add("hidden");
    clearBtn.classList.add("hidden");
    if (labelEl) labelEl.textContent = "Upload";
  }
}


// ── applyTick ─────────────────────────────────────────────────
// Shared position updater called both from simulation.on("tick")
// and manually during drag in non-force layout modes.
function applyTick() {
  if (!linkG) return;

  linkG.selectAll("line.link-line")
    .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
    .attr("x2", d => d.target.x).attr("y2", d => d.target.y);

  linkG.selectAll("text.link-label")
    .attr("x", d => (d.source.x + d.target.x) / 2)
    .attr("y", d => (d.source.y + d.target.y) / 2 - 4);

  linkG.selectAll("text.port-label-src").each(function(d) {
    const sx = d.source.x, sy = d.source.y, tx = d.target.x, ty = d.target.y;
    const angle = Math.atan2(ty - sy, tx - sx);
    const offset = 12;
    const px = sx + (tx - sx) * 0.2;
    const py = sy + (ty - sy) * 0.2;
    d3.select(this)
      .attr("x", px + Math.sin(angle) * offset)
      .attr("y", py - Math.cos(angle) * offset);
  });

  linkG.selectAll("text.port-label-dst").each(function(d) {
    const sx = d.source.x, sy = d.source.y, tx = d.target.x, ty = d.target.y;
    const angle = Math.atan2(ty - sy, tx - sx);
    const offset = 12;
    const px = sx + (tx - sx) * 0.8;
    const py = sy + (ty - sy) * 0.8;
    d3.select(this)
      .attr("x", px + Math.sin(angle) * offset)
      .attr("y", py - Math.cos(angle) * offset);
  });

  if (nodeGroupsSel) {
    nodeGroupsSel.attr("transform", d => `translate(${d.x},${d.y})`);
  }
}

// ── Layout Modes ───────────────────────────────────────────────

/**
 * setLayout — switches between force / hierarchical / circular / free modes.
 * Smoothly animates nodes to their new positions for static layouts.
 */
function setLayout(mode) {
  layoutMode = mode;
  updateLayoutButtons();
  if (!allNodesData.length || !simulation) return;

  const svgEl = document.getElementById("topology");
  const W = svgEl.clientWidth  || window.innerWidth  - 320;
  const H = svgEl.clientHeight || window.innerHeight;

  if (mode === "force") {
    // Release all pins → let simulation run freely again
    allNodesData.forEach(n => { n.fx = null; n.fy = null; });
    simulation
      .force("charge", d3.forceManyBody().strength(-400))
      .force("link",   d3.forceLink(parsedLinks).id(d => d.id).distance(130))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collision", d3.forceCollide().radius(d => (RADIUS[d.device_type] || 18) + 22))
      .alpha(0.8).restart();

  } else if (mode === "hierarchical") {
    simulation.stop();
    computeHierarchicalPositions(allNodesData, [...parsedLinks, ...manualLinks], W, H);
    animateToPositions();

  } else if (mode === "circular") {
    simulation.stop();
    computeCircularPositions(allNodesData, W, H);
    animateToPositions();

  } else if (mode === "free") {
    // Pin every node at its current position — sim stops affecting anything
    allNodesData.forEach(n => { n.fx = n.x; n.fy = n.y; });
    simulation.stop();
  }
}

/**
 * animateToPositions — smoothly transitions nodes from their current x/y to
 * the fx/fy target positions set by a layout computation function.
 */
function animateToPositions() {
  if (!nodeGroupsSel) return;

  // Set x/y = fx/fy so the tick reads correct values immediately
  allNodesData.forEach(n => { n.x = n.fx; n.y = n.fy; });

  nodeGroupsSel
    .transition().duration(600).ease(d3.easeCubicInOut)
    .attr("transform", d => `translate(${d.fx},${d.fy})`);

  // Animate links in parallel
  if (linkG) {
    linkG.selectAll("line.link-line")
      .transition().duration(600).ease(d3.easeCubicInOut)
      .attr("x1", d => d.source.fx || d.source.x)
      .attr("y1", d => d.source.fy || d.source.y)
      .attr("x2", d => d.target.fx || d.target.x)
      .attr("y2", d => d.target.fy || d.target.y);

    linkG.selectAll("text.link-label")
      .transition().duration(600).ease(d3.easeCubicInOut)
      .attr("x", d => ((d.source.fx || d.source.x) + (d.target.fx || d.target.x)) / 2)
      .attr("y", d => ((d.source.fy || d.source.y) + (d.target.fy || d.target.y)) / 2 - 4);
  }
}

/**
 * computeHierarchicalPositions — assigns fx/fy using BFS level assignment (top-down).
 * Handles cycles by assigning remaining nodes to level 0.
 */
function computeHierarchicalPositions(nodes, links, W, H) {
  const outEdges = {};
  const inDegree  = {};
  nodes.forEach(n => { outEdges[n.id] = []; inDegree[n.id] = 0; });

  links.forEach(l => {
    const srcId = typeof l.source === "object" ? l.source.id : l.source;
    const tgtId = typeof l.target === "object" ? l.target.id : l.target;
    if (outEdges[srcId] !== undefined) outEdges[srcId].push(tgtId);
    if (inDegree[tgtId]  !== undefined) inDegree[tgtId]++;
  });

  // BFS from root nodes (in-degree 0)
  let roots = nodes.filter(n => inDegree[n.id] === 0).map(n => n.id);
  if (roots.length === 0) roots = [nodes[0].id]; // fallback for fully cyclic graphs

  const level = {};
  const queue = roots.map(id => ({ id, lvl: 0 }));
  while (queue.length) {
    const { id, lvl } = queue.shift();
    if (level[id] !== undefined) continue;
    level[id] = lvl;
    (outEdges[id] || []).forEach(tid => {
      if (level[tid] === undefined) queue.push({ id: tid, lvl: lvl + 1 });
    });
  }
  // Remaining unvisited nodes (cycles) → level 0
  nodes.forEach(n => { if (level[n.id] === undefined) level[n.id] = 0; });

  // Group by level
  const byLevel = {};
  nodes.forEach(n => {
    const lvl = level[n.id];
    if (!byLevel[lvl]) byLevel[lvl] = [];
    byLevel[lvl].push(n);
  });

  const maxLevel = Math.max(...Object.keys(byLevel).map(Number));
  const yPad   = 70;
  const yRange  = H - yPad * 2;
  const yStep   = maxLevel > 0 ? yRange / maxLevel : yRange;

  Object.entries(byLevel).forEach(([lvl, levelNodes]) => {
    const count  = levelNodes.length;
    const xStep  = W / (count + 1);
    levelNodes.forEach((n, i) => {
      n.fx = xStep * (i + 1);
      n.fy = yPad + Number(lvl) * Math.min(yStep, 160);
    });
  });
}

/**
 * computeCircularPositions — arranges all nodes evenly on a circle.
 * Groups by device_type so same-type nodes are clustered together.
 */
function computeCircularPositions(nodes, W, H) {
  const cx = W / 2;
  const cy = H / 2;
  const r  = Math.min(W, H) * 0.36;

  // Sort nodes: group by device_type for visual clustering
  const typeOrder = { firewall: 0, router: 1, switch: 2, unknown: 3 };
  const sorted = [...nodes].sort((a, b) =>
    (typeOrder[a.device_type] ?? 4) - (typeOrder[b.device_type] ?? 4)
  );

  sorted.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / sorted.length - Math.PI / 2;
    n.fx = cx + r * Math.cos(angle);
    n.fy = cy + r * Math.sin(angle);
  });
}

// ── Layout button wiring ───────────────────────────────────────

const LAYOUT_MODES = ["force", "hierarchical", "circular", "free"];

function initLayoutButtons() {
  LAYOUT_MODES.forEach(mode => {
    const btn = document.getElementById(`btnLayout_${mode}`);
    if (btn) btn.onclick = () => setLayout(mode);
  });
  updateLayoutButtons();
}

function updateLayoutButtons() {
  LAYOUT_MODES.forEach(mode => {
    const btn = document.getElementById(`btnLayout_${mode}`);
    if (!btn) return;
    if (mode === layoutMode) {
      btn.classList.add("bg-brand-500", "text-white");
      btn.classList.remove("text-slate-600", "dark:text-slate-300",
                           "hover:bg-slate-100", "dark:hover:bg-slate-700");
    } else {
      btn.classList.remove("bg-brand-500", "text-white");
      btn.classList.add("text-slate-600", "dark:text-slate-300",
                        "hover:bg-slate-100", "dark:hover:bg-slate-700");
    }
  });
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

// Wire up symbol sidebar on load
initSymbolSidebar();