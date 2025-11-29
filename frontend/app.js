const API_BASE = "";

// ---------- SETTINGS ----------

const SETTINGS_KEY = "yt_link_ui_settings_v1";
const THEME_KEY = "yt_theme";

const DEFAULT_SETTINGS = {
  columns: 5,              // cards per row (2–10)
  viewMode: "grid",        // "grid" | "list"
  sortMode: "newest",      // "newest" | "oldest" | "alpha" | "duration"
  warnOnDuplicateInCategory: true,
  maxUrlsPerSecond: 5,
  maxUrlsPerMinute: 60,
  duplicatePolicy: "block_category",
};

let settings = loadSettings();

let lastSelectedCategory = "Unsorted";

let appState = {
  links: [],
  categories: [],
  queue: [],
  next_id: 1,
  config: {},
};

let categoryLastActive = {}; // catName -> timestamp (ms)

let pendingQueue = [];
let requestsThisSecond = 0;
let requestsThisMinute = 0;
let currentSearchQuery = "";

let notificationTimeout = null;

function primaryCategory(link) {
  if (link.primary_category) return link.primary_category;
  if (Array.isArray(link.categories) && link.categories.length) return link.categories[0];
  return "Unsorted";
}


// ---------- SETTINGS HELPERS ----------

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function touchCategory(cat) {
  categoryLastActive[cat] = Date.now();
}


// ---------- TOAST ----------

function showToast(message, type = "info") {
  let box = document.getElementById("toast-box");
  if (!box) {
    box = document.createElement("div");
    box.id = "toast-box";
    box.className =
      "fixed bottom-4 right-4 z-50 max-w-xs bg-slate-900 border text-xs text-slate-50 rounded-lg px-3 py-2 shadow-lg shadow-slate-900/70 transition-opacity";
    document.body.appendChild(box);
  }

  box.textContent = message;

  box.classList.remove("border-slate-700", "border-red-500", "border-emerald-500");

  if (type === "error") box.classList.add("border-red-500");
  else if (type === "success") box.classList.add("border-emerald-500");
  else box.classList.add("border-slate-700");

  box.style.opacity = "1";

  if (notificationTimeout) clearTimeout(notificationTimeout);
  notificationTimeout = setTimeout(() => {
    box.style.opacity = "0";
  }, 3000);
}


// ---------- THEME ----------

function setTheme(theme) {
  const root = document.getElementById("app-root");
  if (!root) return;

  const base = "min-h-screen flex flex-col text-slate-100";
  let themeClasses = "";

  if (theme === "glass") {
    themeClasses =
      "bg-slate-950 bg-[radial-gradient(circle_at_top,_#1e293b,_#020617_60%)]";
  } else if (theme === "neon") {
    themeClasses = "bg-gradient-to-br from-purple-900 via-slate-950 to-sky-900";
  } else if (theme === "tiktok") {
    themeClasses = "bg-black";
  }

  root.className = base + " " + themeClasses;
  localStorage.setItem(THEME_KEY, theme);
}


// ---------- API ----------

async function fetchDraft() {
  const res = await fetch("/api/draft");
  if (!res.ok) return;
  appState = await res.json();

   // sync view defaults with server config
  if (appState.config?.view_defaults) {
    settings = { ...settings, ...appState.config.view_defaults };
    saveSettings();
  }
  if (appState.config?.duplicate_policy) {
    settings.duplicatePolicy = appState.config.duplicate_policy;
  }

  document.getElementById("duplicate-policy")?.setAttribute("value", appState.config?.duplicate_policy || "block_category");
  const dupSelect = document.getElementById("duplicate-policy");
  if (dupSelect) dupSelect.value = appState.config?.duplicate_policy || "block_category";
  const orderSelect = document.getElementById("category-order");
  if (orderSelect) orderSelect.value = appState.config?.category_order_strategy || "recent";
  const sec = document.getElementById("limit-second");
  const minute = document.getElementById("limit-minute");
  if (sec) sec.value = appState.config?.rate_limit_per_second || settings.maxUrlsPerSecond;
  if (minute) minute.value = appState.config?.rate_limit_per_minute || settings.maxUrlsPerMinute;

  appState.categories.forEach((c) => {
    if (!(c in categoryLastActive)) categoryLastActive[c] = 0;
  });

  renderQueue();
  render();
}

