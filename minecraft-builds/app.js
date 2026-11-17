/* ============================================================
   Build Archive
   ------------------------------------------------------------
   A local-first Minecraft build journal.

   • Builds are kept in IndexedDB on this device, so the page
     works even when opened straight from disk.
   • Screenshots are resized in the browser before anything is
     stored, then uploaded to GitHub when you publish.
   • All committed data lives in data/builds.json plus /photos,
     which GitHub Pages serves as a completely static site.
   ============================================================ */

(() => {
  "use strict";

  /* ---------------------------------------------------------- config */

  const DEFAULTS = {
    REPO: "",
    BRANCH: "main",
    DATA_PATH: "data/builds.json",
    PHOTO_DIR: "photos"
  };
  const CFG = Object.assign({}, DEFAULTS, window.BUILD_ARCHIVE_CONFIG || {});
  const CATEGORIES = ["Survival", "Creative", "Redstone", "Mega base", "Farm", "Other"];
  const SAMPLE_COUNT = 3;
  const MAX_PHOTOS = 12;
  const MAX_EDGE = 1600;
  const THUMB_EDGE = 720;
  const JPEG_QUALITY = 0.84;

  /* ---------------------------------------------------------- helpers */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const esc = (value) =>
    String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));

  const uid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  const debounce = (fn, ms) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  function relDate(ts) {
    const diff = Date.now() - ts;
    const day = 86400000;
    if (diff < 0) return "just now";
    if (diff < 60000) return "just now";
    if (diff < 3600000) return Math.round(diff / 60000) + " min ago";
    if (diff < day) return Math.round(diff / 3600000) + " h ago";
    if (diff < 2 * day) return "yesterday";
    if (diff < 30 * day) return Math.round(diff / day) + " days ago";
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric"
    });
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function catClass(category) {
    return (
      "cat--" +
      ({
        Survival: "survival",
        Creative: "creative",
        Redstone: "redstone",
        "Mega base": "mega",
        Farm: "farm"
      }[category] || "other")
    );
  }

  /* ---------------------------------------------------------- storage */

  const MEMORY = new Map();
  let dbPromise = null;

  function openDB() {
    if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB unavailable"));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("build-archive", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("archive")) db.createObjectStore("archive");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Could not open local database"));
      req.onblocked = () => reject(new Error("Local database is blocked by another tab"));
    });
    return dbPromise;
  }

  const storage = {
    async get(key) {
      try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const req = db.transaction("archive", "readonly").objectStore("archive").get(key);
          req.onsuccess = () => resolve(req.result == null ? null : req.result);
          req.onerror = () => reject(req.error);
        });
      } catch (err) {
        return MEMORY.has(key) ? MEMORY.get(key) : null;
      }
    },
    async set(key, value) {
      MEMORY.set(key, value);
      try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction("archive", "readwrite");
          tx.objectStore("archive").put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (err) {
        /* memory fallback already holds the value */
      }
    },
    async remove(key) {
      MEMORY.delete(key);
      try {
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction("archive", "readwrite");
          tx.objectStore("archive").delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (err) {
        /* ignore */
      }
    }
  };

  /* ---------------------------------------------------------- settings */

  const SETTINGS_KEY = "build-archive:github";

  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
    } catch (err) {
      saved = {};
    }
    return {
      repo: (saved.repo || CFG.REPO || "").trim(),
      branch: (saved.branch || CFG.BRANCH || "main").trim() || "main",
      token: saved.token || ""
    };
  }

  function saveSettingsToDisk() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (err) {
      toast("This browser would not save the publishing settings.", "error");
    }
  }

  let settings = loadSettings();
  const repoConfigured = () => !!settings.repo;

  function isLocalHost() {
    return (
      location.protocol === "file:" ||
      /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname)
    );
  }

  function rawUrl(path) {
    if (!path) return "";
    if (/^(https?:|data:|blob:)/i.test(path)) return path;
    if (!settings.repo) return path;
    return `https://raw.githubusercontent.com/${settings.repo}/${settings.branch}/${String(path).replace(/^\/+/, "")}`;
  }

  function mediaUrl(path) {
    if (!path) return "";
    if (/^(https?:|data:|blob:)/i.test(path)) return path;
    const clean = String(path).replace(/^\.?\//, "");
    return isLocalHost() ? rawUrl(clean) : clean;
  }

  /* ---------------------------------------------------------- state */

  const state = {
    builds: [],
    dirty: false,
    samples: false,
    readOnly: false,
    remoteConfigured: false,
    remoteReachable: null,
    filter: "all",
    query: "",
    sort: "newest",
    editingId: null,
    draftPhotos: [],
    detailId: null,
    detailPhoto: 0,
    lightboxPhotos: [],
    lightboxIndex: 0,
    busy: false
  };

  /* ---------------------------------------------------------- samples */

  function sampleBuilds() {
    const now = Date.now();
    const day = 86400000;
    return [
      {
        id: uid(),
        name: "The Copper Lighthouse",
        category: "Survival",
        coords: "312, 71, -880",
        biome: "Stony shore",
        world: "Survival · season 4",
        blocks: ["Copper", "Deepslate bricks", "Spruce planks", "Sea lanterns"],
        description:
          "Built on the headland where the first storm wrecked my boat. The copper is deliberately left to oxidise, so every visit changes the colour a little.",
        photos: [],
        createdAt: now - day * 2,
        updatedAt: now - day * 2,
        sample: true
      },
      {
        id: uid(),
        name: "Deepslate Trading Hall",
        category: "Redstone",
        coords: "-140, -32, 96",
        biome: "Deep dark",
        world: "Hardcore · day 640",
        blocks: ["Deepslate tiles", "Chiseled deepslate", "Redstone lamps", "Rails"],
        description:
          "Twenty-two villagers, one central rail loop, and a sculk sensor that kills the lamps when something big walks past. Three nights of digging, worth it.",
        photos: [],
        createdAt: now - day * 9,
        updatedAt: now - day * 9,
        sample: true
      },
      {
        id: uid(),
        name: "Cherry Grove Tea House",
        category: "Creative",
        coords: "1 204, 88, -76",
        biome: "Cherry grove",
        world: "Creative · build world",
        blocks: ["Cherry planks", "Pink petals", "Stripped cherry logs", "Campfires"],
        description:
          "A quiet stop between bigger projects: open walls, a low roof, and a pond that catches the blossoms at sunset. A survival-friendly version is in progress.",
        photos: [],
        createdAt: now - day * 21,
        updatedAt: now - day * 21,
        sample: true
      }
    ];
  }

  /* ---------------------------------------------------------- github */

  function ghHeaders(token) {
    return {
      Authorization: `Bearer ${token || settings.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }

  function encodePath(path) {
    return String(path)
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
  }

  async function http(url, options, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error("GitHub took too long to respond. Check your connection and try again.");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function ghError(res) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.message || "";
    } catch (err) {
      /* no body */
    }
    if (res.status === 401) return "GitHub rejected that token (401). Create a new one with Contents: Read and write.";
    if (res.status === 403) return "GitHub refused the write (403)." + (detail ? " " + detail : " The token may be read-only or expired.");
    if (res.status === 404) return "Repository not found (404). Check owner/repo, the branch name, and the token's repository access.";
    if (res.status === 409) return "The repository changed while publishing. Try again.";
    return `GitHub error ${res.status}${detail ? ": " + detail : ""}`;
  }

  async function fetchPublished() {
    if (!settings.repo) return [];
    const url = `https://raw.githubusercontent.com/${settings.repo}/${settings.branch}/${encodePath(CFG.DATA_PATH)}?v=${Date.now()}`;
    const res = await http(url, { cache: "no-store" });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Could not read ${CFG.DATA_PATH} (HTTP ${res.status}).`);
    const doc = await res.json();
    const list = Array.isArray(doc) ? doc : doc && doc.builds;
    if (!Array.isArray(list)) throw new Error("The published data file has an unexpected shape.");
    return list.map(normalizeBuild);
  }

  async function fetchSiteArchive() {
    // Visitors on the published site have no repository configured in this
    // browser, so read the committed index straight from the same origin.
    if (!/^https?:$/.test(location.protocol)) return null;
    try {
      const res = await http(`${CFG.DATA_PATH}?v=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return null;
      const doc = await res.json();
      const list = Array.isArray(doc) ? doc : doc && doc.builds;
      if (!Array.isArray(list)) return null;
      // The placeholder that ships with the site is marked published:false.
      if (doc && doc.published === false) return null;
      return list.map(normalizeBuild);
    } catch (err) {
      return null;
    }
  }

  function normalizeBuild(raw) {
    const blocks = Array.isArray(raw.blocks)
      ? raw.blocks.map((b) => String(b).trim()).filter(Boolean)
      : String(raw.blocks || "")
          .split(",")
          .map((b) => b.trim())
          .filter(Boolean);

    return {
      id: raw.id || uid(),
      name: String(raw.name || "Untitled build"),
      category: CATEGORIES.includes(raw.category) ? raw.category : "Other",
      coords: String(raw.coords || ""),
      biome: String(raw.biome || ""),
      world: String(raw.world || ""),
      blocks: blocks.slice(0, 30),
      description: String(raw.description || ""),
      photos: (Array.isArray(raw.photos) ? raw.photos : [])
        .filter((p) => p && (p.file || p.thumb || p.src || p.url))
        .map((p) => {
          const file = p.file || "";
          const thumbFile = p.thumb || file;
          const src = file ? mediaUrl(file) : p.src || p.url || mediaUrl(thumbFile);
          return {
            id: p.id || uid(),
            src,
            thumb: thumbFile ? mediaUrl(thumbFile) : src,
            file,
            thumbFile,
            w: Number(p.w) || 0,
            h: Number(p.h) || 0
          };
        }),
      createdAt: Date.parse(raw.createdAt) || Date.now(),
      updatedAt: Date.parse(raw.updatedAt) || Date.parse(raw.createdAt) || Date.now(),
      sample: !!raw.sample
    };
  }

  async function ghGetFile(path) {
    const res = await http(
      `https://api.github.com/repos/${settings.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(settings.branch)}`,
      { headers: ghHeaders(), cache: "no-store" },
      30000
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await ghError(res));
    return res.json();
  }

  async function ghPutFile(path, blob, message) {
    const existing = await ghGetFile(path);
    const payload = {
      message,
      content: await blobToBase64(blob),
      branch: settings.branch
    };
    if (existing && existing.sha) payload.sha = existing.sha;

    const res = await http(
      `https://api.github.com/repos/${settings.repo}/contents/${encodePath(path)}`,
      {
        method: "PUT",
        headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders()),
        body: JSON.stringify(payload)
      },
      45000
    );
    if (!res.ok) throw new Error(await ghError(res));
    return res.json();
  }

  async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(new Error("Could not read image data."));
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(dataUrl) {
    const [head, body] = String(dataUrl).split(",");
    if (!body) throw new Error("That image could not be prepared for upload.");
    const mime = (/data:([^;]+)/.exec(head) || [])[1] || "image/jpeg";
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  /* ---------------------------------------------------------- images */

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("That image could not be read. Try a JPG, PNG or WebP."));
      };
      img.src = url;
    });
  }

  async function resizeToDataUrl(source, maxEdge) {
    const sw = source.width || source.naturalWidth;
    const sh = source.height || source.naturalHeight;
    if (!sw || !sh) throw new Error("That image has no usable pixels.");
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0d1316";
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, w, h);
    return { dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY), width: w, height: h };
  }

  async function processImage(file) {
    if (!file.type || !file.type.startsWith("image/")) {
      throw new Error(`“${file.name}” is not an image.`);
    }
    if (file.size > 40 * 1024 * 1024) {
      throw new Error(`“${file.name}” is larger than 40 MB.`);
    }

    let source;
    if ("createImageBitmap" in window) {
      try {
        source = await createImageBitmap(file);
      } catch (err) {
        source = await loadImage(file);
      }
    } else {
      source = await loadImage(file);
    }

    const full = await resizeToDataUrl(source, MAX_EDGE);
    const thumb = await resizeToDataUrl(source, THUMB_EDGE);
    if (source.close) source.close();

    return { src: full.dataUrl, thumb: thumb.dataUrl, w: full.width, h: full.height };
  }

  /* ---------------------------------------------------------- data flow */

  async function persist() {
    await storage.set("snapshot", {
      builds: state.builds,
      dirty: state.dirty,
      repo: settings.repo || "",
      samples: state.samples,
      savedAt: Date.now()
    });
  }

  async function commit() {
    state.dirty = repoConfigured();
    state.readOnly = false;
    await persist();
    render();
  }

  async function loadArchive() {
    const snapshot = await storage.get("snapshot");
    state.remoteConfigured = repoConfigured();
    state.samples = !!(snapshot && snapshot.samples);

    if (state.remoteConfigured) {
      state.readOnly = false;
      try {
        const published = await fetchPublished();
        state.remoteReachable = true;

        if (snapshot && snapshot.repo === settings.repo && snapshot.dirty) {
          state.builds = snapshot.builds || [];
          state.dirty = true;
          state.samples = !!(snapshot.samples && state.builds.some((b) => b.sample));
        } else {
          state.builds = published;
          state.dirty = false;
          state.samples = false;
          await persist();
        }
      } catch (err) {
        console.warn("Build Archive:", err);
        state.remoteReachable = false;
        state.builds = (snapshot && snapshot.builds) || [];
        state.dirty = true;
        state.samples = !!(snapshot && snapshot.samples && state.builds.some((b) => b.sample));
      }
      return;
    }

    if (snapshot) {
      state.builds = snapshot.builds || [];
      state.dirty = false;
      state.samples = !!(snapshot.samples && state.builds.some((b) => b.sample));
      return;
    }

    // No repository configured and nothing stored locally: if the site was
    // deployed with a committed archive, show that to visitors.
    const siteArchive = await fetchSiteArchive();
    if (siteArchive) {
      state.builds = siteArchive;
      state.readOnly = true;
      state.samples = false;
      return;
    }

    state.builds = sampleBuilds();
    state.samples = true;
    await persist();
  }

  /* ---------------------------------------------------------- render */

  const PH_PALETTE = {
    Survival: ["#4f7a3a", "#5fbf4a", "#7ed957", "#6b4a2f", "#8a5a3b"],
    Creative: ["#7a6a2f", "#f2c14e", "#c9a227", "#4f7a3a", "#8a5a3b"],
    Redstone: ["#6e2b26", "#ff6b5e", "#b3413a", "#3a3f45", "#8e949a"],
    "Mega base": ["#2b5f63", "#4fd6d6", "#3a8f93", "#3a444c", "#8e949a"],
    Farm: ["#7a5f2f", "#ffc46b", "#c9a227", "#4f7a3a", "#8a5a3b"],
    Other: ["#39454d", "#5b6a73", "#8e949a", "#2c363d", "#a9b7bf"]
  };

  function placeholderHTML(build) {
    const colors = PH_PALETTE[build.category] || PH_PALETTE.Other;
    let seed = 7;
    const key = build.name + build.id;
    for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0;

    let cells = "";
    for (let i = 0; i < 24; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const color = colors[(seed >>> 8) % colors.length];
      const alpha = 0.32 + ((seed >>> 16) % 48) / 100;
      cells += `<i style="background:${color};opacity:${alpha.toFixed(2)}"></i>`;
    }
    return `<div class="ph" aria-hidden="true">${cells}</div>`;
  }

  function cardHTML(build) {
    const cover = build.photos[0];
    const count = build.photos.length;
    const tags = build.blocks
      .slice(0, 3)
      .map((block) => `<li class="tag">${esc(block)}</li>`)
      .join("");
    const moreTags = build.blocks.length > 3 ? `<li class="tag tag--more">+${build.blocks.length - 3}</li>` : "";

    const metaBits = [];
    if (build.coords) metaBits.push(esc(build.coords));
    if (build.biome) metaBits.push(esc(build.biome));

    return `<article class="card" data-id="${esc(build.id)}">
      <button class="card__thumb" type="button" data-open="${esc(build.id)}" aria-label="Open ${esc(build.name)}">
        ${
          cover
            ? `<img src="${esc(cover.thumb || cover.src)}" alt="${esc(build.name)} screenshot" loading="lazy" decoding="async" data-fallback="${esc(rawUrl(cover.file || cover.src))}">`
            : placeholderHTML(build)
        }
        <span class="badge ${catClass(build.category)}">${esc(build.category)}</span>
        ${build.sample ? '<span class="sample-flag">Sample</span>' : ""}
        ${count ? `<span class="card__count"><svg class="icon" aria-hidden="true"><use href="#i-image"/></svg>${count}</span>` : ""}
      </button>
      <div class="card__body">
        <button class="card__title" type="button" data-open="${esc(build.id)}">${esc(build.name)}</button>
        ${
          metaBits.length
            ? `<p class="card__meta"><svg class="icon" aria-hidden="true"><use href="#i-pin"/></svg>${metaBits.join(' <em>·</em> ')}</p>`
            : ""
        }
        ${build.description ? `<p class="card__desc">${esc(build.description)}</p>` : ""}
        ${tags ? `<ul class="tags">${tags}${moreTags}</ul>` : ""}
        <div class="card__foot">
          <span>${esc(relDate(build.createdAt))}</span>
          <span class="card__actions">
            <button class="mini-btn" type="button" data-edit="${esc(build.id)}" aria-label="Edit ${esc(build.name)}">
              <svg class="icon" aria-hidden="true"><use href="#i-pencil"/></svg>
            </button>
            <button class="mini-btn mini-btn--danger" type="button" data-del="${esc(build.id)}" aria-label="Delete ${esc(build.name)}">
              <svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>
            </button>
          </span>
        </div>
      </div>
    </article>`;
  }

  function visibleBuilds() {
    const query = state.query.trim().toLowerCase();
    let list = state.builds.filter((b) => state.filter === "all" || b.category === state.filter);

    if (query) {
      list = list.filter((b) =>
        [b.name, b.coords, b.biome, b.world, b.description, b.category, b.blocks.join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(query)
      );
    }

    const sorters = {
      newest: (a, b) => b.createdAt - a.createdAt,
      oldest: (a, b) => a.createdAt - b.createdAt,
      name: (a, b) => a.name.localeCompare(b.name),
      photos: (a, b) => b.photos.length - a.photos.length || b.createdAt - a.createdAt
    };
    return list.slice().sort(sorters[state.sort] || sorters.newest);
  }

  function render() {
    const list = visibleBuilds();
    const grid = $("#grid");
    grid.innerHTML = list.map(cardHTML).join("");

    const filtering = !!state.query.trim() || state.filter !== "all";
    const showEmpty = list.length === 0;
    grid.hidden = showEmpty;
    $("#empty").hidden = !showEmpty;
    if (showEmpty) {
      $("#emptyTitle").textContent = filtering ? "Nothing matches" : "No builds yet";
      $("#emptyText").textContent = filtering
        ? "Try another word, switch category, or clear the filters to see the whole archive."
        : "Add your first build with a few screenshots, the coordinates, and the blocks you used.";
      $("#emptyNewBtn").textContent = filtering ? "Clear filters" : "Add a build";
      $("#emptyNewBtn").dataset.action = filtering ? "clear" : "new";
    }

    const photoCount = state.builds.reduce((sum, b) => sum + b.photos.length, 0);
    const blockTypes = new Set();
    state.builds.forEach((b) => b.blocks.forEach((block) => blockTypes.add(block.toLowerCase())));
    $("#statBuilds").textContent = state.builds.length;
    $("#statPhotos").textContent = photoCount;
    $("#statBlocks").textContent = blockTypes.size;

    $("#archiveMeta").textContent = `${plural(state.builds.length, "build", "builds")} · ${plural(photoCount, "screenshot", "screenshots")}`;

    const hasSamples = state.samples && state.builds.some((b) => b.sample);
    $("#sampleBanner").hidden = !hasSamples;

    const showPending = state.remoteConfigured && (state.dirty || state.remoteReachable === false);
    $("#pendingBanner").hidden = !showPending;
    if (showPending) {
      $("#pendingText").textContent =
        state.remoteReachable === false
          ? "GitHub could not be reached, so these edits are only in this browser. Publish when you are back online."
          : `Publish to update ${settings.repo} and your live site.`;
    }

    const publishBtn = $("#publishBtn");
    if (publishBtn) {
      publishBtn.disabled = state.busy;
      publishBtn.textContent = state.busy ? "Publishing…" : "Publish to GitHub";
    }

    const statusChip = $("#statusChip");
    const statusText = $("#statusText");
    if (!state.remoteConfigured && state.readOnly) {
      statusChip.dataset.state = "synced";
      statusText.textContent = "Published archive";
    } else if (!state.remoteConfigured) {
      statusChip.dataset.state = "local";
      statusText.textContent = "Saved on this device";
    } else if (state.remoteReachable === false) {
      statusChip.dataset.state = "offline";
      statusText.textContent = "GitHub unreachable";
    } else if (state.dirty) {
      statusChip.dataset.state = "dirty";
      statusText.textContent = "Unpublished changes";
    } else {
      statusChip.dataset.state = "synced";
      statusText.textContent = "Synced with GitHub";
    }

    $("#storageNote").textContent = state.readOnly
      ? "You are viewing the archive published in this repository. Connect GitHub under Publishing to add or edit builds from this browser."
      : !state.remoteConfigured
        ? "Everything is saved in this browser. Export a backup to move the archive to another device, or connect GitHub to publish it."
        : state.dirty
          ? "Unpublished edits are stored in this browser. Publish to commit them to your repository."
          : `Published from ${settings.repo}. Screenshots live in the repository's ${CFG.PHOTO_DIR} folder.`;
  }

  /* ---------------------------------------------------------- toasts */

  function toast(message, type = "success", ms = 4500) {
    const el = document.createElement("div");
    el.className = `toast toast--${type}`;
    const icon = type === "error" ? "i-alert" : type === "info" ? "i-cloud" : "i-check";
    el.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg><span></span>`;
    el.querySelector("span").textContent = message;
    $("#toasts").appendChild(el);
    setTimeout(() => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 240);
    }, ms);
  }

  /* ---------------------------------------------------------- dialogs */

  function showDialog(dialog) {
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = "hidden";
  }

  function closeDialog(dialog) {
    if (dialog && dialog.open) dialog.close();
  }

  function syncBodyLock() {
    if (!document.querySelector("dialog[open]")) document.body.style.overflow = "";
  }

  /* ---------------------------------------------------------- editor */

  function openEditor(id) {
    const build = id ? state.builds.find((b) => b.id === id) : null;
    state.editingId = build ? build.id : null;

    $("#editorKicker").textContent = build ? "Editing" : "New entry";
    $("#editorTitle").textContent = build ? "Edit build" : "Add a build";
    $("#fName").value = build ? build.name : "";
    $("#fCategory").value = build ? build.category : "Survival";
    $("#fCoords").value = build ? build.coords : "";
    $("#fBiome").value = build ? build.biome : "";
    $("#fWorld").value = build ? build.world : "";
    $("#fBlocks").value = build ? build.blocks.join(", ") : "";
    $("#fDesc").value = build ? build.description : "";
    $("#descCount").textContent = String($("#fDesc").value.length);
    $("#formDelete").hidden = !build;
    $("#fName").removeAttribute("aria-invalid");

    state.draftPhotos = (build ? build.photos : []).map((p) => Object.assign({}, p, {
      preview: p.thumb || p.src
    }));
    renderDraftThumbs();

    showDialog($("#editorDialog"));
    requestAnimationFrame(() => $("#fName").focus());
  }

  function renderDraftThumbs() {
    $("#draftThumbs").innerHTML = state.draftPhotos
      .map(
        (photo, index) => `<div class="thumb">
          <img src="${esc(photo.preview || photo.thumb || photo.src)}" alt="Screenshot ${index + 1}">
          ${index === 0 ? '<span class="thumb__cover">COVER</span>' : ""}
          <button class="thumb__remove" type="button" data-photo-remove="${index}" aria-label="Remove screenshot ${index + 1}">
            <svg class="icon" aria-hidden="true"><use href="#i-x"/></svg>
          </button>
        </div>`
      )
      .join("");
  }

  async function addPhotos(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const room = MAX_PHOTOS - state.draftPhotos.length;
    if (room <= 0) {
      toast(`You can attach up to ${MAX_PHOTOS} screenshots to a build.`, "info");
      return;
    }
    if (files.length > room) {
      toast(`Only ${room} more screenshot${room === 1 ? "" : "s"} fit on this build.`, "info");
    }

    const dropzone = $("#dropzone");
    const label = dropzone.querySelector("strong");
    const original = label.textContent;

    for (let i = 0; i < Math.min(files.length, room); i++) {
      label.textContent = `Preparing ${i + 1} of ${Math.min(files.length, room)}…`;
      try {
        const image = await processImage(files[i]);
        state.draftPhotos.push({
          id: uid(),
          src: image.src,
          thumb: image.thumb,
          preview: image.thumb,
          w: image.w,
          h: image.h,
          file: "",
          thumbFile: ""
        });
        renderDraftThumbs();
      } catch (err) {
        toast(err.message || "That image could not be added.", "error");
      }
    }
    label.textContent = original;
  }

  async function saveBuild(event) {
    event.preventDefault();

    const name = $("#fName").value.trim();
    if (!name) {
      $("#fName").setAttribute("aria-invalid", "true");
      $("#fName").focus();
      toast("Give the build a name first.", "info");
      return;
    }
    $("#fName").removeAttribute("aria-invalid");

    const blocks = $("#fBlocks").value
      .split(",")
      .map((block) => block.trim())
      .filter(Boolean)
      .slice(0, 30);

    const now = Date.now();
    const existing = state.editingId ? state.builds.find((b) => b.id === state.editingId) : null;

    const build = {
      id: existing ? existing.id : uid(),
      name,
      category: CATEGORIES.includes($("#fCategory").value) ? $("#fCategory").value : "Other",
      coords: $("#fCoords").value.trim(),
      biome: $("#fBiome").value.trim(),
      world: $("#fWorld").value.trim(),
      blocks,
      description: $("#fDesc").value.trim(),
      photos: state.draftPhotos.map((p) => ({
        id: p.id,
        src: p.src,
        thumb: p.thumb || p.src,
        file: p.file || "",
        thumbFile: p.thumbFile || "",
        w: p.w || 0,
        h: p.h || 0
      })),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      sample: false
    };

    if (existing) {
      Object.assign(existing, build);
    } else {
      state.builds.unshift(build);
    }

    await commit();
    closeDialog($("#editorDialog"));
    toast(existing ? "Build updated." : "Build added to the archive.", "success");
  }

  async function deleteBuild(id) {
    const build = state.builds.find((b) => b.id === id);
    if (!build) return;
    if (!confirm(`Delete “${build.name}”? This cannot be undone.`)) return;

    state.builds = state.builds.filter((b) => b.id !== id);
    await commit();
    closeDialog($("#editorDialog"));
    closeDialog($("#detailDialog"));
    closeDialog($("#lightbox"));
    toast("Build deleted.", "success");
  }

  /* ---------------------------------------------------------- detail */

  function openDetail(id) {
    const build = state.builds.find((b) => b.id === id);
    if (!build) return;

    state.detailId = build.id;
    state.detailPhoto = 0;

    $("#detailCategory").textContent = build.category;
    $("#detailName").textContent = build.name;

    const facts = [
      ["Coordinates", build.coords || "—"],
      ["Biome", build.biome || "—"],
      ["World", build.world || "—"],
      ["Added", new Date(build.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })]
    ];
    $("#detailFacts").innerHTML = facts
      .map(
        ([label, value]) =>
          `<div><dt>${esc(label)}</dt><dd class="${value === "—" ? "is-empty" : ""}">${esc(value)}</dd></div>`
      )
      .join("");

    const desc = $("#detailDesc");
    desc.textContent = build.description || "No notes on this one yet.";
    desc.style.color = build.description ? "" : "var(--dim)";

    $("#detailBlocks").innerHTML = build.blocks.length
      ? build.blocks.map((block) => `<span class="tag">${esc(block)}</span>`).join("")
      : '<span class="hint">No blocks listed.</span>';

    renderGallery();
    showDialog($("#detailDialog"));
  }

  function renderGallery() {
    const build = state.builds.find((b) => b.id === state.detailId);
    if (!build) return;

    const photo = build.photos[state.detailPhoto];
    const image = $("#galleryImage");
    if (photo) {
      image.src = photo.src;
      image.dataset.fallback = rawUrl(photo.file || photo.src);
      image.alt = `${build.name} — screenshot ${state.detailPhoto + 1}`;
      image.hidden = false;
      $("#galleryEmpty").hidden = true;
      $("#galleryMain").disabled = false;
    } else {
      image.removeAttribute("src");
      image.removeAttribute("data-fallback");
      image.hidden = true;
      $("#galleryEmpty").hidden = false;
      $("#galleryMain").disabled = true;
    }

    $("#galleryThumbs").innerHTML = build.photos
      .map(
        (p, index) =>
          `<button type="button" class="${index === state.detailPhoto ? "is-active" : ""}" data-photo="${index}" aria-label="Show screenshot ${index + 1}">
            <img src="${esc(p.thumb || p.src)}" alt="">
          </button>`
      )
      .join("");
  }

  function openLightbox(index) {
    const build = state.builds.find((b) => b.id === state.detailId);
    if (!build || !build.photos.length) return;
    state.lightboxPhotos = build.photos.map((p) => p.src);
    state.lightboxIndex = clamp(index, 0, state.lightboxPhotos.length - 1);
    updateLightbox();
    showDialog($("#lightbox"));
  }

  function updateLightbox() {
    const photos = state.lightboxPhotos;
    if (!photos.length) return closeDialog($("#lightbox"));
    state.lightboxIndex = (state.lightboxIndex + photos.length) % photos.length;
    $("#lightboxImage").src = photos[state.lightboxIndex];
    $("#lightboxImage").alt = `Screenshot ${state.lightboxIndex + 1} of ${photos.length}`;
    $("#lightboxCount").textContent = `${state.lightboxIndex + 1} / ${photos.length}`;
    $("#lightboxPrev").hidden = photos.length < 2;
    $("#lightboxNext").hidden = photos.length < 2;
  }

  /* ---------------------------------------------------------- import / export */

  function serializeBuild(build) {
    return {
      id: build.id,
      name: build.name,
      category: build.category,
      coords: build.coords,
      biome: build.biome,
      world: build.world,
      blocks: build.blocks,
      description: build.description,
      photos: build.photos.map((p) => ({
        id: p.id,
        file: p.file || "",
        thumbFile: p.thumbFile || "",
        src: p.file ? "" : p.src || "",
        thumb: p.file ? "" : p.thumb || "",
        w: p.w || 0,
        h: p.h || 0
      })),
      createdAt: new Date(build.createdAt).toISOString(),
      updatedAt: new Date(build.updatedAt).toISOString(),
      sample: !!build.sample
    };
  }

  function exportArchive() {
    const doc = {
      app: "Build Archive",
      version: 1,
      exportedAt: new Date().toISOString(),
      builds: state.builds.map(serializeBuild)
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `build-archive-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 3000);
    toast(`Backup of ${plural(state.builds.length, "build", "builds")} downloaded.`, "success");
  }

  async function importArchive(file) {
    try {
      const text = await file.text();
      const doc = JSON.parse(text);
      const list = Array.isArray(doc) ? doc : doc && doc.builds;
      if (!Array.isArray(list)) throw new Error("That file is not a Build Archive backup.");
      if (!list.length) {
        toast("That backup contains no builds.", "info");
        return;
      }

      let added = 0;
      let updated = 0;
      list.map(normalizeBuild).forEach((build) => {
        const index = state.builds.findIndex((b) => b.id === build.id);
        if (index >= 0) {
          state.builds[index] = Object.assign({}, build, { sample: false });
          updated++;
        } else {
          state.builds.unshift(Object.assign({}, build, { sample: false }));
          added++;
        }
      });

      await commit();
      toast(
        `Imported ${plural(added + updated, "build", "builds")} (${added} new, ${updated} updated).`,
        "success",
        6000
      );
    } catch (err) {
      console.error(err);
      toast(err.message || "Could not read that backup file.", "error", 6000);
    }
  }

  /* ---------------------------------------------------------- publishing */

  function setPublishLabel(text) {
    const btn = $("#publishBtn");
    if (btn) btn.textContent = text;
  }

  async function publish() {
    if (state.busy) return;

    if (!settings.repo) {
      toast("Choose a GitHub repository first.", "info");
      openSettings();
      return;
    }
    if (!settings.token) {
      toast("Add a GitHub access token to publish.", "info");
      openSettings();
      return;
    }
    if (!state.builds.length) {
      toast("There is nothing to publish yet.", "info");
      return;
    }

    state.busy = true;
    render();
    $("#publishBtn").disabled = true;

    const builds = state.builds.map((b) => Object.assign({}, b, {
      photos: b.photos.map((p) => Object.assign({}, p))
    }));

    const pending = builds.reduce(
      (sum, b) => sum + b.photos.filter((p) => !p.file && /^data:/i.test(p.src || "")).length,
      0
    );
    let uploaded = 0;

    try {
      for (const build of builds) {
        for (const photo of build.photos) {
          if (photo.file || !/^data:/i.test(photo.src || "")) continue;
          uploaded++;
          setPublishLabel(`Uploading screenshot ${uploaded}/${pending}…`);
          const base = `${CFG.PHOTO_DIR}/${build.id}/${photo.id}`;
          await ghPutFile(`${base}.jpg`, dataUrlToBlob(photo.src), `Add screenshot to ${build.name}`);
          await ghPutFile(`${base}-thumb.jpg`, dataUrlToBlob(photo.thumb || photo.src), `Add thumbnail to ${build.name}`);
          photo.file = `${base}.jpg`;
          photo.thumbFile = `${base}-thumb.jpg`;
        }
      }

      const doc = {
        version: 1,
        published: true,
        updatedAt: new Date().toISOString(),
        builds: builds.map((build) => ({
          id: build.id,
          name: build.name,
          category: build.category,
          coords: build.coords,
          biome: build.biome,
          world: build.world,
          blocks: build.blocks,
          description: build.description,
          photos: build.photos
            .filter((p) => p.file || /^https?:/i.test(p.src || ""))
            .map((p) => ({
              id: p.id,
              file: p.file || "",
              thumb: p.thumbFile || "",
              url: p.file ? "" : p.src,
              w: p.w || 0,
              h: p.h || 0
            })),
          createdAt: new Date(build.createdAt).toISOString(),
          updatedAt: new Date(build.updatedAt).toISOString(),
          sample: !!build.sample
        }))
      };

      setPublishLabel("Writing data/builds.json…");
      await ghPutFile(
        CFG.DATA_PATH,
        new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
        "Update build archive"
      );

      state.builds = builds;
      state.dirty = false;
      state.remoteReachable = true;
      state.samples = false;
      await persist();
      render();
      toast(`Published ${plural(builds.length, "build", "builds")} to ${settings.repo}. GitHub Pages goes live in about a minute.`, "success", 8000);
    } catch (err) {
      console.error(err);
      toast(err.message || "Publishing failed. Nothing was lost — your changes are still here.", "error", 9000);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function refreshRemote(mode) {
    // mode: "reload" replaces everything, "merge" keeps local-only work
    try {
      const published = await fetchPublished();
      state.remoteReachable = true;

      if (mode === "merge") {
        const localById = new Map(state.builds.map((b) => [b.id, b]));
        const remoteIds = new Set(published.map((b) => b.id));
        let dirty = false;

        const merged = published.map((remote) => {
          const local = localById.get(remote.id);
          if (local && !local.sample && local.updatedAt > remote.updatedAt) {
            dirty = true;
            return local;
          }
          return remote;
        });

        const extras = state.builds.filter((b) => !remoteIds.has(b.id) && !b.sample);
        if (extras.length) dirty = true;

        state.builds = extras.concat(merged);
        state.dirty = dirty;
        state.samples = false;
      } else {
        state.builds = published;
        state.dirty = false;
        state.samples = false;
      }

      await persist();
      render();
      return true;
    } catch (err) {
      console.warn("Build Archive:", err);
      state.remoteReachable = false;
      render();
      throw err;
    }
  }

  async function discardChanges() {
    if (!confirm("Discard the unpublished changes in this browser and reload what is on GitHub?")) return;
    try {
      await refreshRemote("reload");
      toast("Reloaded the published archive.", "info");
    } catch (err) {
      toast(err.message || "Could not reload from GitHub.", "error");
    }
  }

  /* ---------------------------------------------------------- settings UI */

  function setSettingsMsg(text, kind) {
    const el = $("#settingsMsg");
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      el.className = "callout";
      return;
    }
    el.hidden = false;
    el.className = "callout " + (kind === "error" ? "is-error" : kind === "ok" ? "is-ok" : "callout--info");
    el.textContent = text;
  }

  function openSettings() {
    $("#sRepo").value = settings.repo;
    $("#sBranch").value = settings.branch;
    $("#sToken").value = settings.token;
    $("#disconnectBtn").hidden = !settings.repo && !settings.token;
    setSettingsMsg("");
    showDialog($("#settingsDialog"));
    requestAnimationFrame(() => $("#sRepo").focus());
  }

  async function submitSettings(event) {
    event.preventDefault();

    const repo = $("#sRepo")
      .value.trim()
      .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
    const branch = $("#sBranch").value.trim() || "main";
    const token = $("#sToken").value.trim();

    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      setSettingsMsg("Use the owner/repository form, for example seeth/minecraft-builds.", "error");
      return;
    }

    const button = $("#settingsSaveBtn");
    button.disabled = true;
    button.textContent = "Testing…";
    setSettingsMsg("");

    try {
      if (token) {
        const res = await http(`https://api.github.com/repos/${repo}`, { headers: ghHeaders(token), cache: "no-store" });
        if (!res.ok) throw new Error(await ghError(res, token));
      }

      settings = { repo, branch, token };
      saveSettingsToDisk();
      state.remoteConfigured = true;

      let loaded = true;
      try {
        await refreshRemote("merge");
      } catch (err) {
        loaded = false;
      }

      closeDialog($("#settingsDialog"));
      if (token) {
        toast(
          loaded
            ? `Connected to ${repo}.`
            : `Connected to ${repo}, but its archive file could not be read yet. Publish to create it.`,
          loaded ? "success" : "info",
          6500
        );
      } else {
        toast(`Saved ${repo} without a token — browsing only.`, "info", 6500);
      }
    } catch (err) {
      console.error(err);
      setSettingsMsg(err.message || "Could not reach GitHub.", "error");
    } finally {
      button.disabled = false;
      button.textContent = "Save & test";
    }
  }

  function disconnect() {
    if (!confirm("Forget the repository and token in this browser? Your local builds stay here.")) return;
    settings = { repo: "", branch: "main", token: "" };
    saveSettingsToDisk();
    state.remoteConfigured = false;
    state.remoteReachable = null;
    state.dirty = false;
    persist().then(render);
    closeDialog($("#settingsDialog"));
    toast("GitHub disconnected. The archive is local again.", "info");
  }

  /* ---------------------------------------------------------- samples */

  async function removeSamples() {
    state.builds = state.builds.filter((b) => !b.sample);
    state.samples = false;
    await commit();
    toast("Sample builds removed.", "info");
  }

  /* ---------------------------------------------------------- events */

  function bindEvents() {
    const openNew = () => openEditor(null);
    ["#newBtn", "#heroNewBtn"].forEach((sel) => $(sel).addEventListener("click", openNew));

    $("#emptyNewBtn").addEventListener("click", () => {
      if ($("#emptyNewBtn").dataset.action === "clear") {
        state.query = "";
        state.filter = "all";
        $("#searchInput").value = "";
        $$(".chip").forEach((chip) => chip.classList.toggle("is-active", chip.dataset.cat === "all"));
        render();
      } else {
        openNew();
      }
    });

    const onSearch = debounce(() => {
      state.query = $("#searchInput").value;
      render();
    }, 120);
    $("#searchInput").addEventListener("input", onSearch);

    $("#chips").addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (!chip) return;
      state.filter = chip.dataset.cat;
      $$(".chip").forEach((c) => c.classList.toggle("is-active", c === chip));
      render();
    });

    $("#sortSelect").addEventListener("change", (event) => {
      state.sort = event.target.value;
      render();
    });

    $("#grid").addEventListener("click", (event) => {
      const open = event.target.closest("[data-open]");
      if (open) {
        openDetail(open.dataset.open);
        return;
      }
      const edit = event.target.closest("[data-edit]");
      if (edit) {
        openEditor(edit.dataset.edit);
        return;
      }
      const del = event.target.closest("[data-del]");
      if (del) deleteBuild(del.dataset.del);
    });

    $("#buildForm").addEventListener("submit", saveBuild);
    $("#descCount").textContent = "0";
    $("#fDesc").addEventListener("input", (event) => {
      $("#descCount").textContent = String(event.target.value.length);
    });

    $("#formDelete").addEventListener("click", () => {
      if (state.editingId) deleteBuild(state.editingId);
    });

    const photoInput = $("#photoInput");
    const dropzone = $("#dropzone");

    dropzone.addEventListener("click", () => photoInput.click());
    dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        photoInput.click();
      }
    });

    photoInput.addEventListener("change", async () => {
      await addPhotos(photoInput.files);
      photoInput.value = "";
    });

    ["dragenter", "dragover"].forEach((type) =>
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.add("is-drag");
      })
    );
    ["dragleave", "dragend"].forEach((type) =>
      dropzone.addEventListener(type, () => dropzone.classList.remove("is-drag"))
    );
    dropzone.addEventListener("drop", async (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-drag");
      await addPhotos(event.dataTransfer.files);
    });

    $("#draftThumbs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-photo-remove]");
      if (!button) return;
      const index = Number(button.dataset.photoRemove);
      if (Number.isFinite(index)) {
        state.draftPhotos.splice(index, 1);
        renderDraftThumbs();
      }
    });

    $("#detailEdit").addEventListener("click", () => {
      const id = state.detailId;
      closeDialog($("#detailDialog"));
      if (id) openEditor(id);
    });
    $("#detailDelete").addEventListener("click", () => {
      if (state.detailId) deleteBuild(state.detailId);
    });

    $("#galleryThumbs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-photo]");
      if (!button) return;
      state.detailPhoto = Number(button.dataset.photo);
      renderGallery();
    });
    $("#galleryMain").addEventListener("click", () => openLightbox(state.detailPhoto));

    $("#lightboxPrev").addEventListener("click", () => {
      state.lightboxIndex -= 1;
      updateLightbox();
    });
    $("#lightboxNext").addEventListener("click", () => {
      state.lightboxIndex += 1;
      updateLightbox();
    });

    $("#exportBtn").addEventListener("click", exportArchive);
    $("#importBtn").addEventListener("click", () => $("#importInput").click());
    $("#importInput").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (file) await importArchive(file);
    });

    $("#publishBtn").addEventListener("click", publish);
    $("#discardBtn").addEventListener("click", discardChanges);
    $("#removeSamplesBtn").addEventListener("click", removeSamples);

    $("#settingsBtn").addEventListener("click", openSettings);
    $("#footerSettingsBtn").addEventListener("click", openSettings);
    $("#settingsForm").addEventListener("submit", submitSettings);
    $("#disconnectBtn").addEventListener("click", disconnect);

    $("#helpBtn").addEventListener("click", () => showDialog($("#helpDialog")));

    $$("[data-close]").forEach((button) =>
      button.addEventListener("click", () => closeDialog(button.closest("dialog")))
    );

    $$("dialog").forEach((dialog) => {
      dialog.addEventListener("close", syncBodyLock);
      dialog.addEventListener("cancel", () => setTimeout(syncBodyLock, 0));
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) {
          const rect = dialog.getBoundingClientRect();
          const outside =
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom;
          if (outside || dialog.classList.contains("lightbox")) closeDialog(dialog);
        }
      });
    });

    document.addEventListener("keydown", (event) => {
      const typing = /^(input|textarea|select)$/i.test(event.target.tagName) || event.target.isContentEditable;

      if ($("#lightbox").open) {
        if (event.key === "ArrowLeft") {
          state.lightboxIndex -= 1;
          updateLightbox();
        } else if (event.key === "ArrowRight") {
          state.lightboxIndex += 1;
          updateLightbox();
        }
        return;
      }

      if (event.key === "/" && !typing) {
        event.preventDefault();
        $("#searchInput").focus();
      }
    });

    // Replace relative photo URLs that 404 with their GitHub raw fallback.
    document.addEventListener(
      "error",
      (event) => {
        const img = event.target;
        if (!(img instanceof HTMLImageElement)) return;
        const fallback = img.dataset.fallback;
        if (fallback && !img.dataset.fellback) {
          img.dataset.fellback = "true";
          img.src = fallback;
        }
      },
      true
    );
  }

  /* ---------------------------------------------------------- boot */

  async function boot() {
    bindEvents();
    try {
      await loadArchive();
    } catch (err) {
      console.error(err);
      toast("The archive could not be loaded. Export a backup before closing this tab.", "error", 12000);
    }
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
