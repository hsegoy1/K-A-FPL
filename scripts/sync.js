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

// Optional — AI-generated narrative content (gameweek recaps, season story,
// etc). Not required for the sync to work; features that need it just don't
// generate until this is set, same pattern as every other optional piece
// here. Never hardcode the actual key value — it lives only as a GitHub
// Actions secret, read at runtime.
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Single reusable entry point for every AI-generated feature this season —
// one place to swap models, adjust token limits, or add retry logic once,
// rather than duplicating fetch calls across every feature that needs text.
async function callOpenRouter(prompt, maxTokens = 600) {
  if (!OPENROUTER_API_KEY) {
    console.log("⚠️  OPENROUTER_API_KEY not set — skipping AI generation for this feature");
    return null;
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "poolside/laguna-s-2.1:free",
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) {
      console.log(`⚠️  OpenRouter request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (err) {
    console.log(`⚠️  OpenRouter call errored: ${err.message}`);
    return null;
  }
}

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

  // Team strength ratings (FPL's own attack/defence numbers, home vs away
  // splits) — powers "Fixture Weather" icons on the frontend (blowout risk,
  // upset alert, likely 0-0). Written once per sync since it barely changes
  // week to week, but cheap enough not to bother gating further.
  const teamStrength = {};
  bootstrap.teams.forEach((t) => {
    teamStrength[t.short_name] = {
      attackHome: t.strength_attack_home,
      attackAway: t.strength_attack_away,
      defenceHome: t.strength_defence_home,
      defenceAway: t.strength_defence_away,
      overallHome: t.strength_overall_home,
      overallAway: t.strength_overall_away,
    };
  });
  await db.doc("teamsMeta/strength").set({ teams: teamStrength, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  // Team of the Season — best XI by total FPL points this season so far,
  // computed from the bootstrap data we already fetched. No dependency on
  // `gw` being resolved yet, so this can safely run up here.
  const seasonPos = { 1:[], 2:[], 3:[], 4:[] };
  bootstrap.elements.forEach(p => {
    if (p.total_points > 0) {
      seasonPos[p.element_type]?.push({ id: p.id, pts: p.total_points, n: p.web_name, team: teamsById.get(p.team)||"?" });
    }
  });
  const seasonXI = [
    ...seasonPos[1].sort((a,b)=>b.pts-a.pts).slice(0,1),
    ...seasonPos[2].sort((a,b)=>b.pts-a.pts).slice(0,4),
    ...seasonPos[3].sort((a,b)=>b.pts-a.pts).slice(0,4),
    ...seasonPos[4].sort((a,b)=>b.pts-a.pts).slice(0,2),
  ];
  await db.doc("dreamTeam/season").set({
    players: seasonXI,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  // Track the CURRENT gameweek from the moment its deadline passes (kickoff),
  // not just once every match is over — this is what makes standings update
  // live as Saturday's games happen instead of sitting blank all weekend.
  // "Final" means FPL has both finished the GW and confirmed bonus points
  // (data_checked) — until then, numbers are provisional and can still move.
  const currentEvent = events.find((e) => e.is_current);
  const lastFinished = [...events].reverse().find((e) => e.finished);
  const targetEvent = currentEvent || lastFinished;
  const gw = targetEvent ? targetEvent.id : null;
  const isFinal = targetEvent ? !!(targetEvent.finished && targetEvent.data_checked) : false;

  // Official FPL Dream Team (Team of the Week) for the current GW — needs
  // `gw` resolved above, so this has to live down here, not next to the
  // Team of the Season block even though they're logically related.
  if (gw) {
    try {
      const dreamTeam = await getJson(`${FPL_BASE}/dream-team/${gw}/`);
      if (dreamTeam?.top_players?.length) {
        await db.doc(`dreamTeam/gw${gw}`).set({
          gw,
          players: dreamTeam.top_players,
          formation: dreamTeam.formation || null,
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`Dream Team GW${gw}: ${dreamTeam.top_players.length} players synced`);
      }
    } catch (e) {
      console.log(`Dream Team GW${gw} fetch failed: ${e.message}`);
    }
  }

  if (!targetEvent) {
    console.log("No gameweek has kicked off yet this season — will still sync standings/managers, but skip gameweek-specific stats for now.");
  } else {
    console.log(`GW${gw} — ${isFinal ? "final (bonus confirmed)" : "live/provisional"}`);
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
      price: p.now_cost, // 0.1m units — e.g. 60 = £6.0m
    };
  }
  await db.doc("playersMeta/current").set({
    players: playersMeta,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 1c. This gameweek's live per-player stats (only fetched once, shared by
  // every manager below) — the picks endpoint tells us WHO was picked, this
  // endpoint tells us what they actually did that week: goals, assists,
  // cards, minutes, etc. — not just a total points number.
  let livePointsByElement = {};   // element -> total_points (kept for quick lookups elsewhere)
  let liveStatsByElement = {};    // element -> full stat breakdown
  if (gw) {
    const live = await getJson(`${FPL_BASE}/event/${gw}/live/`);
    for (const el of live.elements) {
      livePointsByElement[el.id] = el.stats.total_points;
      liveStatsByElement[el.id] = {
        pts: el.stats.total_points,
        minutes: el.stats.minutes,
        goals: el.stats.goals_scored,
        assists: el.stats.assists,
        cleanSheet: el.stats.clean_sheets,
        goalsConceded: el.stats.goals_conceded,
        ownGoals: el.stats.own_goals,
        penSaved: el.stats.penalties_saved,
        penMissed: el.stats.penalties_missed,
        yellowCards: el.stats.yellow_cards,
        redCards: el.stats.red_cards,
        saves: el.stats.saves,
        bonus: el.stats.bonus,
      };
    }
    // Store it standalone too (not just embedded in each manager's squad) —
    // this is what lets the frontend show a single player's own GW-by-GW
    // score trend, and their full stat breakdown for a specific week,
    // independent of who owned them.
    await db.doc(`gwPlayerPoints/gw${gw}`).set({
      gw,
      points: livePointsByElement, // kept for the lightweight by-GW sparkline
      stats: liveStatsByElement,   // full breakdown for the detail view
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // 1d. Next deadline — the frontend can't call bootstrap-static itself (no
  // CORS support for browsers), so the live countdown needs this stored here.
  const nextEvent = events.find((e) => e.is_next) || events.find((e) => !e.finished);
  const nextDeadline = nextEvent ? nextEvent.deadline_time : null;

  // 1e. Fixtures for this gameweek and the next one — powers the Table tab's
  // match detail popups (goals/assists/cards/saves/bonus, split by team) and
  // kickoff countdowns for matches that haven't happened yet. Element IDs are
  // kept as-is (not resolved to names) to stay consistent with how squads are
  // stored — the frontend already has playersMeta for that lookup.
  async function syncFixturesForGw(targetGw) {
    if (!targetGw) return;
    const fixtures = await getJson(`${FPL_BASE}/fixtures/?event=${targetGw}`).catch((err) => {
      console.log(`⚠️  Fixtures fetch FAILED for GW${targetGw}: ${err.message}`);
      return null;
    });
    if (fixtures === null) return; // fetch itself failed — leave whatever was there before untouched
    const compact = fixtures.map((f) => ({
      id: f.id,
      home: teamsById.get(f.team_h) || "UNK",
      away: teamsById.get(f.team_a) || "UNK",
      kickoff: f.kickoff_time,
      // FPL has two different "finished" flags: `finished` only flips true
      // once the result is fully, officially confirmed (can take a long
      // time) — `finished_provisional` flips true the moment the match
      // itself ends, with a real score and full stats already available.
      // We want the second one for "does this match have a result to show".
      finished: f.finished_provisional,
      official: f.finished, // kept so the frontend can show a small "provisional" tag
      homeScore: f.team_h_score,
      awayScore: f.team_a_score,
      stats: (f.stats || []).reduce((acc, s) => {
        acc[s.identifier] = { home: s.h, away: s.a };
        return acc;
      }, {}),
    }));
    await db.doc(`gameweekFixtures/gw${targetGw}`).set({
      gw: targetGw,
      fixtures: compact,
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const finishedCount = compact.filter((f) => f.finished).length;
    console.log(`Fixtures GW${targetGw}: ${compact.length} matches synced, ${finishedCount} finished with a score`);
  }
  await syncFixturesForGw(gw);
  if (nextEvent && nextEvent.id !== gw) await syncFixturesForGw(nextEvent.id);
  // Also refresh the previous gameweek — a safety net for the exact moment
  // the season transitions to a new "current" GW: without this, whichever
  // gameweek just got superseded would freeze in whatever state it was last
  // synced in, even if some of its matches were still mid-confirmation
  // (bonus points not yet locked in) at that exact moment.
  if (gw && gw > 1) await syncFixturesForGw(gw - 1);

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
    isFinal,
    nextDeadline,
    nextGw: nextEvent ? nextEvent.id : null,
    lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    managerCount: managers.length,
  });

  // 3. Per-manager: full history (one call gives every past GW) + this GW's picks (for captain/chip/bench)
  const gwResults = []; // { entryId, name, teamName, gwPoints, benchPoints, transfers, hits, captainId }
  const gwSquadsRollup = {}; // compact league-wide snapshot for this GW — powers Template/Differential/Doppelgänger without 30 separate reads
  const gwTransfersRollup = {}; // who moved who in/out FOR this gw, league-wide — powers the Transfer Activity insight
  const nextGwTransfersRollup = {}; // transfers already banked for the UPCOMING gw, made during the current pre-deadline window
  const managerHistoryMap = {}; // entryId -> fullHistory — shared by DNA, FPL IQ, and other features needing season-long data

  for (const m of managers) {
    const entryId = m.entry;
    const [history, picks, transfersRaw] = await Promise.all([
      getJson(`${FPL_BASE}/entry/${entryId}/history/`),
      gw
        ? getJson(`${FPL_BASE}/entry/${entryId}/event/${gw}/picks/`).catch(() => null)
        : Promise.resolve(null),
      (gw || nextEvent)
        ? getJson(`${FPL_BASE}/entry/${entryId}/transfers/`).catch(() => [])
        : Promise.resolve([]),
    ]);
    // The transfers endpoint returns a manager's whole-season transfer
    // history in one call. FPL tags each transfer with the gameweek it's
    // FOR, not when it was made — so a transfer made right now, during the
    // window before next gameweek's deadline, is tagged with that NEXT
    // gameweek's number, not the current one. Capture both: this gw's
    // (already-locked, historical) transfers, and the next gw's (live,
    // still-changeable) ones — that second bucket is what "who's making
    // moves right now" actually means.
    const transfersThisGw = (transfersRaw || []).filter((t) => t.event === gw);
    const transfersForNextGw = nextEvent ? (transfersRaw || []).filter((t) => t.event === nextEvent.id) : [];
    if (transfersForNextGw.length > 0) {
      nextGwTransfersRollup[entryId] = {
        teamName: m.entry_name,
        transfersIn: transfersForNextGw.map((t) => t.element_in),
        transfersOut: transfersForNextGw.map((t) => t.element_out),
      };
    }

    // While a gameweek is live, FPL's season-history endpoint hasn't posted an
    // entry for it yet — but the picks endpoint's own entry_history reflects
    // live, updating-in-real-time scoring for that GW. Use that when present,
    // and fall back to the confirmed history entry once the GW does show up
    // there (which also just works correctly for every past, finished GW).
    // `value`/`bank` (team value and money in the bank, in 0.1m units) power
    // the "Smart Money" team-value-growth insight.
    const liveEntry = picks?.entry_history
      ? {
          gw,
          points: picks.entry_history.points,
          totalPoints: picks.entry_history.total_points,
          rank: picks.entry_history.rank,
          overallRank: picks.entry_history.overall_rank,
          benchPoints: picks.entry_history.points_on_bench,
          transfers: picks.entry_history.event_transfers,
          transferCost: picks.entry_history.event_transfers_cost,
          value: picks.entry_history.value,
          bank: picks.entry_history.bank,
        }
      : null;
    const confirmedHistory = history.current
      .filter((h) => h.event !== gw) // drop a stale/duplicate entry for the live GW if one exists
      .map((h) => ({
        gw: h.event,
        points: h.points,
        totalPoints: h.total_points,
        rank: h.rank,
        overallRank: h.overall_rank,
        benchPoints: h.points_on_bench,
        transfers: h.event_transfers,
        transferCost: h.event_transfers_cost,
        value: h.value,
        bank: h.bank,
      }));
    const fullHistory = (liveEntry ? [...confirmedHistory, liveEntry] : confirmedHistory)
      .sort((a, b) => a.gw - b.gw);
    managerHistoryMap[entryId] = { entryId, entry_name: m.entry_name, player_name: m.player_name, fullHistory };
    const thisGw = fullHistory.find((h) => h.gw === gw) || null;

    const captainPickId = picks?.picks?.find((p) => p.is_captain)?.element;
    const captainName = captainPickId ? players.get(captainPickId)?.web_name : null;

    await db.doc(`managers/${entryId}`).set(
      {
        entryId,
        managerName: m.player_name,
        teamName: m.entry_name,
        currentRank: m.rank,
        totalPoints: thisGw ? thisGw.totalPoints : m.total,
        lastGwPoints: thisGw?.points ?? null,
        history: fullHistory,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // 3b. Full squad snapshot for this GW (starting XI + bench + captain + chip),
    // stored per-manager so it accumulates week by week without ever needing to
    // re-fetch past gameweeks. This is what drives jerseys, Captaincy Alpha, and
    // chip-effectiveness on the frontend.
    if (gw && picks?.picks) {
      // FPL's own `multiplier` field already handles the vice-captain
      // takeover automatically (if the real captain gets 0 minutes, FPL
      // moves the 2x bonus to the vice-captain and reflects that here).
      // Stored as raw points + multiplier separately (not pre-multiplied) —
      // Captaincy Alpha needs the raw score to correctly measure the
      // marginal value of the captaincy decision itself; the squad view
      // applies the multiplier only when actually displaying points.
      const withPoints = (p) => ({
        element: p.element,
        pts: livePointsByElement[p.element] ?? 0,
        multiplier: p.multiplier ?? 1,
        isCaptain: (p.multiplier ?? 1) >= 2, // whoever actually got the multiplier this week
      });
      const starting = picks.picks.filter((p) => p.position <= 11).map(withPoints);
      const bench = picks.picks.filter((p) => p.position > 11).map(withPoints);
      const chip = picks.active_chip || null;
      const effectiveCaptainId = picks.picks.find((p) => (p.multiplier ?? 1) >= 2)?.element || captainPickId || null;
      // Dedupe by the actual (in, out) swap pair — not each side
      // independently, which would break the parallel index alignment that
      // Transfer Lab and Transfer Verdict rely on (transfersIn[j] must stay
      // paired with transfersOut[j] as the same swap).
      const uniqueTransfers = [...new Map(transfersThisGw.map((t) => [`${t.element_in}-${t.element_out}`, t])).values()];
      const transfersIn = uniqueTransfers.map((t) => ({ element: t.element_in, cost: t.element_in_cost }));
      const transfersOut = uniqueTransfers.map((t) => ({ element: t.element_out, cost: t.element_out_cost }));

      await db.doc(`managers/${entryId}/gwSquads/gw${gw}`).set({
        gw,
        captain: effectiveCaptainId,
        viceCaptain: picks.picks.find((p) => p.is_vice_captain)?.element || null,
        chip,
        starting,
        bench,
        transfersIn,
        transfersOut,
      });

      gwSquadsRollup[entryId] = {
        teamName: m.entry_name,
        captain: effectiveCaptainId,
        chip,
        starting: starting.map((p) => p.element),
        bench: bench.map((p) => p.element),
      };
      if (transfersThisGw.length > 0) {
        gwTransfersRollup[entryId] = {
          teamName: m.entry_name,
          transfersIn: transfersIn.map((t) => t.element),
          transfersOut: transfersOut.map((t) => t.element),
        };
      }
    }

    if (thisGw) {
      gwResults.push({
        entryId,
        managerName: m.player_name,
        teamName: m.entry_name,
        gwPoints: thisGw.points,
        benchPoints: thisGw.benchPoints ?? 0,
        transfers: thisGw.transfers ?? 0,
        transferCost: thisGw.transferCost ?? 0,
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

    // Ghost Teams — three synthetic "managers" with fixed personalities,
    // recomputed fresh from real league ownership every gameweek (no memory
    // needed between weeks, so nothing can drift):
    //   Algorithm — most-owned XI in the league, captains the most-owned player
    //   Robot     — same XI, but captains whoever was most-CAPTAINED instead
    //   Madman    — the exact opposite: least-owned XI, captains the least-owned player
    const ownershipCount = {};
    const captainCount = {};
    Object.values(gwSquadsRollup).forEach((entry) => {
      entry.starting.forEach((id) => { ownershipCount[id] = (ownershipCount[id] || 0) + 1; });
      if (entry.captain) captainCount[entry.captain] = (captainCount[entry.captain] || 0) + 1;
    });
    const byPosition = { 1: [], 2: [], 3: [], 4: [] }; // GKP, DEF, MID, FWD
    Object.keys(ownershipCount).forEach((idStr) => {
      const id = parseInt(idStr);
      const p = players.get(id);
      if (p) byPosition[p.element_type].push({ id, count: ownershipCount[id] });
    });
    const pickXI = (sortDir) => {
      const sorted = (arr) => [...arr].sort((a, b) => sortDir * (b.count - a.count));
      return [
        ...sorted(byPosition[1]).slice(0, 1),
        ...sorted(byPosition[2]).slice(0, 4),
        ...sorted(byPosition[3]).slice(0, 4),
        ...sorted(byPosition[4]).slice(0, 2),
      ].map((x) => x.id);
    };
    const templateXI = pickXI(1);
    const differentialXI = pickXI(-1);
    const scoreXI = (xi, captainId) =>
      xi.reduce((sum, id) => sum + (livePointsByElement[id] || 0) * (id === captainId ? 2 : 1), 0);

    const mostOwned = Object.entries(ownershipCount).sort((a, b) => b[1] - a[1])[0];
    const mostCaptained = Object.entries(captainCount).sort((a, b) => b[1] - a[1])[0];
    const leastOwned = Object.entries(ownershipCount).sort((a, b) => a[1] - b[1])[0];
    const algorithmCaptain = mostOwned ? parseInt(mostOwned[0]) : null;
    const robotCaptain = mostCaptained ? parseInt(mostCaptained[0]) : algorithmCaptain;
    const madmanCaptain = leastOwned ? parseInt(leastOwned[0]) : null;

    await db.doc(`ghostTeams/gw${gw}`).set({
      gw,
      algorithm: { starting: templateXI, captain: algorithmCaptain, points: scoreXI(templateXI, algorithmCaptain) },
      robot: { starting: templateXI, captain: robotCaptain, points: scoreXI(templateXI, robotCaptain) },
      madman: { starting: differentialXI, captain: madmanCaptain, points: scoreXI(differentialXI, madmanCaptain) },
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  if (gw && Object.keys(gwTransfersRollup).length > 0) {
    await db.doc(`gameweekTransfers/gw${gw}`).set({
      gw,
      entries: gwTransfersRollup,
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  // Live, pre-deadline transfers for the upcoming gameweek. Note this writes
  // to the exact same doc path (`gameweekTransfers/gw{N}`) that the block
  // above will eventually take over once that gameweek actually starts —
  // so the picture naturally hands off from "live/incomplete" to "locked/
  // final" without any special reconciliation needed.
  if (nextEvent && Object.keys(nextGwTransfersRollup).length > 0) {
    await db.doc(`gameweekTransfers/gw${nextEvent.id}`).set({
      gw: nextEvent.id,
      entries: nextGwTransfersRollup,
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // 4. Fun stats for this gameweek — computed as soon as the GW is live, not
  // just once it's finished, so standings/awards update through the weekend
  if (!gw || gwResults.length === 0) {
    console.log(`Synced ${managers.length} managers' standings. No gameweek in progress yet — skipping stats.`);
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
    isFinal, // frontend shows a "LIVE — bonus not final" badge whenever this is false
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

  // Maintain a running log of GW winners for the "MW winner" prize tracker —
  // but ONLY once bonus points are confirmed. This is real money: locking in
  // a "winner" off provisional numbers that could still shift by a point or
  // two (and flip who actually won) isn't a risk worth taking.
  if (gwWinner && isFinal) {
    await db.doc(`mwWinners/gw${gw}`).set({
      gw,
      entryId: gwWinner.entryId,
      managerName: gwWinner.managerName,
      teamName: gwWinner.teamName,
      points: gwWinner.gwPoints,
    });
  }

  // GW Bingo — compute which squares each manager hit this gameweek.  // The 24 non-free squares are defined once; each manager gets a
  // deterministically shuffled card (seeded by entryId × gw so it's
  // always the same card for that person, just different from their
  // neighbours'). Ghost team scores read from the block computed above.
  const ghostSnap = await db.doc(`ghostTeams/gw${gw}`).get();
  const ghostData = ghostSnap.exists ? ghostSnap.data() : null;
  const gwWinnerPoints = gwWinner?.gwPoints || 0;

  const BINGO_SQUARES = [
    { id:"captain_blank",    check:(r,sq) => { const cap = sq.starting.find(id=>id===r.capElement); return cap && (livePointsByElement[cap]||0) < 4; } },
    { id:"haul_15",          check:(r,sq) => sq.starting.some(id=>(livePointsByElement[id]||0)>=15) },
    { id:"bench_beats",      check:(r)    => r.benchPoints > r.gwPoints - r.benchPoints },
    { id:"hit_scores",       check:(r,sq) => r.transferCost>0 && sq.starting.some(id=>(livePointsByElement[id]||0)>=8) },
    { id:"win_gw",           check:(r)    => r.gwPoints===gwWinnerPoints && gwWinnerPoints>0 },
    { id:"no_transfers",     check:(r)    => r.transfers===0 },
    { id:"under_avg",        check:(r)    => r.gwPoints < avgPoints - 2 },
    { id:"diff_scores",      check:(r,sq) => sq.starting.some(id=>{ const oc=ownershipCount[id]||0; return oc<=2 && (livePointsByElement[id]||0)>=10; }) },
    { id:"best_on_bench",    check:(r,sq) => { const benchMax=sq.bench.reduce((m,id)=>Math.max(m,livePointsByElement[id]||0),0); const startMin=sq.starting.reduce((m,id)=>Math.min(m,livePointsByElement[id]||0),99); return benchMax>startMin; } },
    { id:"chip_played",      check:(r)    => !!r.chip },
    { id:"algorithm_beats",  check:(r)    => ghostData && r.gwPoints<(ghostData.algorithm?.points||0) },
    { id:"robot_beats",      check:(r)    => ghostData && r.gwPoints<(ghostData.robot?.points||0) },
    { id:"madman_beats",     check:(r)    => ghostData && r.gwPoints<(ghostData.madman?.points||0) },
    { id:"top_scorer",       check:(r)    => r.gwPoints===gwWinnerPoints && gwWinnerPoints>0 },
    { id:"under_30",         check:(r)    => r.gwPoints<30 },
    { id:"hattrick",         check:(r,sq) => sq.starting.some(id=>(liveStatsByElement[id]?.goals||0)>=3) },
    { id:"triple_captain",   check:(r)    => r.chip==="3xc" },
    { id:"big_hit",          check:(r)    => r.transferCost>=8 },
    { id:"clean_sheet",      check:(r,sq) => sq.starting.some(id=>{ const p=players.get(id); return p&&[1,2].includes(p.element_type)&&(liveStatsByElement[id]?.cleanSheet||0)>0; }) },
    { id:"on_avg",           check:(r)    => Math.abs(r.gwPoints-avgPoints)<=1 },
    { id:"captain_wins",     check:(r,sq) => { const capPts=(livePointsByElement[r.capElement]||0)*2; return gwResults.filter(x=>x.entryId!==r.entryId).every(x=>{ const xCap=gwSquadsRollup[x.entryId]?.captain; return capPts>=(livePointsByElement[xCap]||0)*2; }); } },
    { id:"climb_5",          check:(r)    => { const prev=r.prevRank; return prev&&r.currentRank&&(prev-r.currentRank)>=5; } },
    { id:"top_3",            check:(r)    => r.currentRank<=3 },
    { id:"score_over_70",    check:(r)    => r.gwPoints>=70 },
  ];

  // Seeded shuffle: consistent card for the same manager+GW, different from others
  function seededShuffle(arr, seed) {
    const a = [...arr];
    let s = seed;
    for (let i = a.length-1; i>0; i--) {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      const j = Math.abs(s) % (i+1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const BINGO_LINES = [
    [0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
    [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
    [0,6,12,18,24],[4,8,12,16,20],
  ];

  const bingoWrites = [];
  for (const r of gwResults) {
    const squad = gwSquadsRollup[r.entryId];
    if (!squad) continue;
    const augmented = { ...r, capElement: squad.captain, currentRank: managers.find(m=>m.entryId===r.entryId)?.currentRank||99, prevRank: null };
    const seed = (r.entryId * 31 + gw * 997) | 0;
    const shuffled = seededShuffle(BINGO_SQUARES, seed);
    // Build 5×5: indices 0-11 are shuffled squares, 12 is FREE, 13-24 continue
    const card = [...shuffled.slice(0,12), null, ...shuffled.slice(12,24)];
    const hits = card.map((sq, i) => {
      if (i===12) return true; // FREE
      if (!sq) return false;
      try { return !!sq.check(augmented, squad); } catch(e) { return false; }
    });
    const bingoLines = BINGO_LINES.filter(line=>line.every(i=>hits[i])).length;
    bingoWrites.push(db.doc(`gwBingo/gw${gw}_${r.entryId}`).set({
      gw, entryId: r.entryId, teamName: r.teamName,
      card: card.map(sq=>sq?.id||"free"),
      hits,
      bingoCount: bingoLines,
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
  }
  if (bingoWrites.length > 0) {
    await Promise.all(bingoWrites);
    console.log(`GW Bingo computed for ${bingoWrites.length} managers`);
  }

  // Manager DNA — classify each manager's playing style from their season-long
  // decisions. Runs every sync, scores update as more data accumulates.
  await computeManagerDNA(managerHistoryMap, gw);
  await computeFplIQ(managerHistoryMap, gw);
  await computeGotAway(managerHistoryMap, gwTransfersRollup, livePointsByElement, playersMeta, gw);
  await computeLostPoints(gwResults, gwSquadsRollup, livePointsByElement, gw);

  // AI-generated gameweek recap ("The Autopsy") — fires on WHICHEVER comes
  // first: FPL's own official confirmation, or our own fixture-based
  // "safely done" check (all matches finished + a comfortable buffer for
  // bonus points to settle). This is what stops the recap sitting stuck
  // for days if FPL is just slow to flip data_checked, without ever
  // narrating a story off numbers that genuinely haven't finished yet.
  const gwSafelyDone = await checkGwSafelyDoneForAI(gw);
  if (isFinal || gwSafelyDone) {
    await generateAutopsyIfNeeded(gw, { gwWinner, gwLoser, biggestBench, mostHits, mostCaptained, avgPoints });
  }
  // These two check fixture-day readiness internally (see
  // checkTodaysFixturesReady), so they're called every sync regardless of
  // whole-GW isFinal status — they update themselves once each matchday's
  // games actually finish, not just once at the very end of the gameweek.
  await generateFplCourtIfNeeded(gw, gwResults, gwSquadsRollup, livePointsByElement, avgPoints, playersMeta);
  await generatePressConferenceIfNeeded(gw, gwResults, avgPoints);

  console.log(`Synced GW${gw}. Winner: ${gwWinner?.managerName} (${gwWinner?.gwPoints} pts)`);
}

// Only generates once per gameweek — checks Firestore first so a finalized
// GW's story never gets silently (and wastefully) regenerated on every
// subsequent 15-minute sync run within that same gameweek.
async function generateAutopsyIfNeeded(gw, stats) {
  const ref = db.doc(`autopsyReports/gw${gw}`);
  const existing = await ref.get();
  if (existing.exists) return;

  const { gwWinner, gwLoser, biggestBench, mostHits, mostCaptained, avgPoints } = stats;
  const facts = [
    gwWinner ? `Winner: ${gwWinner.teamName} (${gwWinner.managerName}) with ${gwWinner.gwPoints} points` : null,
    gwLoser ? `Bottom of the table this week: ${gwLoser.teamName} (${gwLoser.managerName}) with ${gwLoser.gwPoints} points` : null,
    `League average score: ${Math.round(avgPoints * 10) / 10}`,
    biggestBench && biggestBench.benchPoints > 0
      ? `Most points wasted on the bench: ${biggestBench.teamName} left ${biggestBench.benchPoints} points unused`
      : null,
    mostHits && mostHits.transferCost > 0
      ? `Biggest gambler: ${mostHits.teamName} took a ${mostHits.transferCost}-point hit on transfers`
      : null,
    mostCaptained ? `Most popular captain pick: ${mostCaptained[0]}, chosen by ${mostCaptained[1]} managers` : null,
  ].filter(Boolean);

  const prompt = `You are a witty sports journalist covering "K&A Paid FPL", a 35-person office Fantasy Premier League mini-league. Write a short, punchy Gameweek ${gw} recap — 3 short paragraphs, casual and funny, like a proper post-match column, referencing the real names and numbers given below. Don't invent any facts beyond what's listed. Plain text only, no markdown formatting, no headers.

Facts:
- ${facts.join("\n- ")}`;

  const text = await callOpenRouter(prompt, 500);
  if (!text) {
    console.log(`Autopsy GW${gw}: skipped — no AI response (check OPENROUTER_API_KEY is set correctly)`);
    return;
  }
  await ref.set({
    text,
    gw,
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`Autopsy generated for GW${gw} (${text.length} chars)`);
}

// Manager DNA — classifies each manager's season-long playing style from
// their actual decisions. Scores 5 traits (0-100 each) and picks the
// dominant archetype. Needs at least 3 gameweeks of data to be meaningful.
async function computeManagerDNA(managerHistoryMap, currentGw) {
  if (currentGw < 3) return;
  const writes = [];
  for (const [entryId, m] of Object.entries(managerHistoryMap)) {
    const history = m.fullHistory.filter(h => h.gw <= currentGw);
    if (history.length < 2) continue;
    const gwCount = history.length;
    const totalHits = history.reduce((s,h) => s+(h.transferCost||0), 0);
    const gamblerScore = Math.min(100, Math.round(totalHits / gwCount * 12.5));
    const totalTransfers = history.reduce((s,h) => s+(h.transfers||0), 0);
    const templateScore = Math.max(0, 100 - Math.round((totalTransfers/gwCount)*25));
    const scores = history.map(h=>h.points||0);
    const mean = scores.reduce((s,v)=>s+v,0)/scores.length;
    const variance = scores.reduce((s,v)=>s+Math.pow(v-mean,2),0)/scores.length;
    const consistencyScore = Math.max(0, 100 - Math.round(Math.sqrt(variance)*2.5));
    const rankImprovements = history.filter((h,i)=>i>0&&h.rank<history[i-1].rank).length;
    const clutchScore = Math.round((rankImprovements/Math.max(gwCount-1,1))*100);
    const peakScore = Math.max(...scores);
    const differentialScore = Math.min(100, Math.round((peakScore/100)*50 + (totalTransfers/gwCount)*10));
    const traits = { gambler: gamblerScore, template: templateScore, consistent: consistencyScore, clutch: clutchScore, differential: differentialScore };
    const topTrait = Object.entries(traits).sort((a,b)=>b[1]-a[1])[0][0];
    const ARCHETYPES = { gambler:"🎲 Gambler", template:"📋 Set & Forget", consistent:"🪨 Steady Eddie", clutch:"⚡ Clutch Player", differential:"🦄 Contrarian" };
    writes.push(db.doc(`managerDNA/${entryId}`).set({
      entryId: parseInt(entryId),
      teamName: m.entry_name,
      archetype: ARCHETYPES[topTrait],
      traits,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
  }
  if (writes.length > 0) {
    await Promise.all(writes);
    console.log(`Manager DNA computed for ${writes.length} managers`);
  }
}

// FPL IQ — a composite decision-quality score based on season-long behaviour.
// Four pillars: hit control (avoiding costly transfers), consistency,
// bench management (not wasting points on unused subs), and relative
// performance (beating the field). Shows from GW1 — early scores will be
// noisy with little data, but that's fine, it settles as the season builds.
async function computeFplIQ(managerHistoryMap, currentGw) {
  const allScores = Object.values(managerHistoryMap)
    .map(m => m.fullHistory.filter(h => h.gw <= currentGw).map(h => h.points||0))
    .flat();
  const leagueAvg = allScores.length > 0 ? allScores.reduce((s,v)=>s+v,0)/allScores.length : 40;
  const writes = [];
  for (const [entryId, m] of Object.entries(managerHistoryMap)) {
    const history = m.fullHistory.filter(h => h.gw <= currentGw);
    if (history.length < 1) continue;
    const gwCount = history.length;
    const scores = history.map(h=>h.points||0);
    const mean = scores.reduce((s,v)=>s+v,0)/gwCount;
    // Hit Control: every 4 pts spent on hits = -1 IQ point. Cap at 100.
    const totalHits = history.reduce((s,h)=>s+(h.transferCost||0),0);
    const hitIQ = Math.max(0, 100 - Math.round(totalHits * 2.5));
    // Consistency: inverse of normalised standard deviation
    const variance = scores.reduce((s,v)=>s+Math.pow(v-mean,2),0)/gwCount;
    const consistencyIQ = Math.max(0, 100 - Math.round(Math.sqrt(variance)*2));
    // Bench Management: lower bench waste is better
    const totalBench = history.reduce((s,h)=>s+(h.benchPoints||0),0);
    const benchIQ = Math.max(0, 100 - Math.round((totalBench/gwCount)*2));
    // Relative Performance: % of weeks above league average
    const aboveAvg = scores.filter(s=>s>leagueAvg).length;
    const relativeIQ = Math.round((aboveAvg/gwCount)*100);
    const iq = Math.round(hitIQ*0.30 + consistencyIQ*0.25 + benchIQ*0.25 + relativeIQ*0.20);
    const label = iq>=85?"🧠 Elite":iq>=70?"🎓 Sharp":iq>=55?"📚 Learning":iq>=40?"🤔 Questionable":"💀 What Are You Doing";
    writes.push(db.doc(`fplIQ/${entryId}`).set({
      entryId: parseInt(entryId),
      teamName: m.entry_name,
      iq,
      label,
      breakdown: { hitIQ, consistencyIQ, benchIQ, relativeIQ },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
  }
  if (writes.length > 0) {
    await Promise.all(writes);
    console.log(`FPL IQ computed for ${writes.length} managers`);
  }
}

// The One That Got Away — every player transferred out lives on in
// this doc, accumulating points they scored in every subsequent GW.
// Incrementally updated each sync so we never need to re-read past GWs.
async function computeGotAway(managerHistoryMap, gwTransfersRollup, livePointsByElement, playersMeta, gw) {
  const reads = Object.keys(managerHistoryMap).map(id => db.doc(`gotAway/${id}`).get());
  const snaps = await Promise.all(reads);
  const writes = [];
  snaps.forEach((snap, i) => {
    const entryId = parseInt(Object.keys(managerHistoryMap)[i]);
    const m = Object.values(managerHistoryMap)[i];
    const existing = snap.exists ? snap.data() : { players: [] };
    // Update existing tracked players with this GW's points
    let players = (existing.players || []).map(p => ({
      ...p,
      pointsSince: (p.pointsSince||0) + (livePointsByElement[p.elementId]||0),
      lastGw: gw,
    }));
    // Add newly transferred-out players from this GW
    const transfers = gwTransfersRollup[entryId];
    if (transfers?.transfersOut) {
      const trackedIds = new Set(players.map(p=>p.elementId));
      transfers.transfersOut.forEach(elementId => {
        if (!trackedIds.has(elementId)) {
          const p = playersMeta[elementId];
          players.push({ elementId, name: p?.n||"Unknown", soldGw: gw, pointsSince: 0, lastGw: gw });
        }
      });
    }
    // Keep top 8 by regret (most points since sold) to avoid unbounded growth
    players.sort((a,b)=>b.pointsSince-a.pointsSince);
    if (players.length > 8) players = players.slice(0,8);
    writes.push(db.doc(`gotAway/${entryId}`).set({
      entryId,
      teamName: m.entry_name,
      players,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
  });
  if (writes.length > 0) {
    await Promise.all(writes);
    console.log(`Got Away updated for ${writes.length} managers`);
  }
}

// FPL Court — AI-generated weekly tribunal once bonus points confirm.
// Finds the most dramatic "crime" of the week, then generates prosecution
// and defence arguments. Only runs once per finalized GW.
// Checks whether TODAY's fixtures (in NPT) for this gameweek have all
// finished, and whether we've already generated content reflecting today's
// results — used by Press Conference and FPL Court so they update once per
// matchday as the week unfolds (Saturday night, then Sunday night, etc)
// instead of once per whole gameweek, while never wasting a call on a day
// with no fixtures at all.
function todayNPTServer() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(new Date());
}
function sameNPTDateServer(isoString, dateStr) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(new Date(isoString)) === dateStr;
}
async function checkTodaysFixturesReady(gw) {
  const snap = await db.doc(`gameweekFixtures/gw${gw}`).get();
  if (!snap.exists) return { ready: false, today: null };
  const fixtures = snap.data().fixtures || [];
  const today = todayNPTServer();
  const todaysFixtures = fixtures.filter((f) => sameNPTDateServer(f.kickoff, today));
  if (todaysFixtures.length === 0) return { ready: false, today }; // nothing scheduled today — don't spend a call
  const allDone = todaysFixtures.every((f) => f.finished);
  return { ready: allDone, today };
}

// A second, independent path to "is this gameweek safely done" for the
// whole-GW AI recap (the Autopsy) — doesn't wait for FPL's own
// data_checked flag, which can lag matches actually finishing by anywhere
// from a few hours to a couple of days. Instead: every fixture in the GW
// must show finished_provisional (a real result exists), AND enough
// wall-clock time must have passed since the LAST kickoff for bonus
// points to have realistically settled — matches run ~2.5h including
// stoppage time, plus a comfortable buffer on top of that. Whichever of
// this or the official isFinal flag comes true first is what triggers
// generation; mwWinners (real prize money) intentionally does NOT use
// this and stays on the strict official flag only.
async function checkGwSafelyDoneForAI(gw) {
  const snap = await db.doc(`gameweekFixtures/gw${gw}`).get();
  if (!snap.exists) return false;
  const fixtures = snap.data().fixtures || [];
  if (fixtures.length === 0) return false;
  const allFinished = fixtures.every((f) => f.finished);
  if (!allFinished) return false;
  const lastKickoff = Math.max(...fixtures.map((f) => new Date(f.kickoff).getTime()));
  const MATCH_DURATION_MS = 2.5 * 60 * 60 * 1000; // ~2.5h covers 90 min + stoppage/halftime
  const BONUS_BUFFER_MS = 4.5 * 60 * 60 * 1000;   // buffer for bonus points to realistically settle
  return Date.now() >= lastKickoff + MATCH_DURATION_MS + BONUS_BUFFER_MS;
}

async function generateFplCourtIfNeeded(gw, gwResults, gwSquadsRollup, livePointsByElement, avgPoints, playersMeta) {
  if (gw < 10) return;
  const ref = db.doc(`fplCourt/gw${gw}`);
  const existing = await ref.get();
  const existingData = existing.exists ? existing.data() : null;
  const { ready, today } = await checkTodaysFixturesReady(gw);
  if (!ready) return; // no fixtures today, or today's matches aren't finished yet
  if (existingData?.lastGeneratedForDate === today) return; // already reflects today's results
  // Find the defendant: manager with highest bench points (biggest waste)
  // — the most visually dramatic FPL crime, every single week
  const defendant = [...gwResults].sort((a,b)=>b.benchPoints-a.benchPoints)[0];
  if (!defendant || defendant.benchPoints < 4) return;
  const squad = gwSquadsRollup[defendant.entryId];
  const bestBench = squad?.bench
    ?.map(id=>({ id, pts: livePointsByElement[id]||0 }))
    ?.sort((a,b)=>b.pts-a.pts)?.[0];
  const facts = [
    `Defendant: ${defendant.teamName} (managed by ${defendant.managerName})`,
    `Crime: Left ${defendant.benchPoints} points on the bench unused this gameweek`,
    bestBench ? `Key exhibit: ${playersMeta[bestBench.id]?.n||'Unknown'} scored ${bestBench.pts} points while watching from the bench` : null,
    `Their actual score so far: ${defendant.gwPoints} points (league average was ${Math.round(avgPoints)} pts)`,
    `The bench points, if played, would have put them ${defendant.benchPoints>0?'higher':'lower'} in the GW standings`,
  ].filter(Boolean);
  const prompt = `You are a judge at "FPL Court", a mock tribunal for the worst Fantasy Premier League decision of the week in an office mini-league called K&A Paid FPL.

The defendant is ${defendant.teamName}. Generate a short, punchy court case in two parts:
1. PROSECUTION (2-3 sentences): Make the case against them. Be dramatic and funny.
2. DEFENCE (2-3 sentences): Their best possible excuse. Be sympathetic but still funny.

Facts of the case:
${facts.map(f=>`- ${f}`).join('\n')}

Return ONLY a JSON object with keys "prosecution" and "defence". No markdown, no extra text.`;
  const text = await callOpenRouter(prompt, 400);
  if (!text) return;
  let parsed;
  try {
    const clean = text.replace(/```json|```/g,'').trim();
    parsed = JSON.parse(clean);
  } catch(e) {
    console.log(`FPL Court GW${gw}: AI returned non-JSON, skipping`);
    return;
  }
  await ref.set({
    gw,
    lastGeneratedForDate: today,
    defendant: { entryId: defendant.entryId, teamName: defendant.teamName, managerName: defendant.managerName, crime: `${defendant.benchPoints} bench points wasted` },
    prosecution: parsed.prosecution || "",
    defence: parsed.defence || "",
    verdict: null, // set by frontend voting
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`FPL Court case generated for GW${gw} — defendant: ${defendant.teamName}`);
}

// Lost Points Index — each GW, for each manager, finds bench players who
// outscored the weakest starter and accumulates the "lost" gap all season.
// Stored incrementally so each sync only needs current-GW data, not history.
async function computeLostPoints(gwResults, gwSquadsRollup, livePointsByElement, gw) {
  const writes = [];
  for (const r of gwResults) {
    const squad = gwSquadsRollup[r.entryId];
    if (!squad) continue;
    const startingPts = squad.starting.map(id => livePointsByElement[id] || 0);
    const benchPts = squad.bench.map(id => livePointsByElement[id] || 0);
    const worstStarter = Math.min(...startingPts);
    const lostThisGw = benchPts.reduce((sum, bPts) => {
      return bPts > worstStarter ? sum + (bPts - worstStarter) : sum;
    }, 0);
    if (lostThisGw === 0) continue;
    // Increment the running total — merge:true means we add to whatever's there
    writes.push(
      db.doc(`lostPoints/${r.entryId}`).set({
        entryId: r.entryId,
        teamName: r.teamName,
        totalLost: admin.firestore.FieldValue.increment(lostThisGw),
        lastGw: gw,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true })
    );
  }
  if (writes.length > 0) {
    await Promise.all(writes);
    console.log(`Lost Points updated for ${writes.length} managers (GW${gw})`);
  }
}

// Press Conference — AI-generated post-match interview for the GW winner
// and loser, styled like a real football press conference. Updates once per
// matchday as fixtures finish (Saturday night, Sunday night, etc), skipping
// any day with no fixtures scheduled. Unlocks at GW7.
async function generatePressConferenceIfNeeded(gw, gwResults, avgPoints) {
  if (gw < 7) return;
  const ref = db.doc(`pressConference/gw${gw}`);
  const existing = await ref.get();
  const existingData = existing.exists ? existing.data() : null;
  const { ready, today } = await checkTodaysFixturesReady(gw);
  if (!ready) return;
  if (existingData?.lastGeneratedForDate === today) return;
  const byPoints = [...gwResults].sort((a, b) => b.gwPoints - a.gwPoints);
  const winner = byPoints[0];
  const loser = byPoints[byPoints.length - 1];
  if (!winner || !loser) return;
  const prompt = `You are a fictional sports journalist covering "K&A Paid FPL", a 35-person office Fantasy Premier League mini-league. Write a funny, punchy post-match press conference for Gameweek ${gw}, based on results so far this gameweek.

Include TWO separate interview segments:
1. The winner so far — ${winner.teamName} (${winner.managerName}) scored ${winner.gwPoints} points
2. The loser so far — ${loser.teamName} (${loser.managerName}) scored ${loser.gwPoints} points (league average was ${Math.round(avgPoints)})

Each segment: a journalist question, then the manager's answer (2-3 sentences). Keep it funny, like real football managers but in an FPL context. Plain text only, no markdown.

Return ONLY a JSON object: { "winner": { "question": "...", "answer": "..." }, "loser": { "question": "...", "answer": "..." } }`;
  const text = await callOpenRouter(prompt, 450);
  if (!text) return;
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.log(`Press Conference GW${gw}: AI returned non-JSON, skipping`);
    return;
  }
  await ref.set({
    gw,
    lastGeneratedForDate: today,
    winner: { entryId: winner.entryId, teamName: winner.teamName, points: winner.gwPoints, ...parsed.winner },
    loser: { entryId: loser.entryId, teamName: loser.teamName, points: loser.gwPoints, ...parsed.loser },
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`Press Conference generated for GW${gw}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
