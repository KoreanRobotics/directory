// KARA Directory: loads data/people.json (written by scripts/sync.py) and
// renders it as a clustered map and a card list that share one set of filters.

// Google Form link for the "Add yourself" button; leave empty to hide it.
const FORM_URL = "";

const ROLE_LABELS = { student: "Student", postdoc: "Postdoc", faculty: "Faculty", industry: "Industry", other: "Other" };
const LINKS = [
  ["homepage", "fa-solid fa-house", "Homepage"],
  ["scholar", "ai ai-google-scholar", "Google Scholar"],
  ["linkedin", "fa-brands fa-linkedin", "LinkedIn"],
  ["github", "fa-brands fa-github", "GitHub"],
  ["cv", "ai ai-cv", "CV"],
];
// Options are OR'ed within a group and AND'ed across groups.
const GROUPS = [
  { key: "role", label: "Position", values: (p) => [p.role], name: (v) => ROLE_LABELS[v] || v, order: Object.keys(ROLE_LABELS) },
  { key: "sector", label: "Sector", values: (p) => [p.sector] },
  { key: "research", label: "Research area", values: (p) => p.research || [] },
  { key: "country", label: "Country", values: (p) => [p.place && p.place.country].filter(Boolean) },
];

const state = { view: "map", q: "", filters: Object.fromEntries(GROUPS.map((g) => [g.key, new Set()])) };
let people = [];
let map, cluster, needsFit = true;
const markers = new Map(); // affiliation -> marker

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hasCoords = (p) => p.place && p.place.lat != null && p.place.lng != null;

function placeText(p) {
  const pl = p.place || {};
  const second = pl.country === "USA" && pl.region ? pl.region : pl.country;
  return [pl.city, second].filter(Boolean).join(", ");
}

function linksHTML(p) {
  const links = p.links || {};
  return LINKS.filter(([k]) => links[k])
    .map(([k, icon, label]) =>
      `<a href="${esc(links[k])}" target="_blank" rel="noopener noreferrer" title="${label}" aria-label="${esc(p.name)}: ${label}"><i class="${icon}"></i></a>`)
    .join("");
}

function initials(name) {
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0] || "")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

// ---- URL state ----

function readURL() {
  const params = new URLSearchParams(location.search);
  state.view = params.get("view") === "list" ? "list" : "map";
  state.q = params.get("q") || "";
  for (const g of GROUPS) state.filters[g.key] = new Set(params.getAll(g.key));
}

function writeURL() {
  const params = new URLSearchParams();
  if (state.view === "list") params.set("view", "list");
  if (state.q) params.set("q", state.q);
  for (const g of GROUPS) for (const v of state.filters[g.key]) params.append(g.key, v);
  const qs = params.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

// ---- filtering ----

function matches(p) {
  const tokens = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length) {
    const hay = [p.name, p.name_ko, p.title, p.affiliation, p.lab, placeText(p), ...(p.research || [])].join(" ").toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) return false;
  }
  return GROUPS.every((g) => {
    const sel = state.filters[g.key];
    return sel.size === 0 || g.values(p).some((v) => sel.has(v));
  });
}

function buildFilters() {
  const html = GROUPS.map((g) => {
    const counts = new Map();
    for (const p of people) for (const v of g.values(p)) counts.set(v, (counts.get(v) || 0) + 1);
    const values = [...counts.keys()].sort((a, b) =>
      g.order ? g.order.indexOf(a) - g.order.indexOf(b) : counts.get(b) - counts.get(a) || a.localeCompare(b));
    if (values.length < 2) return "";
    const items = values.map((v) => `
      <label><input type="checkbox" data-group="${g.key}" value="${esc(v)}" ${state.filters[g.key].has(v) ? "checked" : ""} />
        <span>${esc(g.name ? g.name(v) : v)}</span><small>${counts.get(v)}</small></label>`).join("");
    return `<fieldset><legend>${g.label}</legend>${items}</fieldset>`;
  }).join("");
  $("#filter-groups").innerHTML = html;
}

// ---- rendering ----

function render() {
  const shown = people.filter(matches);
  $("#count").textContent = `${shown.length} ${shown.length === 1 ? "person" : "people"}`;
  const filtered = state.q || GROUPS.some((g) => state.filters[g.key].size);
  $("#clear").hidden = !filtered;
  renderMap(shown); // first: the list links to the markers it creates
  renderList(shown);
  writeURL();
}

