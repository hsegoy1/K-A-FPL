import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  getDocs,
  collection,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const els = {
  tabs: document.getElementById("tabs"),
  leagueName: document.getElementById("league-name"),
  leagueEyebrow: document.getElementById("league-eyebrow"),
  gwChip: document.getElementById("gw-chip"),
  standingsBody: document.getElementById("standings-body"),
  statGrid: document.getElementById("stat-grid"),
  winnersBody: document.getElementById("winners-body"),
  managerDetail: document.getElementById("manager-detail"),
  backBtn: document.getElementById("back-to-table"),
};

let managersCache = [];

// ---------- View switching ----------

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${name}`).classList.add("active");
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  const tabBtn = document.querySelector(`.tab[data-view="${name}"]`);
  if (tabBtn) tabBtn.classList.add("active");
}

els.tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  showView(btn.dataset.view);
});

els.backBtn.addEventListener("click", () => showView("standings"));

// ---------- League meta ----------

async function loadLeagueMeta() {
  const snap = await getDoc(doc(db, "leagueMeta/info"));
  if (!snap.exists()) {
    els.leagueName.textContent = "No data yet";
    els.leagueEyebrow.textContent = "RUN THE SYNC SCRIPT FIRST";
    return;
  }
  const data = snap.data();
  els.leagueName.textContent = data.leagueName || "Office FPL";
  els.leagueEyebrow.textContent = `${data.managerCount ?? "—"} MANAGERS · K&A PAID FPL`;
  els.gwChip.textContent = `GW ${data.lastSyncedGw ?? "—"}`;
  return data;
}

// ---------- Standings ----------

async function loadStandings() {
  const snap = await getDocs(collection(db, "managers"));
  const managers = snap.docs.map((d) => d.data());
  managers.sort((a, b) => a.currentRank - b.currentRank);
  managersCache = managers;

  if (managers.length === 0) {
    els.standingsBody.innerHTML = `<tr><td colspan="5" class="loading-row">No managers synced yet.</td></tr>`;
    return;
  }

  els.standingsBody.innerHTML = managers
    .map(
      (m, i) => `
      <tr class="${i === 0 ? "rank-1" : ""}" data-entry="${m.entryId}" tabindex="0">
        <td class="col-rank">${m.currentRank}</td>
        <td class="col-team">${escapeHtml(m.teamName)}</td>
        <td class="col-manager">${escapeHtml(m.managerName)}</td>
        <td class="col-num">${m.lastGwPoints ?? "—"}</td>
        <td class="col-num">${m.totalPoints}</td>
      </tr>`
    )
    .join("");

  els.standingsBody.querySelectorAll("tr[data-entry]").forEach((row) => {
    row.addEventListener("click", () => openManager(row.dataset.entry));
    row.addEventListener("keypress", (e) => {
      if (e.key === "Enter") openManager(row.dataset.entry);
    });
  });
}

// ---------- Matchday fun stats ----------

async function loadStats(meta) {
  if (!meta?.lastSyncedGw) {
    els.statGrid.innerHTML = `<p class="loading-row">No data yet.</p>`;
    return;
  }
  const snap = await getDoc(doc(db, `gameweeks/gw${meta.lastSyncedGw}`));
  if (!snap.exists()) {
    els.statGrid.innerHTML = `<p class="loading-row">No stats for this gameweek yet.</p>`;
    return;
  }
  const s = snap.data();

  const cards = [
    s.winner && {
      label: "GW Winner",
      value: `${s.winner.teamName}`,
      sub: `${s.winner.managerName} · ${s.winner.points} pts`,
      cls: "highlight",
    },
    s.loser && {
      label: "Wooden Spoon",
      value: `${s.loser.teamName}`,
      sub: `${s.loser.managerName} · ${s.loser.points} pts`,
      cls: "lowlight",
    },
    s.mostCaptained && {
      label: "Most Captained",
      value: s.mostCaptained.player,
      sub: `${s.mostCaptained.count} of ${managersCache.length || "—"} managers`,
    },
    s.biggestBench && {
      label: "Biggest Bench Points Left",
      value: `${s.biggestBench.benchPoints} pts`,
      sub: s.biggestBench.managerName,
    },
    s.mostHits && {
      label: "Most Transfer Hits",
      value: `-${s.mostHits.transferCost} pts`,
      sub: s.mostHits.managerName,
    },
    {
      label: "Average Score",
      value: `${s.averagePoints} pts`,
      sub: `Across the league, GW${s.gw}`,
    },
  ].filter(Boolean);

  els.statGrid.innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card ${c.cls || ""}">
        <p class="stat-label">${escapeHtml(c.label)}</p>
        <p class="stat-value">${escapeHtml(c.value)}</p>
        <p class="stat-sub">${escapeHtml(c.sub)}</p>
      </div>`
    )
    .join("");
}

