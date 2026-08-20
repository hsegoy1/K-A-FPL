// scripts/sync.js
//
// Pulls data from the public FPL API for one classic mini-league and writes it
// into Firestore so the website can read it without hitting the FPL API directly
// (the FPL API has no CORS support for browsers, and no auth is needed to read it).
//
// Run manually:   FPL_LEAGUE_ID=878289 FIREBASE_SERVICE_ACCOUNT='<json>' node scripts/sync.js
// Run in CI:       triggered by .github/workflows/sync.yml on a schedule

import admin from "firebase-admin";
import fetch from "node-fetch";

const LEAGUE_ID = process.env.FPL_LEAGUE_ID;
if (!LEAGUE_ID) throw new Error("Missing FPL_LEAGUE_ID env var");

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountJson) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT env var");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
});
const db = admin.firestore();

const FPL_BASE = "https://fantasy.premierleague.com/api";

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "office-fpl-league-sync/1.0" },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  console.log(`Syncing league ${LEAGUE_ID}...`);

  // 1. Bootstrap data: players, teams, gameweek (event) list
  const bootstrap = await getJson(`${FPL_BASE}/bootstrap-static/`);
  const players = new Map(bootstrap.elements.map((p) => [p.id, p]));
  const events = bootstrap.events;
  const lastFinished = [...events].reverse().find((e) => e.finished);
  const currentEvent = events.find((e) => e.is_current) || lastFinished;
  if (!lastFinished) {
    console.log("No finished gameweek yet this season — nothing to sync.");
    return;
  }
  const gw = lastFinished.id;
  console.log(`Latest finished gameweek: GW${gw}`);

  // 2. League standings (classic league, single page is enough for <50 managers)
  const standings = await getJson(
    `${FPL_BASE}/leagues-classic/${LEAGUE_ID}/standings/`
  );
  const leagueName = standings.league.name;
  const managers = standings.standings.results; // [{ entry, player_name, entry_name, rank, total, ... }]

  console.log(`League: ${leagueName}, ${managers.length} managers`);

  await db.doc("leagueMeta/info").set({
    leagueId: LEAGUE_ID,
    leagueName,
    lastSyncedGw: gw,
    lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    managerCount: managers.length,
  });

  // 3. Per-manager: full history (one call gives every past GW) + this GW's picks (for captain/chip/bench)
  const gwResults = []; // { entryId, name, teamName, gwPoints, benchPoints, transfers, hits, captainId }

  for (const m of managers) {
    const entryId = m.entry;
    const [history, picks] = await Promise.all([
      getJson(`${FPL_BASE}/entry/${entryId}/history/`),
      getJson(`${FPL_BASE}/entry/${entryId}/event/${gw}/picks/`).catch(() => null),
    ]);

    const thisGw = history.current.find((h) => h.event === gw);
    const captainPickId = picks?.picks?.find((p) => p.is_captain)?.element;
    const captainName = captainPickId ? players.get(captainPickId)?.web_name : null;

    await db.doc(`managers/${entryId}`).set(
      {
        entryId,
        managerName: m.player_name,
        teamName: m.entry_name,
        currentRank: m.rank,
        totalPoints: m.total,
        lastGwPoints: thisGw?.points ?? null,
        history: history.current.map((h) => ({
          gw: h.event,
          points: h.points,
          totalPoints: h.total_points,
          rank: h.rank,
          overallRank: h.overall_rank,
          benchPoints: h.points_on_bench,
          transfers: h.event_transfers,
          transferCost: h.event_transfers_cost,
        })),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    if (thisGw) {
      gwResults.push({
        entryId,
        managerName: m.player_name,
        teamName: m.entry_name,
        gwPoints: thisGw.points,
        benchPoints: thisGw.points_on_bench,
        transfers: thisGw.event_transfers,
        transferCost: thisGw.event_transfers_cost,
        captainName,
      });
    }
  }

  // 4. Fun stats for this gameweek
  const byPoints = [...gwResults].sort((a, b) => b.gwPoints - a.gwPoints);
  const gwWinner = byPoints[0];
  const gwLoser = byPoints[byPoints.length - 1];
  const biggestBench = [...gwResults].sort((a, b) => b.benchPoints - a.benchPoints)[0];
  const mostHits = [...gwResults].sort((a, b) => b.transferCost - a.transferCost)[0];

  const captainCounts = {};
  for (const r of gwResults) {
    if (!r.captainName) continue;
    captainCounts[r.captainName] = (captainCounts[r.captainName] || 0) + 1;
  }
  const mostCaptained = Object.entries(captainCounts).sort((a, b) => b[1] - a[1])[0];

  const avgPoints =
    gwResults.reduce((sum, r) => sum + r.gwPoints, 0) / gwResults.length;

  await db.doc(`gameweeks/gw${gw}`).set({
    gw,
    winner: gwWinner
      ? { entryId: gwWinner.entryId, managerName: gwWinner.managerName, teamName: gwWinner.teamName, points: gwWinner.gwPoints }
      : null,
    loser: gwLoser
      ? { entryId: gwLoser.entryId, managerName: gwLoser.managerName, teamName: gwLoser.teamName, points: gwLoser.gwPoints }
      : null,
    biggestBench: biggestBench
      ? { entryId: biggestBench.entryId, managerName: biggestBench.managerName, benchPoints: biggestBench.benchPoints }
      : null,
    mostHits: mostHits && mostHits.transferCost > 0
      ? { entryId: mostHits.entryId, managerName: mostHits.managerName, transferCost: mostHits.transferCost }
      : null,
    mostCaptained: mostCaptained
      ? { player: mostCaptained[0], count: mostCaptained[1] }
      : null,
    averagePoints: Math.round(avgPoints * 10) / 10,
    syncedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Maintain a running log of GW winners for the "MW winner" prize tracker
  if (gwWinner) {
    await db.doc(`mwWinners/gw${gw}`).set({
      gw,
      entryId: gwWinner.entryId,
      managerName: gwWinner.managerName,
      teamName: gwWinner.teamName,
      points: gwWinner.gwPoints,
    });
  }

  console.log(`Synced GW${gw}. Winner: ${gwWinner?.managerName} (${gwWinner?.gwPoints} pts)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
