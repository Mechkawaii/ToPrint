/* Mechkawaii Production - app.js
   Stock + plan d'impression + historique (localStorage)
   + Indicateurs critiques (rouge/jaune/vert)
   + File d'impression automatique sur 2 jours
   + Vignettes d'images (./assets/images/<id>.png)
*/

const STORAGE_KEY = "mechkawaii-production:v1";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function nowISO() {
  return new Date().toISOString();
}
function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}
function clampInt(n, fallback = 0) {
  const x = Number.parseInt(n, 10);
  return Number.isFinite(x) ? x : fallback;
}
function ceilDiv(a, b) {
  if (b <= 0) return 0;
  return Math.ceil(a / b);
}

/** Image path for an item (auto: ./assets/images/<id>.png) */
function imgPathFor(it) {
  return it.image || `./assets/images/${it.id}.png`;
}

async function loadBaseItems() {
  // Prefer root items.json, fallback to legacy ./data/items.json
  let res = await fetch("./items.json", { cache: "no-store" });
  if (!res.ok) {
    res = await fetch("./data/items.json", { cache: "no-store" });
  }
  if (!res.ok) throw new Error("Impossible de charger items.json");
  return await res.json();
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function makeInitialState(items) {
  return {
    bufferBoxes: 5,
    items: items.map((it) => ({ ...it })),
    log: [] // {ts,type,itemId,itemName,qty,detail, snapshotBefore?}
  };
}


function mergeBaseIntoState(baseItems) {
  // Merge base definitions into current state while preserving user stocks.
  // Key = id.
  const baseById = new Map(baseItems.map(it => [String(it.id), it]));
  const seen = new Set();

  // Update existing items
  state.items = state.items.map((it) => {
    const id = String(it.id);
    const base = baseById.get(id);
    seen.add(id);
    if (!base) return it;

    return {
      ...base,
      // preserve current stock and any user tweaks
      stock: clampInt(it.stock, clampInt(base.stock, 0)),
      // preserve image override if user has one
      image: (it.image !== undefined && it.image !== null && it.image !== "") ? it.image : base.image,
    };
  });

  // Add any missing items from base
  for (const base of baseItems) {
    const id = String(base.id);
    if (seen.has(id)) continue;
    state.items.push({ ...base, stock: clampInt(base.stock, 0) });
  }
}


function getItem(state, id) {
  return state.items.find((x) => x.id === id);
}

function computeKpis(state) {
  const items = state.items;

  const boxesPossibleByItem = items
    .filter((it) => it.perBox > 0)
    .map((it) => Math.floor(it.stock / it.perBox));

  const boxesPossible = boxesPossibleByItem.length ? Math.min(...boxesPossibleByItem) : 0;

  const minVal = boxesPossibleByItem.length ? Math.min(...boxesPossibleByItem) : 0;
  const bottlenecks = items
    .filter((it) => it.perBox > 0)
    .filter((it) => Math.floor(it.stock / it.perBox) === minVal)
    .map((it) => it.name);

  const targetBoxes = state.bufferBoxes;
  const critical = items.filter((it) => it.perBox > 0 && it.stock < targetBoxes * it.perBox).length;
  const lines = items.length;

  return { boxesPossible, bottlenecks, critical, lines };
}

function buildPrintPlan(state) {
  const targetBoxes = state.bufferBoxes;
  const items = state.items.filter((it) => it.perBox > 0);

  const plan = items.map((it) => {
    const targetStock = targetBoxes * it.perBox;
    const need = Math.max(0, targetStock - it.stock);
    const plates = need > 0 ? ceilDiv(need, it.perPlate) : 0;
    const produce = plates * it.perPlate;
    const boxesPossible = Math.floor(it.stock / it.perBox);
    const why = [];
    if (need === 0) why.push("OK tampon");
    else why.push("Stock < tampon");
    return {
      id: it.id,
      name: it.name,
      stock: it.stock,
      perBox: it.perBox,
      perPlate: it.perPlate,
      targetStock,
      need,
      plates,
      produce,
      boxesPossible,
      why
    };
  });

  const minBoxes = plan.length ? Math.min(...plan.map((p) => p.boxesPossible)) : 0;
  plan.forEach((p) => {
    if (p.boxesPossible === minBoxes) p.why.unshift("Goulot boîte");
  });

  // Sorting: bottleneck first, then deficit, then need, then quick wins
  plan.sort((a, b) => {
    if (a.boxesPossible !== b.boxesPossible) return a.boxesPossible - b.boxesPossible;
    const defA = targetBoxes - a.stock / a.perBox;
    const defB = targetBoxes - b.stock / b.perBox;
    if (defA !== defB) return defB - defA;
    if (a.need !== b.need) return b.need - a.need;
    if (a.plates !== b.plates) return a.plates - b.plates;
    return a.name.localeCompare(b.name, "fr");
  });

  return plan;
}

function renderKpis(state) {
  const { boxesPossible, bottlenecks, critical, lines } = computeKpis(state);
  const el = $("#kpis");
  if (!el) return;
  el.innerHTML = "";

  const mk = (label, value, hint = "") => {
    const d = document.createElement("div");
    d.className = "kpi";
    d.innerHTML = `
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      <div class="hint">${hint}</div>
    `;
    return d;
  };

  el.appendChild(mk("Boîtes complètes possibles", boxesPossible, "Selon tes stocks actuels"));
  el.appendChild(
    mk(
      "Pièces goulots",
      bottlenecks.length
        ? bottlenecks.slice(0, 3).join(", ") + (bottlenecks.length > 3 ? "…" : "")
        : "—",
      "Ce qui bloque la fermeture de boîtes"
    )
  );
  el.appendChild(mk("Pièces sous tampon", critical, `Sous ${state.bufferBoxes} boîtes de stock cible`));
  el.appendChild(mk("Références suivies", lines, "Lignes de ton tableau"));
}

function renderPrintTable(state) {
  const table = $("#printTable");
  if (!table) return;
  const tbody = $("#printTable tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  const plan = buildPrintPlan(state);

  plan.forEach((p, idx) => {
    const tr = document.createElement("tr");

    // 🔴/🟡/🟢 status
    const isCritical = p.stock < p.perBox; // can't assemble 1 box
    const isLow = !isCritical && p.stock < state.bufferBoxes * p.perBox;

    if (isCritical) tr.classList.add("tr-critical");
    else if (isLow) tr.classList.add("tr-low");

    const badge = isCritical
      ? `<span class="badge critical">CRITIQUE</span>`
      : isLow
      ? `<span class="badge low">SOUS TAMPON</span>`
      : `<span class="badge ok">OK</span>`;

    const whyText = p.why.join(" • ");

    const needPill =
      p.need === 0 ? `<span class="pill ok">OK</span>` : `<span class="pill bad">Manque ${p.need}</span>`;

    const platesText = p.plates === 0 ? "—" : String(p.plates);
    const produceText = p.produce === 0 ? "—" : `+${p.produce}`;

    const btn =
      p.plates === 0
        ? `<button class="btn btn-ghost" disabled>Rien à faire</button>`
        : `<button class="btn btn-accent" data-action="printed" data-id="${p.id}">Imprimé</button>`;

    tr.innerHTML = `
      <td><strong>${idx + 1}</strong></td>

      <td>
        <div class="rowpiece">
          <img class="thumb" src="${imgPathFor({ id: p.id })}" alt="${p.name}" loading="lazy"
               onerror="this.style.display='none'">
          <span>${p.name}</span>
        </div>
      </td>

      <td>${p.stock}</td>
      <td>${needPill} <span class="muted small">/ cible ${p.targetStock}</span></td>
      <td>${platesText}</td>
      <td>${produceText}</td>
      <td class="muted">${badge} <span class="muted"> ${whyText}</span></td>
      <td>${btn}</td>
    `;
    tbody.appendChild(tr);
  });

  // attach events
  $$('[data-action="printed"]', tbody).forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.getAttribute("data-id");
      handlePrinted(state, id);
    });
  });
}