// ---------- MW winners log ----------

async function loadWinners() {
  const q = query(collection(db, "mwWinners"), orderBy("gw", "desc"));
  const snap = await getDocs(q);
  if (snap.empty) {
    els.winnersBody.innerHTML = `<tr><td colspan="4" class="loading-row">No winners logged yet.</td></tr>`;
    return;
  }
  els.winnersBody.innerHTML = snap.docs
    .map((d) => {
      const w = d.data();
      return `
      <tr>
        <td class="col-rank">${w.gw}</td>
        <td class="col-team">${escapeHtml(w.teamName)}</td>
        <td class="col-manager">${escapeHtml(w.managerName)}</td>
        <td class="col-num">${w.points}</td>
      </tr>`;
    })
    .join("");
}

// ---------- Manager detail ----------

async function openManager(entryId) {
  showView("manager");
  els.managerDetail.innerHTML = `<p class="loading-row">Loading…</p>`;

  const snap = await getDoc(doc(db, `managers/${entryId}`));
  if (!snap.exists()) {
    els.managerDetail.innerHTML = `<p class="loading-row">Manager not found.</p>`;
    return;
  }
  const m = snap.data();
  const history = [...(m.history || [])].sort((a, b) => a.gw - b.gw);
  const maxPts = Math.max(...history.map((h) => h.points), 1);
  const best = Math.max(...history.map((h) => h.points));

  els.managerDetail.innerHTML = `
    <div class="manager-header">
      <h2>${escapeHtml(m.teamName)}</h2>
      <p>${escapeHtml(m.managerName)} · Rank ${m.currentRank} · ${m.totalPoints} pts total</p>
    </div>
    <div class="sparkline" aria-hidden="true">
      ${history
        .map(
          (h) =>
            `<div class="spark-bar ${h.points === best ? "best" : ""}" style="height:${Math.max(
              (h.points / maxPts) * 100,
              4
            )}%" title="GW${h.gw}: ${h.points} pts"></div>`
        )
        .join("")}
    </div>
    <table class="sheet-table">
      <thead>
        <tr>
          <th class="col-rank">GW</th>
          <th class="col-num">Pts</th>
          <th class="col-num">Bench</th>
          <th class="col-num">Transfers</th>
          <th class="col-num">Hit</th>
          <th class="col-num">Total</th>
        </tr>
      </thead>
      <tbody>
        ${history
          .slice()
          .reverse()
          .map(
            (h) => `
          <tr>
            <td class="col-rank">${h.gw}</td>
            <td class="col-num">${h.points}</td>
            <td class="col-num">${h.benchPoints}</td>
            <td class="col-num">${h.transfers}</td>
            <td class="col-num">${h.transferCost > 0 ? "-" + h.transferCost : "—"}</td>
            <td class="col-num">${h.totalPoints}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

// ---------- Utils ----------

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// ---------- Boot ----------

(async function init() {
  const meta = await loadLeagueMeta();
  await loadStandings();
  await loadStats(meta);
  await loadWinners();
})();
