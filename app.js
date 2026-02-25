/* Mechkawaii Production - app.js (MODULE)
   - Stock + plan d'impression + historique
   - Ajustements manuels (+/- et quantité custom + raison)
   - Bouton "Imprimé" (plateaux + défectueuses)
   - Bouton "Boîte assemblée" (déduit une boîte)
   - Undo dernière action (si snapshot dispo)
   - Export / Import
   - Indicateurs CRITIQUE / SOUS TAMPON / OK
   - File d'impression automatique sur 2 jours (SANS plateaux/jour)
   - Vignettes ./assets/images/<id>.png
   - ✅ Sync Firebase (Firestore) multi-appareils
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* ========= FIREBASE CONFIG (nouvelle app web) ========= */
const firebaseConfig = {
  apiKey: "AIzaSyCUcaGdiF6deI56S6JWXwleCameAWAYEJk",
  authDomain: "mechkawaii-to-print.firebaseapp.com",
  projectId: "mechkawaii-to-print",
  storageBucket: "mechkawaii-to-print.firebasestorage.app",
  messagingSenderId: "3742880689",
  appId: "COLLE_ICI_L_APPID_EXACT"
};

const fbApp = initializeApp(firebaseConfig);
const fbAuth = getAuth(fbApp);
const fbDb = getFirestore(fbApp);

/* ========= LOCAL STORAGE ========= */
const STORAGE_KEY = "mechkawaii-production:v3";
const DEVICE_ID_KEY = "mechkawaii-production:deviceId";

/* ========= DOM HELPERS ========= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ========= UTILS ========= */
function nowISO() { return new Date().toISOString(); }
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}
function clampInt(n, fallback = 0) {
  const x = Number.parseInt(n, 10);
  return Number.isFinite(x) ? x : fallback;
}
function ceilDiv(a, b) { return b > 0 ? Math.ceil(a / b) : 0; }

function imgPathFor(it) { return it.image || `./assets/images/${it.id}.png`; }

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + "-" + Date.now());
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
const DEVICE_ID = getDeviceId();

/* ========= STATE ========= */
let state = null;                 // {bufferBoxes, items, log, meta}
let currentWorkspaceId = null;    // code synchro
let unsubSnapshot = null;
let pendingSaveTimer = null;
let suppressNextCloudWrite = false;

