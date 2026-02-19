/* Mechkawaii Production - app.js (MODULE + FIREBASE SYNC) */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* ========= FIREBASE CONFIG ========= */
const firebaseConfig = {
  apiKey: "AIzaSyCUcaGdiF6deI56S6JWXwleCameAWAYEJk",
  authDomain: "mechkawaii-to-print.firebaseapp.com",
  projectId: "mechkawaii-to-print",
  storageBucket: "mechkawaii-to-print.firebasestorage.app",
  messagingSenderId: "37428806089",
  appId: "1:37428806089:web:6f389bd03566fd7b6a6818"
};


/* ========= INIT FIREBASE ========= */
const fbApp = initializeApp(firebaseConfig);
const fbAuth = getAuth(fbApp);
const fbDb = getFirestore(fbApp);

/* ========= HELPERS ========= */
const STORAGE_KEY = "mechkawaii-production:v2";
const DEVICE_ID_KEY = "mk-device-id";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function clampInt(n, fallback = 0) {
  const x = parseInt(n, 10);
  return Number.isFinite(x) ? x : fallback;
}

function ceilDiv(a, b) {
  if (b <= 0) return 0;
  return Math.ceil(a / b);
}

function imgPathFor(it) {
  return it.image || `./assets/images/${it.id}.png`;
}

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

const DEVICE_ID = getDeviceId();

/* ========= STATE ========= */
let state = null;
let workspaceId = null;
let unsubscribe = null;
let suppressCloudWrite = false;

/* ========= LOAD BASE ITEMS ========= */
async function loadBaseItems() {
  const res = await fetch("./data/items.json");
  return await res.json();
}

/* ========= LOCAL STORAGE ========= */
function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadLocal() {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

/* ========= SYNC ========= */

async function ensureAuth() {
  return new Promise((resolve) => {
    onAuthStateChanged(fbAuth, async (user) => {
      if (user) resolve(user);
      else {
        const cred = await signInAnonymously(fbAuth);
        resolve(cred.user);
      }
    });
  });
}

function randomCode() {
  const part = () => Math.random().toString(36).slice(2, 6);
  return `${part()}-${part()}-${part()}`;
}

async function connectWorkspace(code) {
  workspaceId = code;
  const ref = doc(fbDb, "workspaces", code);

  if (unsubscribe) unsubscribe();

  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      state,
      updatedAt: serverTimestamp(),
      updatedBy: DEVICE_ID
    });
  } else {
    suppressCloudWrite = true;
    state = snap.data().state;
    saveLocal();
    renderAll();
  }

  unsubscribe = onSnapshot(ref, (live) => {
    const data = live.data();
    if (!data) return;
    if (data.updatedBy === DEVICE_ID) return;

    suppressCloudWrite = true;
    state = data.state;
    saveLocal();
    renderAll();
  });
}

function cloudSave() {
  if (!workspaceId || suppressCloudWrite) {
    suppressCloudWrite = false;
    return;
  }

  const ref = doc(fbDb, "workspaces", workspaceId);
  setDoc(ref, {
    state,
    updatedAt: serverTimestamp(),
    updatedBy: DEVICE_ID
  });
}

/* ========= STOCK LOGIC ========= */

function adjustStock(id, delta) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  it.stock = Math.max(0, it.stock + delta);
  saveLocal();
  renderAll();
  cloudSave();
}

function assembleBox() {
  for (const it of state.items) {
    if (it.perBox > 0 && it.stock < it.perBox) {
      alert("Stock insuffisant pour : " + it.name);
      return;
    }
  }

  state.items.forEach((it) => {
    if (it.perBox > 0) it.stock -= it.perBox;
  });

  saveLocal();
  renderAll();
  cloudSave();
}

/* ========= PLAN ========= */

function buildPlan() {
  const targetBoxes = state.bufferBoxes;

  return state.items
    .filter((it) => it.perBox > 0)
    .map((it) => {
      const targetStock = targetBoxes * it.perBox;
      const need = Math.max(0, targetStock - it.stock);
      const plates = ceilDiv(need, it.perPlate);
      return {
        ...it,
        need,
        plates,
        produce: plates * it.perPlate
      };
    })
    .sort((a, b) => b.need - a.need);
}

/* ========= RENDER ========= */

function renderAll() {
  renderPlan();
  renderStock();
}

function renderPlan() {
  const tbody = $("#printTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const plan = buildPlan();

  plan.forEach((p, i) => {
    const tr = document.createElement("tr");

    const isCritical = p.stock < p.perBox;
    const isLow = !isCritical && p.stock < state.bufferBoxes * p.perBox;

    if (isCritical) tr.classList.add("tr-critical");
    else if (isLow) tr.classList.add("tr-low");

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>
        <div class="rowpiece">
          <img class="thumb" src="${imgPathFor(p)}" onerror="this.style.display='none'">
          <span>${p.name}</span>
        </div>
      </td>
      <td>${p.stock}</td>
      <td>${p.need}</td>
      <td>${p.plates}</td>
      <td>${p.produce}</td>
      <td>
        ${
          p.plates > 0
            ? `<button class="btn btn-accent" data-id="${p.id}">Imprimé</button>`
            : "OK"
        }
      </td>
    `;

    tbody.appendChild(tr);
  });

  $$("button[data-id]").forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.dataset.id;
      const it = state.items.find((x) => x.id === id);
      if (!it) return;

      const plates = clampInt(prompt("Plateaux ?", "1"), 1);
      const defects = clampInt(prompt("Défectueuses ?", "0"), 0);

      const produced = plates * it.perPlate;
      it.stock += Math.max(0, produced - defects);

      saveLocal();
      renderAll();
      cloudSave();
    });
  });
}

function renderStock() {
  const tbody = $("#stockTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  state.items.forEach((it) => {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>
        <div class="rowpiece">
          <img class="thumb" src="${imgPathFor(it)}" onerror="this.style.display='none'">
          <span>${it.name}</span>
        </div>
      </td>
      <td>${it.perBox}</td>
      <td>${it.perPlate}</td>
      <td>${it.stock}</td>
      <td>
        <button class="btn btn-ghost" data-dec="${it.id}">-</button>
        <button class="btn btn-ghost" data-inc="${it.id}">+</button>
      </td>
    `;

    tbody.appendChild(tr);
  });

  $$("[data-inc]").forEach((b) =>
    b.addEventListener("click", () => adjustStock(b.dataset.inc, +1))
  );
  $$("[data-dec]").forEach((b) =>
    b.addEventListener("click", () => adjustStock(b.dataset.dec, -1))
  );
}

/* ========= INIT ========= */

async function init() {
  await ensureAuth();

  state = loadLocal();
  if (!state) {
    const base = await loadBaseItems();
    state = { bufferBoxes: 5, items: base };
    saveLocal();
  }

  renderAll();

  $("#btnAssembleBox")?.addEventListener("click", assembleBox);

  $("#btnSyncNew")?.addEventListener("click", async () => {
    const code = randomCode();
    $("#syncCode").value = code;
    await connectWorkspace(code);
  });

  $("#btnSyncConnect")?.addEventListener("click", async () => {
    const code = $("#syncCode").value.trim();
    if (!code) return alert("Entre un code.");
    await connectWorkspace(code);
  });
}

init();