async function addCategory(name) {
  name = name.trim();
  if (!name) return;
  await fetch("/api/categories?name=" + encodeURIComponent(name), {
    method: "POST",
  });
  touchCategory(name);
  await fetchDraft();
}

async function apiAddLink(url, category) {
  const res = await fetch("/api/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, category }),
  });

  if (res.status === 409) {
    showToast("Duplicate link in this category – skipped.", "error");
    return;
  }

  if (!res.ok) {
    showToast("Failed to add link (invalid or network issue).", "error");
    return;
  }

  const payload = await res.json();
  const link = payload.link || payload;
  touchCategory(primaryCategory(link) || category);
  await fetchDraft();
  if (payload.duplicate) {
    showToast("Link already existed – added to category.", "info");
  } else {
    showToast("Link added to queue.", "success");
  }
}

async function deleteLink(id) {
  await fetch(`/api/links/${id}`, { method: "DELETE" });
  await fetchDraft();
}

async function changeLinkCategory(id, category) {
  lastSelectedCategory = category;
  touchCategory(category);
  await fetch(`/api/links/${id}/category?category=` + encodeURIComponent(category), {
    method: "PATCH",
  });
  await fetchDraft();
}

async function updateTags(id, tags) {
  await fetch(`/api/links/${id}/tags`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags }),
  });
}

async function saveMain() {
  await fetch("/api/save", { method: "POST" });
  showToast("Library saved.", "success");
}


// ---------- URL NORMALIZE (JS SIDE, for dupes) ----------

function normalizeYouTubeUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("youtube.com") && !u.hostname.includes("youtu.be")) {
      return null;
    }

    if (u.pathname.startsWith("/shorts/")) {
      const id = u.pathname.split("/shorts/")[1].split("/")[0];
      if (!id) return null;
      return `https://www.youtube.com/shorts/${id}`;
    }

    if (u.hostname === "youtu.be") {
      const id = u.pathname.replace("/", "");
      if (!id) return null;
      return `https://www.youtube.com/watch?v=${id}`;
    }

    const params = u.searchParams;
    const id = params.get("v");
    if (!id) return null;

    return `https://www.youtube.com/watch?v=${id}`;
  } catch {
    return null;
  }
}

function isDuplicateInCategory(rawUrl, category) {
  const norm = normalizeYouTubeUrl(rawUrl);
  if (!norm) return false;
  return appState.links.some(
    (l) => (l.categories || []).includes(category) && l.normalized_url === norm
  );
}

function isGlobalDuplicate(rawUrl) {
  const norm = normalizeYouTubeUrl(rawUrl);
  if (!norm) return false;
  return appState.links.some((l) => l.normalized_url === norm);
}


// ---------- QUEUE / RATE LIMIT ----------

function enqueueUrl(url, category) {
  pendingQueue.push({ url, category });
  renderQueue();
}

function setupQueueProcessor() {
  setInterval(() => {
    requestsThisSecond = 0;
  }, 1000);

  setInterval(() => {
    requestsThisMinute = 0;
  }, 60000);

  async function processOne() {
    if (!pendingQueue.length) return;
    if (requestsThisSecond >= settings.maxUrlsPerSecond) return;
    if (requestsThisMinute >= settings.maxUrlsPerMinute) return;

    const item = pendingQueue.shift();
    requestsThisSecond += 1;
    requestsThisMinute += 1;

    const { url, category } = item;

    const policy = settings.duplicatePolicy || "block_category";
    if (policy === "block_category" && isDuplicateInCategory(url, category)) {
      showToast("Duplicate in this category – skipped.", "error");
      return;
    }
    if (policy === "warn_global" && isGlobalDuplicate(url)) {
      showToast("Duplicate exists elsewhere — adding anyway.", "info");
    }

    try {
      await apiAddLink(url, category);
    } catch (err) {
      console.error(err);
      showToast("Error while adding link.", "error");
    }
    renderQueue();
  }

  setInterval(processOne, 50); // ~20 ops/sec max
}