function renderStockTable(state) {
  const table = $("#stockTable");
  if (!table) return;
  const tbody = $("#stockTable tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  const q = (($("#stockSearch")?.value || "") + "").trim().toLowerCase();

  const rows = state.items
    .filter((it) => it.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));

  rows.forEach((it) => {
    const tr = document.createElement("tr");

    // 🔴/🟡/🟢 status
    const isCritical = it.perBox > 0 && it.stock < it.perBox;
    const isLow = it.perBox > 0 && !isCritical && it.stock < state.bufferBoxes * it.perBox;
    if (isCritical) tr.classList.add("tr-critical");
    else if (isLow) tr.classList.add("tr-low");

    tr.innerHTML = `
      <td>
        <div class="rowpiece">
          <img class="thumb" src="${imgPathFor(it)}" alt="${it.name}" loading="lazy"
               onerror="this.style.display='none'">
          <span>${it.name}</span>
        </div>
      </td>
      <td>${it.perBox}</td>
      <td>${it.perPlate}</td>
      <td><strong>${it.stock}</strong></td>
      <td>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-ghost" data-action="dec" data-id="${it.id}">-</button>
          <button class="btn btn-ghost" data-action="inc" data-id="${it.id}">+</button>
          <input class="input" style="width:110px" type="number" step="1" placeholder="+10 / -2" data-action="adj" data-id="${it.id}" />
          <input class="input" style="width:170px" type="text" placeholder="raison (ex: défectueux)" data-action="reason" data-id="${it.id}" />
          <button class="btn" data-action="apply" data-id="${it.id}">Appliquer</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // quick +/- 
  $$('[data-action="inc"]', tbody).forEach((b) =>
    b.addEventListener("click", () => adjustStock(state, b.dataset.id, +1, "ajustement +1"))
  );
  $$('[data-action="dec"]', tbody).forEach((b) =>
    b.addEventListener("click", () => adjustStock(state, b.dataset.id, -1, "ajustement -1"))
  );

  // apply custom
  $$('[data-action="apply"]', tbody).forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.dataset.id;
      const row = b.closest("tr");
      const qtyInput = $(`[data-action="adj"][data-id="${id}"]`, row);
      const reasonInput = $(`[data-action="reason"][data-id="${id}"]`, row);
      const qty = clampInt(qtyInput?.value, 0);
      const reason = (reasonInput?.value || "").trim() || "ajustement manuel";
      if (qty === 0) {
        alert("Mets une quantité différente de 0 (ex: -2 ou +10).");
        return;
      }
      adjustStock(state, id, qty, reason);
      if (qtyInput) qtyInput.value = "";
      if (reasonInput) reasonInput.value = "";
    });
  });
}

function renderLog(state) {
  const tbody = $("#logTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const log = [...state.log].slice(-300).reverse(); // last 300, newest first

  log.forEach((entry) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtDate(entry.ts)}</td>
      <td><span class="pill">${entry.type}</span></td>
      <td>${entry.itemName || "—"}</td>
      <td>${entry.qty ?? "—"}</td>
      <td class="muted">${entry.detail || ""}</td>
    `;
    tbody.appendChild(tr);
  });
}

