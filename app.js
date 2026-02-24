/* Mechkawaii Production - app.js (MODULE)
   - Stock + plan d'impression + historique
   - Ajustements manuels (+/- et quantité custom + raison)
   - Bouton "Imprimé" (plateaux + défectueuses)
   - Bouton "Boîte assemblée"
   - Undo dernière action (si snapshot dispo)
   - Export / Import
   - Indicateurs CRITIQUE / SOUS TAMPON / OK
   - File d'impression automatique sur 2 jours (sans plateaux/jour)
   - ✅ Drawer plein écran : image + infos + actions
   - ✅ Sauvegardes cloud automatiques : 10 dernières versions + restauration
   - ✅ Sync Firebase (Firestore) multi-appareils
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
  collection, query, orderBy, limit, getDocs, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* ========= FIREBASE CONFIG =========
   ⚠️ Si tu recrées l'app Web dans Firebase, recopie le bloc "firebaseConfig" ici.
*/
const firebaseConfig = {
  apiKey: "AIzaSyCUcaGdiF6deI5S6JNxwLeCameAWAYEJK",
  authDomain: "mechkawaii-to-print.firebaseapp.com",
  projectId: "mechkawaii-to-print",
  storageBucket: "mechkawaii-to-print.firebasestorage.app",
  messagingSenderId: "3742880689",
  appId: "1:3742880689:web:6f389bd0356df7b6a6818"
};

const fbApp = initializeApp(firebaseConfig);
const fbAuth = getAuth(fbApp);
const fbDb = getFirestore(fbApp);

/* ========= LOCAL STORAGE ========= */
const STORAGE_KEY = "mechkawaii-production:v4";
const DEVICE_ID_KEY = "mechkawaii-production:deviceId";

/* ========= DOM HELPERS ========= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ========= UTILS ========= */
function nowISO() { return new Date().toISOString(); }
function fmtDate(iso) {
  try { return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }); }
  catch { return iso; }
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
let state = null;
let currentWorkspaceId = null;
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
      version: 4,
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

/* ========= GROUPED PRINTING =========
   If an item has:
     - printGroup: "routes_mix"
     - perVariantPerPlate: 14
   ...then 1 "plateau groupé" prints ALL variants in that group.
   We compute plates based on the MAX deficit among variants (perVariantPerPlate each).
*/
function buildPrintGroups() {
  const targetBoxes = state.bufferBoxes;

  // groupId -> { id, variants: [item], perVariantPerPlate }
  const map = new Map();

  // Collect items that belong to a printGroup
  for (const it of state.items) {
    if (!it.printGroup) continue;
    const gid = String(it.printGroup);

    const perVar = clampInt(it.perVariantPerPlate, 0) || clampInt(it.perPlate, 0); // fallback
    if (!map.has(gid)) {
      map.set(gid, { id: gid, variants: [], perVariantPerPlate: perVar });
    }
    const g = map.get(gid);

    // keep the max perVariantPerPlate if inconsistent
    g.perVariantPerPlate = Math.max(g.perVariantPerPlate || 0, perVar || 0);
    g.variants.push(it);
  }

  // Compute deficits and plates per group
  const groups = [];
  for (const g of map.values()) {
    const perVar = g.perVariantPerPlate || 0;

    const variantNeeds = g.variants.map((it) => {
      const targetStock = targetBoxes * (it.perBox || 0);
      const need = Math.max(0, targetStock - (it.stock || 0));
      return { id: it.id, name: it.name, need, targetStock, stock: it.stock, perBox: it.perBox };
    });

    const maxNeed = variantNeeds.length ? Math.max(...variantNeeds.map(v => v.need)) : 0;
    const plates = (perVar > 0 && maxNeed > 0) ? ceilDiv(maxNeed, perVar) : 0;

    // helper label like "Accidenté (3×14)"
    const label = `${g.variants[0]?.printGroupLabel || g.id} (${g.variants.length}×${perVar || "?"})`;

    groups.push({
      id: g.id,
      label,
      perVariantPerPlate: perVar,
      variants: variantNeeds,
      plates
    });
  }

  return groups;
}

function getGroupById(groupId) {
  const groups = buildPrintGroups();
  return groups.find(g => g.id === groupId) || null;
}

function getGroupForItem(item) {
  if (!item?.printGroup) return null;
  return getGroupById(String(item.printGroup));
}