function renderQueue() {
  const list = document.getElementById("queue-list");
  const count = document.getElementById("queue-count");
  if (!list || !count) return;
  list.innerHTML = "";

  const combined = [
    ...pendingQueue.map((q) => ({ url: q.url, status: "local" })),
    ...(appState.queue || []),
  ];
  count.textContent = combined.length.toString();
  combined.forEach((q) => {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between bg-slate-900/80 border border-slate-800 rounded px-2 py-1";
    const url = document.createElement("span");
    url.className = "truncate w-40";
    url.textContent = q.url || "pending";
    const badge = document.createElement("span");
    badge.className = "text-[10px] text-slate-400";
    badge.textContent = q.status || "waiting";
    row.appendChild(url);
    row.appendChild(badge);
    list.appendChild(row);
  });
}


// ---------- RENDER HELPERS ----------

function gridColumnsClass() {
  const n = settings.columns || 5;
  const value = Math.max(2, Math.min(10, n));

  // For Tailwind, keep a few fixed breakpoints:
  // mobile: 1, sm: 2–4, lg: slider-based
  let lg = value;
  if (lg < 2) lg = 2;
  if (lg > 10) lg = 10;

  return `grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-${lg}`;
}

function sortLinks(links) {
  const mode = settings.sortMode || "newest";

  return [...links].sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();

    if (mode === "newest") return tb - ta;
    if (mode === "oldest") return ta - tb;

    if (mode === "alpha") {
      const sa = (a.title || "").toLowerCase();
      const sb = (b.title || "").toLowerCase();
      return sa.localeCompare(sb);
    }

    if (mode === "duration") {
      const da = a.duration_seconds || 0;
      const db = b.duration_seconds || 0;
      return da - db;
    }

    return tb - ta;
  });
}

function filterLinksBySearch(links) {
  if (!currentSearchQuery) return links;
  const q = currentSearchQuery.toLowerCase();
  return links.filter((l) => {
    const text = [
      l.title || "",
      l.author || "",
      l.normalized_url || "",
      (l.tags || []).join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return text.includes(q);
  });
}


// ---------- RENDER ----------

function render() {
  const categorySelect = document.getElementById("category-select");
  const container = document.getElementById("links-container");
  if (!categorySelect || !container) return;

  // Categories order
  categorySelect.innerHTML = "";

  const cats = [...appState.categories];

  const counts = {};
  appState.links.forEach((l) => {
    (l.categories || [primaryCategory(l)]).forEach((cat) => {
      counts[cat] = (counts[cat] || 0) + 1;
    });
  });

  const strategy = document.getElementById("category-order")?.value || appState.config?.category_order_strategy || "recent";
  cats.sort((a, b) => {
    if (strategy === "alphabetical") return a.localeCompare(b);
    if (strategy === "most_items") return (counts[b] || 0) - (counts[a] || 0);
    if (strategy === "pinned_first") {
      const pinned = appState.config?.pinned_categories || [];
      const ap = pinned.includes(a);
      const bp = pinned.includes(b);
      if (ap !== bp) return ap ? -1 : 1;
    }
    const ta = categoryLastActive[a] || 0;
    const tb = categoryLastActive[b] || 0;
    if (tb !== ta) return tb - ta;
    return a.localeCompare(b);
  });

  cats.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    if (c === lastSelectedCategory) opt.selected = true;
    categorySelect.appendChild(opt);
  });

  container.innerHTML = "";

  // Build category → links mapping
  const byCategory = {};
  appState.links.forEach((l) => {
    const catsForLink = l.categories && l.categories.length ? l.categories : [primaryCategory(l)];
    catsForLink.forEach((cat) => {
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(l);
    });
  });

  const viewMode = settings.viewMode || "grid";

  cats.forEach((cat) => {
    const links = byCategory[cat] || [];
    if (!links.length) return;

    const filtered = filterLinksBySearch(links);
    if (!filtered.length && currentSearchQuery) return;

    const sorted = sortLinks(filtered);

    const card = document.createElement("div");
    card.className =
      "bg-slate-900/80 border border-slate-800 rounded-xl p-3 shadow-md shadow-slate-900/40 mb-3";

    const header = document.createElement("div");
    header.className = "flex items-center justify-between mb-2";

    const title = document.createElement("h2");
    title.className = "text-sm font-semibold";
    title.textContent = `${cat} (${sorted.length})`;

    const sortLabel = document.createElement("div");
    sortLabel.className = "text-[10px] text-slate-400";
    const mode = settings.sortMode;
    if (mode === "newest") sortLabel.textContent = "Newest → oldest";
    else if (mode === "oldest") sortLabel.textContent = "Oldest → newest";
    else if (mode === "alpha") sortLabel.textContent = "Title A → Z";
    else if (mode === "duration") sortLabel.textContent = "Duration: short → long";

    header.appendChild(title);
    header.appendChild(sortLabel);
    card.appendChild(header);

    // separate shorts vs normal
    const normal = [];
    const shorts = [];
    sorted.forEach((l) => {
      if ((l.normalized_url || "").includes("/shorts/")) shorts.push(l);
      else normal.push(l);
    });

    if (viewMode === "grid") {
      renderGridMode(card, cat, normal, shorts);
    } else {
      renderListMode(card, cat, normal.concat(shorts));
    }

    container.appendChild(card);
  });
}