function renderList(shown) {
  if (!shown.length) {
    $("#cards").innerHTML = `<p class="empty">${people.length ? "No one matches these filters." : "No one is listed yet."}</p>`;
    return;
  }
  $("#cards").innerHTML = shown.map((p) => {
    const aff = markers.has(p.affiliation)
      ? `<button type="button" class="aff" data-aff="${esc(p.affiliation)}" title="Show on map">${esc(p.affiliation)}</button>`
      : `<span class="aff-text">${esc(p.affiliation)}</span>`;
    const tags = (p.research || []).map((t) =>
      `<button type="button" class="tag${state.filters.research.has(t) ? " on" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("");
    return `
      <article class="card">
        <div class="avatar" aria-hidden="true">${esc(initials(p.name))}</div>
        <div class="card-body">
          <h3>${esc(p.name)}${p.name_ko ? ` <span class="ko">${esc(p.name_ko)}</span>` : ""}</h3>
          <p class="title">${esc(p.title || ROLE_LABELS[p.role] || "")}</p>
          <p>${aff}${p.lab ? ` <span class="muted">· ${esc(p.lab)}</span>` : ""}</p>
          <p class="muted small">${esc(placeText(p))}</p>
          ${tags ? `<div class="tags">${tags}</div>` : ""}
          <div class="links">${linksHTML(p)}</div>
        </div>
      </article>`;
  }).join("");
}

function setupMap() {
  map = L.map("map", { worldCopyJump: true, minZoom: 1 }).setView([37, -40], 3);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 45,
    iconCreateFunction: (c) => {
      const n = c.getAllChildMarkers().reduce((s, m) => s + m.options.n, 0);
      return L.divIcon({ className: "pin pin-cluster", html: `<span>${n}</span>`, iconSize: [40, 40] });
    },
  });
  map.addLayer(cluster);
}

function renderMap(shown) {
  cluster.clearLayers();
  markers.clear();
  const byAff = new Map();
  for (const p of shown.filter(hasCoords)) {
    if (!byAff.has(p.affiliation)) byAff.set(p.affiliation, []);
    byAff.get(p.affiliation).push(p);
  }
  for (const [aff, list] of byAff) {
    const { lat, lng } = list[0].place;
    const marker = L.marker([lat, lng], {
      n: list.length,
      title: aff,
      icon: L.divIcon({ className: "pin", html: `<span>${list.length}</span>`, iconSize: [30, 30] }),
    });
    const rows = list.map((p) => `
      <li><strong>${esc(p.name)}</strong>${p.name_ko ? ` <span class="ko">${esc(p.name_ko)}</span>` : ""}
        <br><span class="muted">${esc(p.title || ROLE_LABELS[p.role] || "")}</span>
        <span class="links">${linksHTML(p)}</span></li>`).join("");
    marker.bindPopup(`<div class="popup"><h4>${esc(aff)}</h4><p class="muted small">${esc(placeText(list[0]))}</p><ul>${rows}</ul></div>`,
      { maxHeight: 280, minWidth: 220 });
    cluster.addLayer(marker);
    markers.set(aff, marker);
  }
  const off = shown.length - shown.filter(hasCoords).length;
  $("#map-note").hidden = off === 0;
  $("#map-note").textContent = `${off} ${off === 1 ? "person has" : "people have"} no map location. See List.`;
  needsFit = true;
  if (state.view === "map") fitMap();
}

function fitMap() {
  needsFit = false;
  if (markers.size) map.fitBounds(cluster.getBounds(), { padding: [50, 50], maxZoom: 9 });
}

function setView(view) {
  state.view = view;
  $("#map-view").hidden = view !== "map";
  $("#list-view").hidden = view !== "list";
  document.querySelectorAll(".views button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === view));
  if (view === "map") {
    map.invalidateSize();
    if (needsFit) fitMap();
  }
  writeURL();
}

function showOnMap(aff) {
  const marker = markers.get(aff);
  if (!marker) return;
  setView("map");
  cluster.zoomToShowLayer(marker, () => marker.openPopup());
}

// ---- events ----

function bind() {
  $("#search").value = state.q;
  $("#search").addEventListener("input", (e) => { state.q = e.target.value.trim(); render(); });
  document.querySelectorAll(".views button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("#filters-toggle").addEventListener("click", () => document.body.classList.toggle("filters-open"));

  $("#filter-groups").addEventListener("change", (e) => {
    const box = e.target;
    const sel = state.filters[box.dataset.group];
    box.checked ? sel.add(box.value) : sel.delete(box.value);
    render();
  });
  $("#clear").addEventListener("click", () => {
    state.q = "";
    $("#search").value = "";
    for (const g of GROUPS) state.filters[g.key].clear();
    document.querySelectorAll("#filter-groups input").forEach((i) => (i.checked = false));
    render();
  });
  $("#cards").addEventListener("click", (e) => {
    const aff = e.target.closest(".aff");
    if (aff) return showOnMap(aff.dataset.aff);
    const tag = e.target.closest(".tag");
    if (tag) {
      const sel = state.filters.research;
      sel.has(tag.dataset.tag) ? sel.delete(tag.dataset.tag) : sel.add(tag.dataset.tag);
      buildFilters();
      render();
    }
  });

  if (FORM_URL) {
    $("#join").href = FORM_URL;
    $("#join").hidden = false;
  }
}

fetch("data/people.json")
  .then((r) => r.json())
  .then((data) => {
    people = data;
    readURL();
    buildFilters();
    setupMap();
    bind();
    render();
    setView(state.view);
  })
  .catch(() => {
    $("#cards").innerHTML = '<p class="empty">Could not load the directory.</p>';
    $("#map-view").hidden = true;
    $("#list-view").hidden = false;
  });