/* ========= LOAD/SAVE LOCAL ========= */
function loadLocalState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function saveLocalState(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

async function loadBaseItems() {
  const res = await fetch("./data/items.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Impossible de charger data/items.json");
  return await res.json();
}

function makeInitialState(items) {
  return {
    bufferBoxes: 5,
    items: items.map((it) => ({ ...it, stock: clampInt(it.stock, 0) })),
    log: [],
    meta: {
      version: 3,
      lastUpdatedAt: nowISO(),
      lastUpdatedBy: DEVICE_ID,
      workspaceId: null
    }
  };
}

function touchState() {
  state.meta = state.meta || {};
  state.meta.lastUpdatedAt = nowISO();
  state.meta.lastUpdatedBy = DEVICE_ID;
  state.meta.workspaceId = currentWorkspaceId || state.meta.workspaceId || null;
}

/* ========= LOG ========= */
function pushLog(entry) {
  state.log.push(entry);
  if (state.log.length > 2000) state.log = state.log.slice(-1200);
}

/* ========= KPI / PLAN ========= */
function computeKpis() {
  const items = state.items;

  const perBoxItems = items.filter((it) => it.perBox > 0);
  const boxesPossibleByItem = perBoxItems.map((it) => Math.floor(it.stock / it.perBox));
  const boxesPossible = boxesPossibleByItem.length ? Math.min(...boxesPossibleByItem) : 0;

  const minVal = boxesPossibleByItem.length ? Math.min(...boxesPossibleByItem) : 0;
  const bottlenecks = perBoxItems
    .filter((it) => Math.floor(it.stock / it.perBox) === minVal)
    .map((it) => it.name);

  const targetBoxes = state.bufferBoxes;
  const underBuffer = perBoxItems.filter((it) => it.stock < targetBoxes * it.perBox).length;

  return { boxesPossible, bottlenecks, underBuffer, lines: items.length };
}

/* ========= GROUPED PRINTING (PATCH) =========
   If an item has:
     - printGroup: "routes_mix"
     - perVariantPerPlate: 14
   ...then 1 plateau prints ALL variants in that group.
   Plates are computed from the MAX deficit among variants.
*/
function buildPrintGroups() {
  const targetBoxes = state.bufferBoxes;
  const map = new Map(); // groupId -> { id, label, perVar, variants:[item] }

  for (const it of state.items) {
    if (!it.printGroup) continue;
    const gid = String(it.printGroup);
    const perVar = clampInt(it.perVariantPerPlate, 0) || clampInt(it.perPlate, 0);

    if (!map.has(gid)) {
      map.set(gid, {
        id: gid,
        label: it.printGroupLabel ? String(it.printGroupLabel) : gid,
        perVar,
        variants: []
      });
    }
    const g = map.get(gid);
    g.perVar = Math.max(g.perVar || 0, perVar || 0);
    g.variants.push(it);
  }

  const groups = [];
  for (const g of map.values()) {
    const needs = g.variants.map((it) => {
      const targetStock = targetBoxes * (it.perBox || 0);
      const need = Math.max(0, targetStock - (it.stock || 0));
      return { id: it.id, name: it.name, need, stock: it.stock, perBox: it.perBox, targetStock };
    });
    const maxNeed = needs.length ? Math.max(...needs.map(n => n.need)) : 0;
    const plates = (g.perVar > 0 && maxNeed > 0) ? ceilDiv(maxNeed, g.perVar) : 0;

    groups.push({
      id: g.id,
      label: `${g.label} (${g.variants.length}×${g.perVar})`,
      baseLabel: g.label,
      perVar: g.perVar,
      variants: needs,
      plates
    });
  }

  return groups;
}

function getGroupById(groupId) {
  const groups = buildPrintGroups();
  return groups.find(g => g.id === groupId) || null;
}

function getGroupForItem(it) {
  if (!it?.printGroup) return null;
  return getGroupById(String(it.printGroup));
}

function buildPrintPlan() {
  const targetBoxes = state.bufferBoxes;
  const items = state.items.filter((it) => it.perBox > 0);

  const groups = buildPrintGroups();
  const groupById = new Map(groups.map(g => [g.id, g]));

  const plan = items.map((it) => {
    const targetStock = targetBoxes * it.perBox;
    const need = Math.max(0, targetStock - it.stock);
    const boxesPossible = Math.floor(it.stock / it.perBox);

    let plates = 0;
    let produce = 0;
    let perPlateDisplay = it.perPlate;

    if (it.printGroup) {
      const gid = String(it.printGroup);
      const g = groupById.get(gid);
      const perVar = clampInt(it.perVariantPerPlate, 0) || clampInt(it.perPlate, 0);

      plates = g ? g.plates : (need > 0 ? ceilDiv(need, perVar) : 0);
      // For display on each variant line: production is PER VARIANT
      produce = plates * perVar;
      perPlateDisplay = perVar || it.perPlate;
    } else {
      plates = need > 0 ? ceilDiv(need, it.perPlate) : 0;
      produce = plates * it.perPlate;
    }

    const why = [];
    if (need === 0) why.push("OK tampon");
    else why.push("Stock < tampon");
    if (it.printGroup) why.push("Plateau mix");

    return {
      id: it.id,
      name: it.name,
      stock: it.stock,
      perBox: it.perBox,
      perPlate: perPlateDisplay,
      targetStock,
      need,
      plates,
      produce,
      boxesPossible,
      printGroup: it.printGroup ? String(it.printGroup) : null,
      why
    };
  });

  const minBoxes = plan.length ? Math.min(...plan.map((p) => p.boxesPossible)) : 0;
  plan.forEach((p) => { if (p.boxesPossible === minBoxes) p.why.unshift("Goulot boîte"); });

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

/* ========= 2-DAY QUEUE (NO plates/day) =========
   On transforme le plan en "plateaux unitaires", puis on split en 2 jours (moitié / moitié).
*/
function buildTwoDayQueue() {
  const plan = buildPrintPlan();

  const groupPlates = new Map();
  const groupMeta = new Map();

  for (const p of plan) {
    if (!p.printGroup) continue;
    if (!groupPlates.has(p.printGroup)) {
      groupPlates.set(p.printGroup, p.plates);
      const g = getGroupById(p.printGroup);
      groupMeta.set(p.printGroup, { label: g?.label || p.printGroup, perVar: p.perPlate, variantsCount: g?.variants?.length || "?" });
    }
  }

  const queue = [];

  const grouped = [...groupPlates.entries()]
    .map(([id, plates]) => ({ id, plates, ...(groupMeta.get(id) || {}) }))
    .filter(x => x.plates > 0)
    .sort((a,b) => (b.plates - a.plates) || String(a.label).localeCompare(String(b.label), "fr"));

  for (const g of grouped) {
    for (let i = 0; i < g.plates; i++) queue.push({ kind: "group", id: g.id, name: g.label, perPlate: `+${g.perVar} ×${g.variantsCount}` });
  }

  const singles = plan.filter(p => !p.printGroup && p.plates > 0);
  for (const p of singles) {
    for (let i = 0; i < p.plates; i++) queue.push({ kind: "item", id: p.id, name: p.name, perPlate: `+${p.perPlate}` });
  }

  const half = Math.ceil(queue.length / 2);
  return { day1: queue.slice(0, half), day2: queue.slice(half), total: queue.length };
}

/* ========= ACTIONS ========= */
function getItemById(id) {
  return state.items.find((x) => x.id === id);
}

function adjustStock(itemId, delta, reason = "ajustement manuel") {
  const it = getItemById(itemId);
  if (!it) return;

  const before = it.stock;
  it.stock = Math.max(0, it.stock + delta);

  pushLog({
    ts: nowISO(),
    type: "stock",
    itemId,
    itemName: it.name,
    qty: delta,
    detail: reason + (it.stock === 0 && before + delta < 0 ? " (clamp à 0)" : "")
  });

  touchState();
  saveLocalState(state);
  renderAll();
  scheduleCloudSave();
}

function handlePrinted(itemId) {
  const it = getItemById(itemId);
  if (!it) return;

  // Plateau MIX: imprime toutes les variantes du groupe
  if (it.printGroup) {
    const g = getGroupForItem(it);
    const perVar = clampInt(it.perVariantPerPlate, 0) || clampInt(it.perPlate, 0);

    const platesStr = prompt(
      `Plateau MIX “${g?.baseLabel || it.printGroup}”\n` +
      `→ ajoute ${perVar} pièces à CHAQUE variante\n\n` +
      `Combien de plateaux imprimés ? (défaut: 1)`,
      "1"
    );
    if (platesStr === null) return;
    const plates = Math.max(0, clampInt(platesStr, 1));
    if (plates === 0) return;

    const addedEach = plates * perVar;

    const groupItems = state.items.filter(x => String(x.printGroup || "") === String(it.printGroup));
    groupItems.forEach(x => { x.stock = clampInt(x.stock, 0) + addedEach; });

    pushLog({
      ts: nowISO(),
      type: "impression",
      itemId: String(it.printGroup),
      itemName: `Plateau mix: ${g?.baseLabel || it.printGroup}`,
      qty: `+${addedEach} / variante`,
      detail: `${plates} plateau(x) → +${addedEach} sur ${groupItems.length} variante(s). Défectueux ? ajuste manuellement.`
    });

    touchState();
    saveLocalState(state);
    renderAll();
    scheduleCloudSave();
    return;
  }

  // Plateau simple (pièce unique)
  const platesStr = prompt(`Combien de plateaux imprimés pour “${it.name}” ?\n(Par défaut: 1)`, "1");
  if (platesStr === null) return;
  const plates = Math.max(0, clampInt(platesStr, 1));
  if (plates === 0) return;

  const defectsStr = prompt(`Pièces défectueuses sur ces ${plates} plateau(x) ?\n(0 si tout est parfait)`, "0");
  if (defectsStr === null) return;
  const defects = Math.max(0, clampInt(defectsStr, 0));

  const produced = plates * it.perPlate;
  const added = Math.max(0, produced - defects);
  it.stock += added;

  pushLog({
    ts: nowISO(),
    type: "impression",
    itemId,
    itemName: it.name,
    qty: added,
    detail: `${plates} plateau(x) → ${produced} pièces, -${defects} défectueuses`
  });

  touchState();
  saveLocalState(state);
  renderAll();
  scheduleCloudSave();
}

function canAssembleBox() {
  const blockers = [];
  state.items.forEach((it) => {
    if (it.perBox > 0 && it.stock < it.perBox) blockers.push(it.name);
  });
  return blockers;
}

function assembleBox() {
  const blockers = canAssembleBox();
  const notice = $("#assembleNotice");

  if (blockers.length) {
    if (notice) {
      notice.hidden = false;
      notice.textContent = `Impossible d’assembler une boîte : stock insuffisant pour ${blockers.slice(0, 4).join(", ")}${blockers.length > 4 ? "…" : ""}.`;
    }
    return;
  }
  if (notice) notice.hidden = true;

  const snapshot = state.items.map((it) => ({ id: it.id, stock: it.stock }));

  state.items.forEach((it) => {
    if (it.perBox > 0) it.stock = Math.max(0, it.stock - it.perBox);
  });

  pushLog({
    ts: nowISO(),
    type: "boîte",
    itemId: null,
    itemName: "Boîte assemblée",
    qty: 1,
    detail: "Décrément du stock selon quantités par boîte",
    snapshotBefore: snapshot
  });

  touchState();
  saveLocalState(state);
  renderAll();
  scheduleCloudSave();
}

function undoLast() {
  if (!state.log.length) { alert("Rien à annuler."); return; }

  const last = state.log[state.log.length - 1];

  // If we have snapshot, restore precisely
  if (last.snapshotBefore) {
    last.snapshotBefore.forEach((s) => {
      const it = getItemById(s.id);
      if (it) it.stock = s.stock;
    });

    state.log.pop();
    pushLog({ ts: nowISO(), type: "undo", itemId: null, itemName: "—", qty: "", detail: `Annulation de: ${last.type}` });

    touchState();
    saveLocalState(state);
    renderAll();
    scheduleCloudSave();
    return;
  }

  // Otherwise invert qty for stock/impression
  if (last.type === "stock" || last.type === "impression") {
    const it = getItemById(last.itemId);
    if (it) {
      const inv = -clampInt(last.qty, 0);
      it.stock = Math.max(0, it.stock + inv);
    }

    state.log.pop();
    pushLog({ ts: nowISO(), type: "undo", itemId: null, itemName: "—", qty: "", detail: `Annulation de: ${last.type}` });

    touchState();
    saveLocalState(state);
    renderAll();
    scheduleCloudSave();
    return;
  }

  alert("Cette action ne peut pas être annulée automatiquement.");
}

function exportState() {
  const payload = {
    exportedAt: nowISO(),
    bufferBoxes: state.bufferBoxes,
    items: state.items,
    log: state.log,
    meta: state.meta
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

async function importStateObject(data) {
  if (!data || !Array.isArray(data.items)) throw new Error("Fichier invalide : items manquants");

  // ✅ Toujours recharger items.json comme source de vérité pour la config
  // Seul le stock est restauré depuis l'export — perPlate, printGroup, etc. viennent du fichier
  let baseItems = null;
  try {
    const res = await fetch("./data/items.json", { cache: "no-store" });
    if (res.ok) baseItems = await res.json();
  } catch (_) { /* fallback: on utilisera les données de l'export */ }

  const importedById = new Map(data.items.map(it => [String(it.id), it]));

  let mergedItems;
  if (baseItems) {
    // Config depuis items.json, stock depuis l'export (ou 0 si absent)
    mergedItems = baseItems.map(base => ({
      ...base,
      stock: clampInt((importedById.get(String(base.id)) || {}).stock, 0)
    }));
  } else {
    // Fallback si items.json inaccessible : on prend l'export tel quel
    mergedItems = data.items.map((it) => ({
      id: String(it.id),
      name: String(it.name),
      perBox: clampInt(it.perBox, 0),
      perPlate: clampInt(it.perPlate, 0),
      stock: clampInt(it.stock, 0),
      image: it.image ? String(it.image) : undefined,
      printGroup: it.printGroup ? String(it.printGroup) : undefined,
      perVariantPerPlate: it.perVariantPerPlate !== undefined ? clampInt(it.perVariantPerPlate, 0) : undefined,
      printGroupLabel: it.printGroupLabel ? String(it.printGroupLabel) : undefined
    }));
  }

  state = {
    bufferBoxes: clampInt(data.bufferBoxes, 5),
    items: mergedItems,
    log: Array.isArray(data.log) ? data.log : [],
    meta: data.meta || { version: 3, lastUpdatedAt: nowISO(), lastUpdatedBy: DEVICE_ID, workspaceId: currentWorkspaceId || null }
  };

  touchState();
  saveLocalState(state);
  renderAll();

  // ✅ Important : après import, on pousse au cloud si connecté
  scheduleCloudSave(true);
}

function importStateFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(String(reader.result))); }
      catch (e) { reject(e); }
    };
    reader.onerror = () => reject(new Error("Impossible de lire le fichier"));
    reader.readAsText(file);
  });
}