function renderGridMode(card, cat, normal, shorts) {
  if (normal.length) {
    const grid = document.createElement("div");
    grid.className = "grid gap-3 " + gridColumnsClass();

    normal.forEach((link) => {
      const item = document.createElement("div");
      item.className =
        "flex flex-col bg-slate-950/70 rounded-lg overflow-hidden border border-slate-800/70";

      // thumbnail
      const thumbWrap = document.createElement("a");
      thumbWrap.href = link.original_url || link.normalized_url;
      thumbWrap.target = "_blank";
      thumbWrap.rel = "noopener noreferrer";
      thumbWrap.className = "relative block aspect-video bg-slate-800";

      if (link.thumbnail_url) {
        const img = document.createElement("img");
        img.src = link.thumbnail_url;
        img.alt = link.title || "thumb";
        img.className = "w-full h-full object-cover";
        thumbWrap.appendChild(img);
      }

      // duration badge
      if (link.duration) {
        const badge = document.createElement("div");
        badge.className =
          "absolute bottom-1 right-1 bg-black/80 text-[10px] px-1 py-[1px] rounded";
        badge.textContent = link.duration;
        thumbWrap.appendChild(badge);
      }

      // play overlay
      const playBtn = document.createElement("div");
      playBtn.className =
        "absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition bg-black/30";
      playBtn.innerHTML =
        '<svg width="42" height="42" viewBox="0 0 24 24"><path fill="white" d="M8 5v14l11-7z"/></svg>';
      thumbWrap.appendChild(playBtn);

      item.appendChild(thumbWrap);

      // bottom area
      const bottom = document.createElement("div");
      bottom.className = "flex gap-2 px-2 py-2";

      // avatar
      const avatar = document.createElement("img");
      avatar.className =
        "w-7 h-7 rounded-full object-cover flex-shrink-0 bg-slate-700";
      avatar.src =
        link.channel_avatar ||
        "https://www.youtube.com/s/desktop/fe4547c5/img/favicon_144x144.png";
      bottom.appendChild(avatar);

      const textBox = document.createElement("div");
      textBox.className = "min-w-0";

      const titleEl = document.createElement("div");
      titleEl.className =
        "text-xs font-medium text-slate-50 leading-tight line-clamp-2";
      titleEl.textContent = link.title || "(no title)";
      textBox.appendChild(titleEl);

      const metaEl = document.createElement("div");
      metaEl.className = "text-[10px] text-slate-400 truncate";
      metaEl.textContent = link.author
        ? `${link.author} • ${link.normalized_url}`
        : link.normalized_url;
      textBox.appendChild(metaEl);

      // tag editor
      const tagBox = document.createElement("input");
      tagBox.className =
        "w-full mt-1 text-[10px] px-1 py-[2px] bg-slate-950 border border-slate-700 rounded";
      tagBox.placeholder = "tags (comma separated)";
      tagBox.value = (link.tags || []).join(", ");
      tagBox.addEventListener("change", async () => {
        const tags = tagBox.value
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        await updateTags(link.id, tags);
        link.tags = tags;
        showToast("Tags updated.", "success");
      });
      textBox.appendChild(tagBox);

      const controls = document.createElement("div");
      controls.className =
        "mt-1 flex items-center gap-1 justify-between text-[10px]";

      const catSelect = document.createElement("select");
      catSelect.className =
        "bg-slate-950 border border-slate-700 rounded px-1 py-[2px] text-[10px]";
      appState.categories.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        if ((link.categories || []).includes(c) || primaryCategory(link) === c) opt.selected = true;
        catSelect.appendChild(opt);
      });
      catSelect.addEventListener("change", () => {
        changeLinkCategory(link.id, catSelect.value);
      });

      const delBtn = document.createElement("button");
      delBtn.className =
        "px-2 py-[3px] rounded bg-red-600 hover:bg-red-500 text-[10px]";
      delBtn.textContent = "✕";
      delBtn.title = "Delete";
      delBtn.addEventListener("click", () => deleteLink(link.id));

      controls.appendChild(catSelect);
      controls.appendChild(delBtn);

      textBox.appendChild(controls);

      bottom.appendChild(textBox);
      item.appendChild(bottom);

      grid.appendChild(item);
    });

    card.appendChild(grid);
  }

  // Shorts row
  if (shorts.length) {
    const shortsTitle = document.createElement("div");
    shortsTitle.className = "mt-2 text-[11px] text-slate-300";
    shortsTitle.textContent = "Shorts";
    card.appendChild(shortsTitle);

    const row = document.createElement("div");
    row.className =
      "mt-1 flex gap-2 overflow-x-auto pb-1 scrollbar-thin scrollbar-thumb-slate-700";

    shorts.forEach((link) => {
      const s = document.createElement("a");
      s.href = link.original_url || link.normalized_url;
      s.target = "_blank";
      s.rel = "noopener noreferrer";
      s.className =
        "flex-shrink-0 w-32 bg-slate-950/70 rounded-lg overflow-hidden border border-slate-800/70";

      if (link.thumbnail_url) {
        const img = document.createElement("img");
        img.src = link.thumbnail_url;
        img.alt = link.title || "short";
        img.className = "w-full h-40 object-cover";
        s.appendChild(img);
      }

      const label = document.createElement("div");
      label.className =
        "px-1 py-1 text-[10px] text-slate-100 line-clamp-2 bg-slate-950/90";
      label.textContent = link.title || "(no title)";
      s.appendChild(label);

      row.appendChild(s);
    });

    card.appendChild(row);
  }
}