function buildPrintPlan() {
  const targetBoxes = state.bufferBoxes;
  const items = state.items.filter((it) => it.perBox > 0);

  // Pre-compute grouped plates (printGroup)
  const groups = buildPrintGroups();
  const groupById = new Map(groups.map(g => [g.id, g]));

  const plan = items.map((it) => {
    const targetStock = targetBoxes * it.perBox;
    const need = Math.max(0, targetStock - it.stock);

    let plates = 0;
    let produce = 0;
    let perPlateDisplay = it.perPlate;

    if (it.printGroup) {
      const g = groupById.get(String(it.printGroup));
      const perVar = clampInt(it.perVariantPerPlate, 0) || clampInt(it.perPlate, 0);
      plates = g ? g.plates : 0;
      produce = plates * perVar;              // produced for THIS variant per group-plate
      perPlateDisplay = perVar || it.perPlate;
    } else {
      plates = need > 0 ? ceilDiv(need, it.perPlate) : 0;
      produce = plates * it.perPlate;
    }

    const boxesPossible = Math.floor(it.stock / it.perBox);

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

/* ========= 2-DAY QUEUE ========= */
function buildTwoDayQueue() {
  const plan = buildPrintPlan();

  // Build queue by "plate action":
  // - for grouped items: queue by group (one plate prints all variants)
  // - for non-group items: queue by item
  const groupPlates = new Map(); // groupId -> plates
  const groupMeta = new Map();   // groupId -> {label, perVar, variantsCount}

  for (const p of plan) {
    if (p.printGroup) {
      if (!groupPlates.has(p.printGroup)) {
        groupPlates.set(p.printGroup, p.plates);
        // label
        const g = getGroupById(p.printGroup);
        const label = g?.label || `${p.printGroup}`;
        groupMeta.set(p.printGroup, { label, perVar: p.perPlate, variantsCount: g?.variants?.length || "?" });
      }
    }
  }

  const queue = [];

  // grouped plates first (order by biggest plates then label)
  const grouped = [...groupPlates.entries()]
    .map(([id, plates]) => ({ id, plates, ...groupMeta.get(id) }))
    .filter(x => x.plates > 0)
    .sort((a,b) => (b.plates - a.plates) || String(a.label).localeCompare(String(b.label), "fr"));

  for (const g of grouped) {
    for (let i = 0; i < g.plates; i++) queue.push({ kind: "group", id: g.id, name: g.label, perPlate: `+${g.perVar} ×${g.variantsCount}` });
  }

  // non-group items
  const singles = plan.filter(p => !p.printGroup && p.plates > 0);
  for (const p of singles) {
    for (let i = 0; i < p.plates; i++) queue.push({ kind: "item", id: p.id, name: p.name, perPlate: `+${p.perPlate}` });
  }

  const half = Math.ceil(queue.length / 2);
  return { day1: queue.slice(0, half), day2: queue.slice(half), total: queue.length };
}

/* ========= ACTIONS ========= */
function getItemById(id) { return state.items.find((x) => x.id === id); }

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

  // If item belongs to a printGroup, one plateau prints ALL variants in that group.
  if (it.printGroup) {
    const g = getGroupForItem(it);
    const perVar = clampInt(it.perVariantPerPlate, 0) || clampInt(it.perPlate, 0);

    const platesStr = prompt(
      `Plateau MIX “${g?.label || it.printGroup}”
` +
      `→ ajoute ${perVar} pièces à CHAQUE variante

` +
      `Combien de plateaux imprimés ? (défaut: 1)`,
      "1"
    );
    if (platesStr === null) return;
    const plates = Math.max(0, clampInt(platesStr, 1));
    if (plates === 0) return;

    // For grouped plates, defects are usually handled as manual adjustments (simpler & more realistic).
    const addedEach = plates * perVar;

    const affected = (g?.variants || []).map(v => v.id);
    for (const vid of affected) {
      const vIt = getItemById(vid);
      if (vIt) vIt.stock += addedEach;
    }

    pushLog({
      ts: nowISO(),
      type: "impression",
      itemId: it.printGroup,
      itemName: `Plateau mix: ${g?.label || it.printGroup}`,
      qty: `+${addedEach} / variante`,
      detail: `${plates} plateau(x) → +${addedEach} sur ${affected.length} variante(s). Défectueux ? ajuste manuellement.`,
    });

    touchState();
    saveLocalState(state);
    renderAll();
    scheduleCloudSave();
    return;
  }

  // Single-item plate (legacy)
  const platesStr = prompt(`Combien de plateaux imprimés pour “${it.name}” ?
(Par défaut: 1)`, "1");
  if (platesStr === null) return;
  const plates = Math.max(0, clampInt(platesStr, 1));
  if (plates === 0) return;

  const defectsStr = prompt(`Pièces défectueuses sur ces ${plates} plateau(x) ?
(0 si tout est parfait)`, "0");
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
  state.items.forEach((it) => { if (it.perBox > 0 && it.stock < it.perBox) blockers.push(it.name); });
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

  state.items.forEach((it) => { if (it.perBox > 0) it.stock = Math.max(0, it.stock - it.perBox); });

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
  const payload = { exportedAt: nowISO(), bufferBoxes: state.bufferBoxes, items: state.items, log: state.log, meta: state.meta };
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

function importStateObject(data) {
  if (!data || !Array.isArray(data.items)) throw new Error("Fichier invalide : items manquants");

  state = {
    bufferBoxes: clampInt(data.bufferBoxes, 5),
    items: data.items.map((it) => ({
      id: String(it.id),
      name: String(it.name),
      perBox: clampInt(it.perBox, 0),
      perPlate: clampInt(it.perPlate, 0),
      stock: clampInt(it.stock, 0),
      image: it.image ? String(it.image) : undefined,
      printGroup: it.printGroup ? String(it.printGroup) : undefined,
      perVariantPerPlate: it.perVariantPerPlate !== undefined ? clampInt(it.perVariantPerPlate, 0) : undefined,
      printGroupLabel: it.printGroupLabel ? String(it.printGroupLabel) : undefined,
      printGroup: it.printGroup ? String(it.printGroup) : undefined,
      perVariantPerPlate: it.perVariantPerPlate !== undefined ? clampInt(it.perVariantPerPlate, 0) : undefined,
      printGroupLabel: it.printGroupLabel ? String(it.printGroupLabel) : undefined
    })),
    log: Array.isArray(data.log) ? data.log : [],
    meta: data.meta || { version: 4, lastUpdatedAt: nowISO(), lastUpdatedBy: DEVICE_ID, workspaceId: currentWorkspaceId || null }
  };

  touchState();
  saveLocalState(state);
  renderAll();
  scheduleCloudSave(true);
}

function importStateFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { try { resolve(JSON.parse(String(r.result))); } catch (e) { reject(e); } };
    r.onerror = () => reject(new Error("Impossible de lire le fichier"));
    r.readAsText(file);
  });
}