/* ========= RENDER ========= */
function renderKpis() {
  const el = $("#kpis");
  if (!el) return;
  const { boxesPossible, bottlenecks, underBuffer, lines } = computeKpis();

  el.innerHTML = "";
  const mk = (label, value, hint = "") => {
    const d = document.createElement("div");
    d.className = "kpi";
    d.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div>`;
    return d;
  };

  el.appendChild(mk("Boîtes complètes possibles", boxesPossible, "Selon tes stocks actuels"));
  el.appendChild(mk("Pièces goulots", bottlenecks.length ? bottlenecks.slice(0, 3).join(", ") + (bottlenecks.length > 3 ? "…" : "") : "—", "Ce qui bloque la fermeture de boîtes"));
  el.appendChild(mk("Pièces sous tampon", underBuffer, `Sous ${state.bufferBoxes} boîtes (cible)`));
  el.appendChild(mk("Références suivies", lines, "Lignes de ton tableau"));
}

function renderPrintTable() {
  const tbody = $("#printTable tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  const plan = buildPrintPlan();
  const groups = buildPrintGroups();
  const groupById = new Map(groups.map(g => [g.id, g]));

  // Build display rows:
  // - For mixed groups: one row per group (skip individual variant rows)
  // - For solo items: one row per item
  const seenGroups = new Set();
  const rows = []; // { kind: "group"|"item", data }

  for (const p of plan) {
    if (p.printGroup) {
      if (!seenGroups.has(p.printGroup)) {
        seenGroups.add(p.printGroup);
        const g = groupById.get(p.printGroup);
        rows.push({ kind: "group", groupId: p.printGroup, g });
      }
      // skip subsequent variant rows for same group
    } else {
      rows.push({ kind: "item", p });
    }
  }

  rows.forEach((row, idx) => {
    const tr = document.createElement("tr");

    if (row.kind === "group") {
      const g = row.g;
      if (!g) return;

      // Compute group-level status from its variants
      const variantItems = state.items.filter(it => String(it.printGroup || "") === row.groupId);
      const minStock = variantItems.length ? Math.min(...variantItems.map(it => it.stock)) : 0;
      const minPerBox = variantItems.length ? Math.min(...variantItems.map(it => it.perBox || 0)) : 0;
      const targetStock = state.bufferBoxes * minPerBox;
      const maxNeed = variantItems.length ? Math.max(...variantItems.map(it => Math.max(0, state.bufferBoxes * (it.perBox || 0) - it.stock))) : 0;

      const isCritical = minPerBox > 0 && minStock < minPerBox;
      const isLow = !isCritical && minPerBox > 0 && minStock < targetStock;

      if (isCritical) tr.classList.add("tr-critical");
      else if (isLow) tr.classList.add("tr-low");

      const badge = isCritical
        ? `<span class="badge critical">CRITIQUE</span>`
        : isLow
          ? `<span class="badge low">SOUS TAMPON</span>`
          : `<span class="badge ok">OK</span>`;

      const needPill = maxNeed === 0
        ? `<span class="pill ok">OK</span>`
        : `<span class="pill bad">Manque ${maxNeed}</span>`;

      const platesText = g.plates === 0 ? "—" : String(g.plates);
      const producePerVar = g.plates * g.perVar;
      const produceText = producePerVar === 0 ? "—" : `+${producePerVar} / variante`;

      const firstId = variantItems[0]?.id || "";
      const totalStock = variantItems.reduce((sum, it) => sum + (it.stock || 0), 0);

      const btn = `<button class="btn btn-accent" data-action="printed" data-id="${firstId}" data-group="${row.groupId}">Imprimé</button>`;

      tr.innerHTML = `
        <td><strong>${idx + 1}</strong></td>
        <td>
          <div class="rowpiece">
            <img class="thumb" src="${imgPathFor({ id: firstId })}" alt="${g.baseLabel}" loading="lazy"
                 onerror="this.style.display='none'">
            <span>${g.baseLabel}</span>
          </div>
        </td>
        <td>${totalStock}</td>
        <td>${needPill} <span class="muted small">/ cible ${targetStock}</span></td>
        <td>${platesText}</td>
        <td>${produceText}</td>
        <td class="muted">${badge} Plateau mix</td>
        <td>${btn}</td>
      `;

    } else {
      const p = row.p;
      const isCritical = p.stock < p.perBox;
      const isLow = !isCritical && p.stock < state.bufferBoxes * p.perBox;

      if (isCritical) tr.classList.add("tr-critical");
      else if (isLow) tr.classList.add("tr-low");

      const badge = isCritical
        ? `<span class="badge critical">CRITIQUE</span>`
        : isLow
          ? `<span class="badge low">SOUS TAMPON</span>`
          : `<span class="badge ok">OK</span>`;

      const whyText = p.why.filter(w => w !== "Plateau mix").join(" • ");
      const needPill = p.need === 0
        ? `<span class="pill ok">OK</span>`
        : `<span class="pill bad">Manque ${p.need}</span>`;

      const platesText = p.plates === 0 ? "—" : String(p.plates);
      const produceText = p.produce === 0 ? "—" : `+${p.produce}`;

      const btn = `<button class="btn btn-accent" data-action="printed" data-id="${p.id}">Imprimé</button>`;

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
        <td class="muted">${badge} <span class="muted">${whyText}</span></td>
        <td>${btn}</td>
      `;
    }

    tbody.appendChild(tr);
  });

  $$('[data-action="printed"]', tbody).forEach((b) => {
    b.addEventListener("click", () => handlePrinted(b.getAttribute("data-id")));
  });
}