function renderListMode(card, cat, links) {
  const list = document.createElement("div");
  list.className = "flex flex-col gap-2";

  links.forEach((link) => {
    const row = document.createElement("div");
    row.className =
      "flex items-center gap-2 bg-slate-950/70 border border-slate-800/70 rounded-lg px-2 py-2";

    const thumb = document.createElement("a");
    thumb.href = link.original_url || link.normalized_url;
    thumb.target = "_blank";
    thumb.rel = "noopener noreferrer";
    thumb.className = "flex-shrink-0 w-20 h-12 bg-slate-800 overflow-hidden rounded";

    if (link.thumbnail_url) {
      const img = document.createElement("img");
      img.src = link.thumbnail_url;
      img.alt = link.title || "thumb";
      img.className = "w-full h-full object-cover";
      thumb.appendChild(img);
    }

    row.appendChild(thumb);

    const middle = document.createElement("div");
    middle.className = "flex-1 min-w-0";

    const titleEl = document.createElement("div");
    titleEl.className =
      "text-xs font-medium text-slate-50 leading-tight truncate";
    titleEl.textContent = link.title || "(no title)";
    middle.appendChild(titleEl);

    const metaEl = document.createElement("div");
    metaEl.className = "text-[10px] text-slate-400 truncate";
    metaEl.textContent = link.author
      ? `${link.author} • ${link.normalized_url}`
      : link.normalized_url;
    middle.appendChild(metaEl);

    const tagBox = document.createElement("input");
    tagBox.className =
      "w-full mt-1 text-[10px] px-1 py-[2px] bg-slate-950 border border-slate-700 rounded";
    tagBox.placeholder = "tags (comma separated)";
    tagBox.value = (link.tags || []).join(", ");
    tagBox.addEventListener("change", async () => {
      const tags = tagBox.value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await updateTags(link.id, tags);
      link.tags = tags;
      showToast("Tags updated.", "success");
    });
    middle.appendChild(tagBox);

    row.appendChild(middle);

    const right = document.createElement("div");
    right.className = "flex flex-col items-end gap-1 flex-shrink-0";

    if (link.duration) {
      const d = document.createElement("div");
      d.className =
        "text-[10px] px-1 py-[1px] rounded bg-black/70 text-slate-100";
      d.textContent = link.duration;
      right.appendChild(d);
    }

    const catSelect = document.createElement("select");
    catSelect.className =
      "bg-slate-950 border border-slate-700 rounded px-1 py-[2px] text-[10px]";
    appState.categories.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      if ((link.categories || []).includes(c) || primaryCategory(link) === c) opt.selected = true;
      catSelect.appendChild(opt);
    });
    catSelect.addEventListener("change", () => {
      changeLinkCategory(link.id, catSelect.value);
    });

    const delBtn = document.createElement("button");
    delBtn.className =
      "px-2 py-[3px] rounded bg-red-600 hover:bg-red-500 text-[10px]";
    delBtn.textContent = "✕";
    delBtn.title = "Delete";
    delBtn.addEventListener("click", () => deleteLink(link.id));

    right.appendChild(catSelect);
    right.appendChild(delBtn);

    row.appendChild(right);

    list.appendChild(row);
  });

  card.appendChild(list);
}