function pushLog(state, entry) {
  state.log.push(entry);
  if (state.log.length > 2000) state.log = state.log.slice(-1200);
}

function adjustStock(state, itemId, delta, reason) {
  const it = getItem(state, itemId);
  if (!it) return;
  const before = it.stock;
  it.stock = Math.max(0, it.stock + delta);
  pushLog(state, {
    ts: nowISO(),
    type: "stock",
    itemId,
    itemName: it.name,
    qty: delta,
    detail: reason + (it.stock === 0 && before + delta < 0 ? " (clamp à 0)" : "")
  });
  saveState(state);
  renderAll(state);
}

/** Impression: ask plates + defects, then add to stock */
function handlePrinted(state, itemId) {
  const it = getItem(state, itemId);
  if (!it) return;

  const platesStr = prompt(`Combien de plateaux imprimés pour “${it.name}” ?\n(Par défaut: 1)`, "1");
  if (platesStr === null) return;
  const plates = Math.max(0, clampInt(platesStr, 1));
  if (plates === 0) return;

  const defectsStr = prompt(`Pièces défectueuses sur ces ${plates} plateau(x) ?\n(0 si tout est parfait)`, "0");
  if (defectsStr === null) return;
  const defects = Math.max(0, clampInt(defectsStr, 0));

  const produced = plates * it.perPlate;
  const added = Math.max(0, produced - defects);

  it.stock = it.stock + added;

  pushLog(state, {
    ts: nowISO(),
    type: "impression",
    itemId,
    itemName: it.name,
    qty: added,
    detail: `${plates} plateau(x) → ${produced} pièces, -${defects} défectueuses`
  });

  saveState(state);
  renderAll(state);
}