function renderStockTable() {
  const tbody = $("#stockTable tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  const q = (($("#stockSearch")?.value || "") + "").trim().toLowerCase();

  const rows = state.items
    .filter((it) => it.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));

  rows.forEach((it) => {
    const tr = document.createElement("tr");

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

  // quick +/- buttons
  $$('[data-action="inc"]', tbody).forEach((b) =>
    b.addEventListener("click", () => adjustStock(b.dataset.id, +1, "ajustement +1"))
  );
  $$('[data-action="dec"]', tbody).forEach((b) =>
    b.addEventListener("click", () => adjustStock(b.dataset.id, -1, "ajustement -1"))
  );

  // apply custom adjustment
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

      adjustStock(id, qty, reason);

      if (qtyInput) qtyInput.value = "";
      if (reasonInput) reasonInput.value = "";
    });
  });
}

function renderLog() {
  const tbody = $("#logTable tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  const log = [...state.log].slice(-300).reverse();

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

function renderAll() {
  const bufferInput = $("#bufferInput");
  const bufferLabel = $("#bufferLabel");

  if (bufferInput) bufferInput.value = state.bufferBoxes;
  if (bufferLabel) bufferLabel.textContent = state.bufferBoxes;

  renderKpis();
  renderPrintTable();
  renderStockTable();
  renderLog();
}

/* ========= SYNC UI ========= */
function showSyncNotice(text) {
  const el = $("#syncNotice");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
}

function randomSyncCode() {
  const part = () => Math.random().toString(36).slice(2, 6);
  return `${part()}-${part()}-${part()}`;
}

/* ========= FIREBASE SYNC ========= */
async function ensureAuth() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(fbAuth, async (user) => {
      try {
        if (user) return resolve(user);
        const cred = await signInAnonymously(fbAuth);
        resolve(cred.user);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function stateUpdatedAt(s) {
  return (s?.meta?.lastUpdatedAt) || "";
}

function normalizeCloudState(cloud) {
  // ensure structure
  return {
    bufferBoxes: clampInt(cloud.bufferBoxes, 5),
    items: Array.isArray(cloud.items) ? cloud.items.map((it) => ({
      id: String(it.id),
      name: String(it.name),
      perBox: clampInt(it.perBox, 0),
      perPlate: clampInt(it.perPlate, 0),
      stock: clampInt(it.stock, 0),
      image: it.image ? String(it.image) : undefined,
      printGroup: it.printGroup ? String(it.printGroup) : undefined,
      perVariantPerPlate: it.perVariantPerPlate !== undefined ? clampInt(it.perVariantPerPlate, 0) : undefined,
      printGroupLabel: it.printGroupLabel ? String(it.printGroupLabel) : undefined
    })) : [],
    log: Array.isArray(cloud.log) ? cloud.log : [],
    meta: cloud.meta || { version: 3, lastUpdatedAt: nowISO(), lastUpdatedBy: "cloud", workspaceId: currentWorkspaceId || null }
  };
}

async function connectWorkspace(wsId) {
  if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null; }

  currentWorkspaceId = wsId;
  state.meta.workspaceId = wsId;
  saveLocalState(state);

  const ref = doc(fbDb, "workspaces", wsId);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    // first device creates cloud doc from local
    await setDoc(ref, {
      state,
      updatedAt: serverTimestamp(),
      updatedBy: DEVICE_ID
    }, { merge: true });

    showSyncNotice(`✅ Synchro active (workspace créé) : ${wsId}`);
  } else {
    // choose newest between local and cloud
    const cloud = normalizeCloudState(snap.data()?.state || {});
    const cloudTs = stateUpdatedAt(cloud);
    const localTs = stateUpdatedAt(state);

    if (cloudTs && (!localTs || cloudTs > localTs)) {
      suppressNextCloudWrite = true;
      state = cloud;
      saveLocalState(state);
      renderAll();
      showSyncNotice(`✅ Synchro active : ${wsId} (cloud chargé)`);
    } else {
      // local is newer -> push it once
      showSyncNotice(`✅ Synchro active : ${wsId} (local envoyé)`);
      scheduleCloudSave(true);
    }
  }

  // realtime updates
  unsubSnapshot = onSnapshot(ref, (live) => {
    const data = live.data();
    const cloudRaw = data?.state;
    if (!cloudRaw || !cloudRaw.items) return;

    // ignore our own writes
    if (data?.updatedBy === DEVICE_ID) return;

    const cloud = normalizeCloudState(cloudRaw);
    const cloudTs = stateUpdatedAt(cloud);
    const localTs = stateUpdatedAt(state);

    if (cloudTs && localTs && cloudTs <= localTs) return;

    suppressNextCloudWrite = true;
    state = cloud;
    saveLocalState(state);
    renderAll();
    showSyncNotice(`🔄 Mise à jour reçue (${wsId})`);
  });
}

// --- Firestore refuses `undefined` values: clean them before saving ---
function cleanUndefined(obj) {
  if (Array.isArray(obj)) return obj.map(cleanUndefined);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v !== undefined) out[k] = cleanUndefined(v);
    }
    return out;
  }
  return obj;
}

