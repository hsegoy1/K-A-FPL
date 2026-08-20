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
const POSITION_MAP = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

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
  const teamsById = new Map(bootstrap.teams.map((t) => [t.id, t.short_name]));
  const events = bootstrap.events;
  const lastFinished = [...events].reverse().find((e) => e.finished);
  const gw = lastFinished ? lastFinished.id : null;
  if (!lastFinished) {
    console.log(
      "No gameweek fully finished yet this season (results may still be pending bonus points) — " +
      "will still sync standings/managers, but skip gameweek-specific stats for now."
    );
  } else {
    console.log(`Latest finished gameweek: GW${gw}`);
  }

  // 1b. Compact player directory — every player's name/position/club, so the
  // frontend can render jerseys and squads without hitting the FPL API itself
  // (browsers can't call it directly — see the CORS note above).
  const playersMeta = {};
  for (const p of bootstrap.elements) {
    playersMeta[p.id] = {
      n: p.web_name,
      pos: POSITION_MAP[p.element_type] || "MID",
      team: teamsById.get(p.team) || "UNK",
    };
  }
  await db.doc("playersMeta/current").set({
    players: playersMeta,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 1c. This gameweek's live per-player points (only fetched once, shared by
  // every manager below) — the picks endpoint tells us WHO was picked, this
  // endpoint tells us what they actually scored that week.
  let livePointsByElement = {};
  if (gw) {
    const live = await getJson(`${FPL_BASE}/event/${gw}/live/`);
    for (const el of live.elements) {
      livePointsByElement[el.id] = el.stats.total_points;
    }
  }

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
  const gwSquadsRollup = {}; // compact league-wide snapshot for this GW — powers Template/Differential/Doppelgänger without 30 separate reads

  for (const m of managers) {
    const entryId = m.entry;
    const [history, picks] = await Promise.all([
      getJson(`${FPL_BASE}/entry/${entryId}/history/`),
      gw
        ? getJson(`${FPL_BASE}/entry/${entryId}/event/${gw}/picks/`).catch(() => null)
        : Promise.resolve(null),
    ]);

    const thisGw = gw ? history.current.find((h) => h.event === gw) : null;
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

    // 3b. Full squad snapshot for this GW (starting XI + bench + captain + chip),
    // stored per-manager so it accumulates week by week without ever needing to
    // re-fetch past gameweeks. This is what drives jerseys, Captaincy Alpha, and
    // chip-effectiveness on the frontend.
    if (gw && picks?.picks) {
      const withPoints = (p) => ({
        element: p.element,
        pts: livePointsByElement[p.element] ?? 0,
        isCaptain: !!p.is_captain,
      });
      const starting = picks.picks.filter((p) => p.position <= 11).map(withPoints);
      const bench = picks.picks.filter((p) => p.position > 11).map(withPoints);
      const chip = picks.active_chip || null;

      await db.doc(`managers/${entryId}/gwSquads/gw${gw}`).set({
        gw,
        captain: captainPickId || null,
        viceCaptain: picks.picks.find((p) => p.is_vice_captain)?.element || null,
        chip,
        starting,
        bench,
      });

      gwSquadsRollup[entryId] = {
        teamName: m.entry_name,
        captain: captainPickId || null,
        chip,
        starting: starting.map((p) => p.element),
        bench: bench.map((p) => p.element),
      };
    }

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

  // 3c. Write the league-wide compact rollup for this GW (one doc, not 30 reads)
  if (gw && Object.keys(gwSquadsRollup).length > 0) {
    await db.doc(`gameweekSquads/gw${gw}`).set({
      gw,
      entries: gwSquadsRollup,
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // 4. Fun stats for this gameweek (only if a gameweek has actually finished)
  if (!gw || gwResults.length === 0) {
    console.log(`Synced ${managers.length} managers' standings. No finished gameweek yet — skipping stats.`);
    return;
  }

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