function canAssembleBox(state) {
  const blockers = [];
  state.items.forEach((it) => {
    const need = it.perBox;
    if (need > 0 && it.stock < need) blockers.push(it.name);
  });
  return blockers;
}

function assembleBox(state) {
  const blockers = canAssembleBox(state);
  const notice = $("#assembleNotice");
  if (blockers.length) {
    if (notice) {
      notice.hidden = false;
      notice.textContent = `Impossible d’assembler une boîte : stock insuffisant pour ${blockers
        .slice(0, 4)
        .join(", ")}${blockers.length > 4 ? "…" : ""}.`;
    }
    return;
  }
  if (notice) notice.hidden = true;

  const snapshot = state.items.map((it) => ({ id: it.id, stock: it.stock }));

  state.items.forEach((it) => {
    if (it.perBox > 0) it.stock = Math.max(0, it.stock - it.perBox);
  });

  pushLog(state, {
    ts: nowISO(),
    type: "boîte",
    itemId: null,
    itemName: "Boîte assemblée",
    qty: 1,
    detail: "Décrément du stock selon quantités par boîte",
    snapshotBefore: snapshot
  });

  saveState(state);
  renderAll(state);
}

function undoLast(state) {
  if (!state.log.length) {
    alert("Rien à annuler.");
    return;
  }
  const last = state.log[state.log.length - 1];

  if (last.snapshotBefore) {
    last.snapshotBefore.forEach((s) => {
      const it = getItem(state, s.id);
      if (it) it.stock = s.stock;
    });
    state.log.pop();
    pushLog(state, { ts: nowISO(), type: "undo", itemId: null, itemName: "—", qty: "", detail: `Annulation de: ${last.type}` });
    saveState(state);
    renderAll(state);
    return;
  }

  if (last.type === "stock" || last.type === "impression") {
    const it = getItem(state, last.itemId);
    if (it) {
      const inv = -clampInt(last.qty, 0);
      it.stock = Math.max(0, it.stock + inv);
    }
    state.log.pop();
    pushLog(state, { ts: nowISO(), type: "undo", itemId: null, itemName: "—", qty: "", detail: `Annulation de: ${last.type}` });
    saveState(state);
    renderAll(state);
    return;
  }

  alert("Cette action ne peut pas être annulée automatiquement.");
}

function exportState(state) {
  const payload = {
    exportedAt: nowISO(),
    bufferBoxes: state.bufferBoxes,
    items: state.items,
    log: state.log
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mechkawaii-production-export.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importStateFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!Array.isArray(data.items)) throw new Error("Fichier invalide : items manquants");
        const state = {
          bufferBoxes: clampInt(data.bufferBoxes, 5),
          items: data.items.map((it) => ({
            id: String(it.id),
            name: String(it.name),
            perBox: clampInt(it.perBox, 0),
            perPlate: clampInt(it.perPlate, 0),
            stock: clampInt(it.stock, 0),
            image: it.image ? String(it.image) : undefined
          })),
          log: Array.isArray(data.log) ? data.log : []
        };
        resolve(state);
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(new Error("Impossible de lire le fichier"));
    reader.readAsText(file);
  });
}