// ---------- DRAG & PASTE ----------

function setupDragAndPaste() {
  const dropZone = document.getElementById("drop-zone");
  const pasteArea = document.getElementById("paste-area");
  const addPastedBtn = document.getElementById("add-pasted-btn");

  if (!dropZone || !pasteArea || !addPastedBtn) return;

  dropZone.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    dropZone.classList.add("ring-2", "ring-sky-500");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("ring-2", "ring-sky-500");
  });

  dropZone.addEventListener("drop", (ev) => {
    ev.preventDefault();
    dropZone.classList.remove("ring-2", "ring-sky-500");

    const data =
      ev.dataTransfer.getData("text/uri-list") ||
      ev.dataTransfer.getData("text/plain");
    if (!data) return;

    const targetCat = lastSelectedCategory || "Unsorted";

    data
      .split(/\r?\n/)
      .map((u) => u.trim())
      .filter(Boolean)
      .forEach((u) => enqueueUrl(u, targetCat));

    showToast("Links queued…", "info");
  });

  addPastedBtn.addEventListener("click", () => {
    const lines = pasteArea.value.split(/\r?\n/);
    const targetCat = lastSelectedCategory || "Unsorted";
    lines
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((u) => enqueueUrl(u, targetCat));
    pasteArea.value = "";
    showToast("Links queued from pasted list…", "info");
  });
}


// ---------- CONTROLS ----------