/* ========= DRAWER (C) ========= */
const drawer = {
  el: null,
  backdrop: null,
  closeBtn: null,
  title: null,
  sub: null,
  body: null,
  mode: "piece",     // "piece" | "versions"
  pieceId: null
};

function openDrawer() {
  drawer.backdrop.hidden = false;
  drawer.el.hidden = false;
  drawer.el.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}
function closeDrawer() {
  drawer.backdrop.hidden = true;
  drawer.el.hidden = true;
  drawer.el.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  drawer.mode = "piece";
  drawer.pieceId = null;
}

function setDrawerHeader(title, sub) {
  drawer.title.textContent = title || "—";
  drawer.sub.textContent = sub || "—";
}

function openPieceDrawer(itemId) {
  const it = getItemById(itemId);
  if (!it) return;

  drawer.mode = "piece";
  drawer.pieceId = itemId;

  const g = it.printGroup ? getGroupForItem(it) : null;
  const perVar = it.printGroup ? (clampInt(it.perVariantPerPlate, 0) || clampInt(it.perPlate, 0)) : clampInt(it.perPlate, 0);

  setDrawerHeader(it.name, it.printGroup ? `Plateau mix : ${g?.label || it.printGroup}` : `ID: ${it.id}`);

  const targetStock = state.bufferBoxes * (it.perBox || 0);
  const need = Math.max(0, targetStock - it.stock);

  // For grouped items, plates is computed at group level (max deficit among variants)
  let plates = 0;
  if (it.printGroup) {
    plates = g ? g.plates : (need > 0 ? ceilDiv(need, perVar) : 0);
  } else {
    plates = need > 0 ? ceilDiv(need, perVar) : 0;
  }
  const produce = plates * perVar;

  const groupLine = it.printGroup
    ? `<div class="muted" style="font-size:12px;margin-top:6px">1 plateau ajoute <strong>${perVar}</strong> à <strong>chaque</strong> variante (${g?.variants?.length || "?"} variantes). Défectueux ? ajuste après via “Appliquer”.</div>`
    : `<div class="muted" style="font-size:12px;margin-top:6px">Clique sur “Imprimé” une fois le plateau terminé.</div>`;

  drawer.body.innerHTML = `
    <div class="drawer-card">
      <div class="drawer-piece">
        <img src="${imgPathFor(it)}" alt="${it.name}" onerror="this.style.display='none'">
        <div style="flex:1;min-width:0">
          ${groupLine}

          <div class="drawer-metrics">
            <div class="drawer-metric"><div class="k">Stock</div><div class="v">${it.stock}</div></div>
            <div class="drawer-metric"><div class="k">Besoin (tampon)</div><div class="v">${need}</div></div>
            <div class="drawer-metric"><div class="k">Par boîte</div><div class="v">${it.perBox}</div></div>
            <div class="drawer-metric"><div class="k">${it.printGroup ? "Par variante / plateau" : "Par plateau"}</div><div class="v">${perVar}</div></div>
            <div class="drawer-metric"><div class="k">Plateaux</div><div class="v">${plates || "—"}</div></div>
            <div class="drawer-metric"><div class="k">À produire</div><div class="v">${produce || "—"}</div></div>
          </div>

          <div class="drawer-actions">
            <button class="btn btn-accent" id="drawerPrinted">Imprimé</button>
            <button class="btn btn-ghost" id="drawerMinus">-1</button>
            <button class="btn btn-ghost" id="drawerPlus">+1</button>
            <input class="input" id="drawerAdjQty" type="number" step="1" placeholder="+10 / -2">
            <input class="input" id="drawerAdjReason" type="text" placeholder="raison (ex: défectueux)">
            <button class="btn" id="drawerApply">Appliquer</button>
          </div>
        </div>
      </div>
    </div>
  `;

  $("#drawerPrinted")?.addEventListener("click", () => handlePrinted(itemId));
  $("#drawerMinus")?.addEventListener("click", () => adjustStock(itemId, -1, "ajustement -1"));
  $("#drawerPlus")?.addEventListener("click", () => adjustStock(itemId, +1, "ajustement +1"));
  $("#drawerApply")?.addEventListener("click", () => {
    const qty = clampInt($("#drawerAdjQty")?.value, 0);
    if (!qty) return alert("Mets une quantité différente de 0 (ex: -2 ou +10).");
    const reason = ($("#drawerAdjReason")?.value || "").trim() || "ajustement manuel";
    adjustStock(itemId, qty, reason);
    $("#drawerAdjQty").value = "";
    $("#drawerAdjReason").value = "";
  });

  openDrawer();
}