/* 🖨 File automatique 2 jours */
function buildTwoDayQueue(state, platesPerDay) {
  const plan = buildPrintPlan(state).filter((p) => p.plates > 0);

  const queue = [];
  plan.forEach((p) => {
    for (let i = 0; i < p.plates; i++) {
      queue.push({ id: p.id, name: p.name, perPlate: p.perPlate });
    }
  });

  const day1 = queue.slice(0, platesPerDay);
  const day2 = queue.slice(platesPerDay, platesPerDay * 2);

  return { day1, day2, remaining: Math.max(0, queue.length - platesPerDay * 2), total: queue.length };
}

function renderAll(state) {
  const bufferInput = $("#bufferInput");
  const bufferLabel = $("#bufferLabel");

  if (bufferInput) bufferInput.value = state.bufferBoxes;
  if (bufferLabel) bufferLabel.textContent = state.bufferBoxes;

  renderKpis(state);
  renderPrintTable(state);
  renderStockTable(state);
  renderLog(state);
}

async function main() {
  let state = loadState();
  if (!state) {
    const base = await loadBaseItems();
    state = makeInitialState(base);
    saveState(state);
  }

  // buffer
  $("#bufferInput")?.addEventListener("change", (e) => {
    state.bufferBoxes = Math.max(0, clampInt(e.target.value, 5));
    saveState(state);
    renderAll(state);
  });

  $("#btnRecalc")?.addEventListener("click", () => renderAll(state));
  $("#stockSearch")?.addEventListener("input", () => renderStockTable(state));

  $("#btnExport")?.addEventListener("click", () => exportState(state));

  $("#fileImport")?.addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const imported = await importStateFile(f);
      state = imported;
      saveState(state);
      renderAll(state);
      alert("Import réussi.");
    } catch (err) {
      alert("Import échoué : " + (err.message || err));
    } finally {
      e.target.value = "";
    }
  });

  $("#btnReset")?.addEventListener("click", async () => {
    if (!confirm("Réinitialiser le stock & l'historique (retour au fichier items.json) ?")) return;
    const base = await loadBaseItems();
    state = makeInitialState(base);
    saveState(state);
    renderAll(state);
  });

  $("#btnAssembleBox")?.addEventListener("click", () => {
    if (
      !confirm("Confirmer : une boîte assemblée ?\n→ le stock de chaque pièce sera décrémenté selon “par boîte”.")
    )
      return;
    assembleBox(state);
  });

  $("#btnUndo")?.addEventListener("click", () => {
    if (!confirm("Annuler la dernière action ?")) return;
    undoLast(state);
  });

  $("#btnClearLog")?.addEventListener("click", () => {
    if (!confirm("Vider l'historique ? (le stock reste inchangé)")) return;
    state.log = [];
    saveState(state);
    renderAll(state);
  });

  // 🖨 Queue 2 jours (si les éléments existent dans index.html)
  $("#btnQueue")?.addEventListener("click", () => {
    const platesPerDay = Math.max(1, clampInt($("#platesPerDay")?.value, 8));
    const { day1, day2, remaining, total } = buildTwoDayQueue(state, platesPerDay);

    const fmt = (arr) =>
      arr.length ? arr.map((x, i) => `${i + 1}. ${x.name} (+${x.perPlate})`).join("<br>") : "<em>—</em>";

    const notice = $("#queueNotice");
    if (!notice) {
      alert("Le bloc d'affichage de file (queueNotice) n'existe pas dans index.html.");
      return;
    }
    notice.hidden = false;
    notice.innerHTML = `
      <strong>File d'impression (plateaux/jour : ${platesPerDay})</strong><br><br>
      <strong>Jour 1</strong><br>${fmt(day1)}<br><br>
      <strong>Jour 2</strong><br>${fmt(day2)}<br><br>
      <span class="muted">Total plateaux à faire : ${total}. Reste après 2 jours : ${remaining}.</span>
    `;
  });

  renderAll(state);
}

main().catch((err) => {
  console.error(err);
  alert("Erreur au chargement : " + (err.message || err));
});