function scheduleCloudSave(force = false) {
  if (!currentWorkspaceId) return;

  if (suppressNextCloudWrite && !force) {
    suppressNextCloudWrite = false;
    return;
  }
  suppressNextCloudWrite = false;

  if (pendingSaveTimer) clearTimeout(pendingSaveTimer);

  pendingSaveTimer = setTimeout(async () => {
    try {
      const ref = doc(fbDb, "workspaces", currentWorkspaceId);

      // 🔥 Nettoyage total compatible Firestore
      const cleanedState = JSON.parse(JSON.stringify(state));

      await setDoc(ref, {
        state: cleanedState,
        updatedAt: serverTimestamp(),
        updatedBy: DEVICE_ID
      }, { merge: true });

      showSyncNotice(`✅ Synchro envoyée (${currentWorkspaceId})`);
    } catch (e) {
      console.error(e);
      showSyncNotice(`⚠️ Synchro erreur : ${e?.message || e}`);
    }
  }, force ? 0 : 400);
}

/* ========= MAIN ========= */
async function main() {
  await ensureAuth();

  state = loadLocalState();
  if (!state) {
    const base = await loadBaseItems();
    state = makeInitialState(base);
    saveLocalState(state);
  } else {
    // ensure meta exists
    state.meta = state.meta || { version: 3, lastUpdatedAt: nowISO(), lastUpdatedBy: DEVICE_ID, workspaceId: null };
  }

  renderAll();

  // buffer change -> MUST re-render plan
  $("#bufferInput")?.addEventListener("input", (e) => {
    state.bufferBoxes = Math.max(0, clampInt(e.target.value, state.bufferBoxes));
    touchState();
    saveLocalState(state);
    renderAll();              // ✅ recalc plan now
    scheduleCloudSave();
  });

  $("#btnRecalc")?.addEventListener("click", () => renderAll());

  $("#stockSearch")?.addEventListener("input", () => renderStockTable());

  $("#btnExport")?.addEventListener("click", () => exportState());

  $("#fileImport")?.addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;

    try {
      const data = await importStateFile(f);
      await importStateObject(data);
      alert("Import réussi.");
    } catch (err) {
      alert("Import échoué : " + (err?.message || err));
    } finally {
      e.target.value = "";
    }
  });

  $("#btnReset")?.addEventListener("click", async () => {
    if (!confirm("Réinitialiser le stock & l'historique (retour au fichier items.json) ?")) return;
    const base = await loadBaseItems();
    state = makeInitialState(base);
    saveLocalState(state);
    renderAll();
    scheduleCloudSave(true);
  });

  $("#btnAssembleBox")?.addEventListener("click", () => {
    if (!confirm("Confirmer : une boîte assemblée ?\n→ le stock de chaque pièce sera décrémenté selon “par boîte”.")) return;
    assembleBox();
  });

  $("#btnUndo")?.addEventListener("click", () => {
    if (!confirm("Annuler la dernière action ?")) return;
    undoLast();
  });

  $("#btnClearLog")?.addEventListener("click", () => {
    if (!confirm("Vider l'historique ? (le stock reste inchangé)")) return;
    state.log = [];
    touchState();
    saveLocalState(state);
    renderAll();
    scheduleCloudSave();
  });

  // 2-day queue (no plates/day)
  $("#btnQueue")?.addEventListener("click", () => {
    const { day1, day2, total } = buildTwoDayQueue();
    const fmt = (arr) => arr.length ? arr.map((x, i) => `${i + 1}. ${x.name} (${x.perPlate})`).join("<br>") : "<em>—</em>";
    const notice = $("#queueNotice");
    if (!notice) return;
    notice.hidden = false;
    notice.innerHTML = `
      <strong>File d'impression sur 2 jours</strong><br>
      <span class="muted">Total plateaux à faire : ${total}</span><br><br>
      <strong>Jour 1</strong><br>${fmt(day1)}<br><br>
      <strong>Jour 2</strong><br>${fmt(day2)}
    `;
  });

  // sync buttons
  $("#btnSyncNew")?.addEventListener("click", async () => {
    const code = randomSyncCode();
    $("#syncCode").value = code;
    await connectWorkspace(code);
  });

  $("#btnSyncConnect")?.addEventListener("click", async () => {
    const code = ($("#syncCode").value || "").trim();
    if (!code) return alert("Entre un code de synchro.");
    await connectWorkspace(code);
  });

  // auto-reconnect if saved
  const savedWs = state?.meta?.workspaceId;
  if (savedWs) {
    $("#syncCode").value = savedWs;
    await connectWorkspace(savedWs);
  } else {
    showSyncNotice("🔌 Firebase prêt. Entre un code puis “Connecter” (ou “Nouveau code”).");
  }
}

main().catch((e) => {
  console.error(e);
  alert("Erreur au chargement : " + (e?.message || e));
});