/* ========= CLOUD VERSIONING (10) ========= */
function wsRef() {
  if (!currentWorkspaceId) return null;
  return doc(fbDb, "workspaces", currentWorkspaceId);
}
function versionsCol() {
  if (!currentWorkspaceId) return null;
  return collection(fbDb, "workspaces", currentWorkspaceId, "versions");
}

async function saveCloudVersion(cleanedState) {
  const col = versionsCol();
  if (!col) return;

  const createdAtMs = Date.now();
  const versionId = String(createdAtMs);

  await setDoc(doc(fbDb, "workspaces", currentWorkspaceId, "versions", versionId), {
    createdAt: serverTimestamp(),
    createdAtMs,
    createdBy: DEVICE_ID,
    state: cleanedState
  }, { merge: false });

  // prune to last 10
  const q = query(col, orderBy("createdAtMs", "desc"), limit(25));
  const snap = await getDocs(q);
  const docs = snap.docs;
  if (docs.length <= 10) return;

  const toDelete = docs.slice(10);
  await Promise.all(toDelete.map(d => deleteDoc(d.ref)));
}

async function openVersionsDrawer() {
  if (!currentWorkspaceId) {
    alert("Connecte d’abord un code de synchro (workspace).");
    return;
  }

  drawer.mode = "versions";
  drawer.pieceId = null;
  setDrawerHeader("Versions (cloud)", "Les 10 dernières sauvegardes");

  drawer.body.innerHTML = `
    <div class="drawer-card">
      <div class="muted" style="font-size:12px;margin-bottom:10px">
        Astuce : si tu fais un import “foireux”, tu peux restaurer une version cloud ici.
      </div>
      <div id="versionsList" class="muted">Chargement…</div>
    </div>
  `;

  openDrawer();

  const col = versionsCol();
  const q = query(col, orderBy("createdAtMs", "desc"), limit(10));
  const snap = await getDocs(q);

  const list = $("#versionsList");
  if (!list) return;

  if (snap.empty) {
    list.innerHTML = "<em>Aucune version pour l’instant.</em>";
    return;
  }

  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  list.innerHTML = rows.map(r => {
    const dt = r.createdAtMs ? new Date(r.createdAtMs).toLocaleString("fr-FR", { dateStyle:"short", timeStyle:"short" }) : r.id;
    return `
      <div class="drawer-card" style="margin:0 0 10px 0">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:center">
          <div>
            <div style="font-weight:700">${dt}</div>
            <div class="muted" style="font-size:12px">par ${r.createdBy || "—"}</div>
          </div>
          <button class="btn" data-restore="${r.id}">Restaurer</button>
        </div>
      </div>
    `;
  }).join("");

  $$("[data-restore]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-restore");
      if (!confirm("Restaurer cette version ? (ton stock actuel sera remplacé)")) return;

      const vSnap = await getDoc(doc(fbDb, "workspaces", currentWorkspaceId, "versions", id));
      const v = vSnap.data();
      if (!v?.state) return alert("Version invalide.");

      suppressNextCloudWrite = true;
      state = normalizeCloudState(v.state);
      touchState();
      saveLocalState(state);
      renderAll();

      pushLog({ ts: nowISO(), type: "restore", itemId: null, itemName: "—", qty: "", detail: `Restauration version ${id}` });
      touchState();
      saveLocalState(state);

      scheduleCloudSave(true);
      alert("Version restaurée.");
      closeDrawer();
    });
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

  plan.forEach((p, idx) => {
    const tr = document.createElement("tr");
    tr.dataset.pieceId = p.id;

    const isCritical = p.stock < p.perBox;
    const isLow = !isCritical && p.stock < state.bufferBoxes * p.perBox;

    if (isCritical) tr.classList.add("tr-critical");
    else if (isLow) tr.classList.add("tr-low");

    const badge = isCritical ? `<span class="badge critical">CRITIQUE</span>`
      : isLow ? `<span class="badge low">SOUS TAMPON</span>`
      : `<span class="badge ok">OK</span>`;

    const whyText = p.why.join(" • ");

    const needPill = (p.need === 0)
      ? `<span class="pill ok">OK</span>`
      : `<span class="pill bad">Manque ${p.need}</span>`;

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
          <img class="thumb" src="${imgPathFor({ id: p.id })}" alt="${p.name}" loading="lazy" onerror="this.style.display='none'">
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

  $$('[data-action="printed"]', tbody).forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      handlePrinted(b.getAttribute("data-id"));
    });
  });

  // click row opens drawer (ignore buttons)
  tbody.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn) return;
    const tr = e.target.closest("tr");
    const id = tr?.dataset?.pieceId;
    if (id) openPieceDrawer(id);
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
    tr.dataset.pieceId = it.id;

    const isCritical = it.perBox > 0 && it.stock < it.perBox;
    const isLow = it.perBox > 0 && !isCritical && it.stock < state.bufferBoxes * it.perBox;

    if (isCritical) tr.classList.add("tr-critical");
    else if (isLow) tr.classList.add("tr-low");

    tr.innerHTML = `
      <td>
        <div class="rowpiece">
          <img class="thumb" src="${imgPathFor(it)}" alt="${it.name}" loading="lazy" onerror="this.style.display='none'">
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

  $$('[data-action="inc"]', tbody).forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); adjustStock(b.dataset.id, +1, "ajustement +1"); })
  );
  $$('[data-action="dec"]', tbody).forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); adjustStock(b.dataset.id, -1, "ajustement -1"); })
  );

  $$('[data-action="apply"]', tbody).forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      const row = b.closest("tr");
      const qtyInput = $(`[data-action="adj"][data-id="${id}"]`, row);
      const reasonInput = $(`[data-action="reason"][data-id="${id}"]`, row);

      const qty = clampInt(qtyInput?.value, 0);
      const reason = (reasonInput?.value || "").trim() || "ajustement manuel";

      if (qty === 0) return alert("Mets une quantité différente de 0 (ex: -2 ou +10).");

      adjustStock(id, qty, reason);

      if (qtyInput) qtyInput.value = "";
      if (reasonInput) reasonInput.value = "";
    });
  });

  // click row opens drawer
  tbody.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn) return;
    const tr = e.target.closest("tr");
    const id = tr?.dataset?.pieceId;
    if (id) openPieceDrawer(id);
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
  $("#bufferInput").value = state.bufferBoxes;
  $("#bufferLabel").textContent = state.bufferBoxes;

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

function normalizeCloudState(cloud) {
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
    meta: cloud.meta || { version: 4, lastUpdatedAt: nowISO(), lastUpdatedBy: "cloud", workspaceId: currentWorkspaceId || null }
  };
}
function stateUpdatedAt(s) { return (s?.meta?.lastUpdatedAt) || ""; }

async function connectWorkspace(wsId) {
  if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null; }

  currentWorkspaceId = wsId;
  state.meta.workspaceId = wsId;
  saveLocalState(state);

  const ref = doc(fbDb, "workspaces", wsId);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, { state: JSON.parse(JSON.stringify(state)), updatedAt: serverTimestamp(), updatedBy: DEVICE_ID }, { merge: true });
    showSyncNotice(`✅ Synchro active (workspace créé) : ${wsId}`);
  } else {
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
      showSyncNotice(`✅ Synchro active : ${wsId} (local envoyé)`);
      scheduleCloudSave(true);
    }
  }

  unsubSnapshot = onSnapshot(ref, (live) => {
    const data = live.data();
    const cloudRaw = data?.state;
    if (!cloudRaw || !cloudRaw.items) return;

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

/* ========= CLOUD SAVE (with JSON cleanup + versioning) ========= */
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

      // 🔥 Nettoyage total compatible Firestore (supprime undefined)
      const cleanedState = JSON.parse(JSON.stringify(state));

      await setDoc(ref, { state: cleanedState, updatedAt: serverTimestamp(), updatedBy: DEVICE_ID }, { merge: true });

      // ✅ Save a version + prune to 10 (best effort)
      try { await saveCloudVersion(cleanedState); } catch (e) { console.warn("Versioning:", e); }

      showSyncNotice(`✅ Synchro envoyée (${currentWorkspaceId})`);
    } catch (e) {
      console.error(e);
      showSyncNotice(`⚠️ Synchro erreur : ${e?.message || e}`);
    }
  }, force ? 0 : 400);
}

/* ========= MAIN ========= */
async function main() {
  // Drawer init
  drawer.el = $("#pieceDrawer");
  drawer.backdrop = $("#drawerBackdrop");
  drawer.closeBtn = $("#drawerClose");
  drawer.title = $("#drawerTitle");
  drawer.sub = $("#drawerSub");
  drawer.body = $("#drawerBody");

  drawer.closeBtn?.addEventListener("click", closeDrawer);
  drawer.backdrop?.addEventListener("click", closeDrawer);

  await ensureAuth();

  state = loadLocalState();
  if (!state) {
    const base = await loadBaseItems();
    state = makeInitialState(base);
    saveLocalState(state);
  } else {
    state.meta = state.meta || { version: 4, lastUpdatedAt: nowISO(), lastUpdatedBy: DEVICE_ID, workspaceId: null };
  }

  renderAll();

  $("#bufferInput")?.addEventListener("input", (e) => {
    state.bufferBoxes = Math.max(0, clampInt(e.target.value, state.bufferBoxes));
    touchState();
    saveLocalState(state);
    renderAll();
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
      importStateObject(data);
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
    if (!confirm("Confirmer : une boîte assemblée ?\n→ le stock de chaque pièce sera décrémenté.")) return;
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

  // Sync
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

  // Versions UI
  $("#btnVersions")?.addEventListener("click", () => openVersionsDrawer());

  // Auto reconnect
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