function setupControls() {
  document
    .getElementById("add-category-btn")
    ?.addEventListener("click", () => {
      const input = document.getElementById("new-category-input");
      const val = input.value;
      input.value = "";
      addCategory(val);
    });

  document.getElementById("save-main-btn")?.addEventListener("click", saveMain);

  document
    .getElementById("export-json-btn")
    ?.addEventListener("click", async () => {
      const res = await fetch("/api/export/json");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "links.json";
      a.click();
      URL.revokeObjectURL(url);
    });

  document
    .getElementById("export-txt-btn")
    ?.addEventListener("click", async () => {
      const res = await fetch("/api/export/txt");
      const text = await res.text();
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "links.txt";
      a.click();
      URL.revokeObjectURL(url);
    });

  const themeSelect = document.getElementById("theme-select");
  const savedTheme = localStorage.getItem(THEME_KEY) || "glass";
  if (themeSelect) {
    themeSelect.value = savedTheme;
    setTheme(savedTheme);
    themeSelect.addEventListener("change", () => {
      setTheme(themeSelect.value);
    });
  }

  document.getElementById("duplicate-policy")?.addEventListener("change", async (e) => {
    settings.duplicatePolicy = e.target.value;
    saveSettings();
    await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duplicate_policy: e.target.value }),
    });
    showToast("Duplicate policy saved", "success");
  });

  document.getElementById("category-order")?.addEventListener("change", async (e) => {
    await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category_order_strategy: e.target.value }),
    });
    render();
  });

  document.getElementById("save-prefs")?.addEventListener("click", async () => {
    const sec = document.getElementById("limit-second");
    const minute = document.getElementById("limit-minute");
    await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rate_limit_per_second: Number(sec?.value || 20),
        rate_limit_per_minute: Number(minute?.value || 150),
      }),
    });
    showToast("Rate limits updated", "success");
  });

  const columnsRange = document.getElementById("grid-columns-range");
  const columnsLabel = document.getElementById("grid-columns-value");
  if (columnsRange && columnsLabel) {
    columnsRange.value = settings.columns.toString();
    columnsLabel.textContent = settings.columns.toString();

    columnsRange.addEventListener("input", () => {
      settings.columns = parseInt(columnsRange.value, 10) || 5;
      columnsLabel.textContent = settings.columns.toString();
      saveSettings();
      render();
    });
  }

  const viewGridBtn = document.getElementById("view-mode-grid");
  const viewListBtn = document.getElementById("view-mode-list");
  if (viewGridBtn && viewListBtn) {
    const updateViewButtons = () => {
      if (settings.viewMode === "grid") {
        viewGridBtn.classList.add("bg-sky-700");
        viewListBtn.classList.remove("bg-sky-700");
        viewListBtn.classList.add("bg-slate-700");
      } else {
        viewListBtn.classList.add("bg-sky-700");
        viewGridBtn.classList.remove("bg-sky-700");
        viewGridBtn.classList.add("bg-slate-700");
      }
    };
    updateViewButtons();

    viewGridBtn.addEventListener("click", () => {
      settings.viewMode = "grid";
      saveSettings();
      updateViewButtons();
      render();
    });
    viewListBtn.addEventListener("click", () => {
      settings.viewMode = "list";
      saveSettings();
      updateViewButtons();
      render();
    });
  }

  const sortSelect = document.getElementById("sort-select");
  if (sortSelect) {
    sortSelect.value = settings.sortMode;
    sortSelect.addEventListener("change", () => {
      settings.sortMode = sortSelect.value;
      saveSettings();
      render();
    });
  }

  const searchInput = document.getElementById("search-input");
  if (searchInput) {
    searchInput.value = currentSearchQuery;
    searchInput.addEventListener("input", () => {
      currentSearchQuery = searchInput.value;
      render();
    });
  }
}


// ---------- BOOT ----------

window.addEventListener("DOMContentLoaded", async () => {
  setupControls();
  setupDragAndPaste();
  setupQueueProcessor();
  await fetchDraft();
  setInterval(fetchDraft, 5000);
});
