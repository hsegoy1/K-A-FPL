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
// Free-tier OpenRouter models share a pooled rate limit across everyone
// using that specific model, so a busy period can 429 even with a valid
// key — this isn't something a retry of the SAME model reliably fixes.
// Instead, try each of these in order and use whichever responds first.
const OPENROUTER_MODEL_CHAIN = [
  "poolside/laguna-s-2.1:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "openai/gpt-oss-20b:free",
];
async function callOpenRouter(prompt, maxTokens = 600) {
  if (!OPENROUTER_API_KEY) {
    console.log("⚠️  OPENROUTER_API_KEY not set — skipping AI generation for this feature");
    return null;
  }
  for (const model of OPENROUTER_MODEL_CHAIN) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
        }),
      });
      if (!res.ok) {
        console.log(`⚠️  OpenRouter (${model}) failed (${res.status}) — trying next model in the chain`);
        continue;
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text) return text;
      console.log(`⚠️  OpenRouter (${model}) returned no content — trying next model in the chain`);
    } catch (err) {
      console.log(`⚠️  OpenRouter (${model}) errored: ${err.message} — trying next model in the chain`);
    }
  }
  console.log("⚠️  All OpenRouter models in the chain failed this run — will retry on the next sync");
  return null;
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
  // Backfill — the fetch above only ever asks FPL for whichever gameweek
  // was CURRENT at sync time. Once a gameweek stops being current, nothing
  // ever asks again — if that one attempt happened to land before FPL had
  // finished confirming that week's official Dream Team (late Monday
  // night, while bonus points are still settling, is a real case), the
  // page is permanently stuck showing "not synced yet" for that gameweek,
  // even though the data has been sitting there finished for weeks. This
  // gives every past finished gameweek without a stored Dream Team one
  // more attempt, every sync, until it succeeds — self-healing, and cheap
  // (one Firestore read per finished gw; a real FPL fetch only happens for
  // the ones still actually missing, which is normally zero).
  for (const e of events) {
    if (!e.finished || e.id === gw) continue;
    const existing = await db.doc(`dreamTeam/gw${e.id}`).get();
    if (existing.exists) continue;
    try {
      const dt = await getJson(`${FPL_BASE}/dream-team/${e.id}/`);
      if (dt?.top_players?.length) {
        await db.doc(`dreamTeam/gw${e.id}`).set({
          gw: e.id,
          players: dt.top_players,
          formation: dt.formation || null,
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`Dream Team GW${e.id} backfilled (${dt.top_players.length} players)`);
      }
    } catch (err) {
      console.log(`Dream Team GW${e.id} backfill fetch failed: ${err.message}`);
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
  const gwSquadFullByEntry = {}; // entryId -> {starting(with pts), bench(with pts), captain, chip, transfersIn, transfersOut} for THIS gw — feeds Manager DNA / FPL IQ deep-dive without re-reading history
  const ownershipCount = {}; // playerId -> how many managers in the league currently own them — declared here (not inside the Ghost Teams block below) so Manager DNA's real Bandwagon/Differential traits can read it too

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
      // Full detail (points + transfers included, not just element ids) —
      // Manager DNA / FPL IQ's deep-dive metrics need the actual scores to
      // compute captain conviction, bench waste and transfer ROI without a
      // second round of Firestore reads.
      gwSquadFullByEntry[entryId] = { starting, bench, captain: effectiveCaptainId, chip, transfersIn, transfersOut };
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

  // Deep-decision accumulators — each one is a small, self-contained
  // running total guarded by isFinal + processedGws (same accumulation-
  // safety pattern as everywhere else in this file). These run BEFORE
  // Manager DNA / FPL IQ so those two can just read the accumulated totals
  // back out, instead of re-deriving them (and re-reading season-long
  // squad history) on every single sync.
  await computeLostPoints(gwResults, gwSquadsRollup, livePointsByElement, gw, isFinal);
  await computeActualVsPerfect(gwResults, gwSquadsRollup, livePointsByElement, gw, isFinal, players);
  await computeTransferROI(gwSquadFullByEntry, livePointsByElement, gw, isFinal, players);
  await computeChipPerformance(gwSquadFullByEntry, gwResults, avgPoints, gw, isFinal);
  await computeOwnershipHistory(gwSquadFullByEntry, ownershipCount, managers.length, gw);
  await computeLuckIndex(gwSquadFullByEntry, gwResults, players, gw, isFinal);

  // Manager DNA / FPL IQ — classify playing style and score decision quality
  // from the real signals accumulated above (captain calls, transfer ROI,
  // bench waste, chip timing) plus real league-wide ownership, not proxies.
  const deepStats = await loadDeepStats(Object.keys(managerHistoryMap));
  await computeManagerDNA(managerHistoryMap, gw, deepStats);
  await computeFplIQ(managerHistoryMap, gw, deepStats);
  await computeGotAway(managerHistoryMap, gwTransfersRollup, livePointsByElement, playersMeta, gw, isFinal);
  await computeDeathPlayer(gwSquadsRollup, managers, livePointsByElement, gw);
  await computeAchievements(gwResults, gwSquadsRollup, livePointsByElement, managerHistoryMap, gw, isFinal);
  await computeRecordBook(gwResults, gw, isFinal);
  await computeManagerEvolutionSnapshot(managerHistoryMap, gw);
  await computeTransferHallOfShame(gwTransfersRollup, livePointsByElement, gw, isFinal);

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
  // These check matchday readiness internally (see findLatestReadyMatchday),
  // so they're called every sync regardless of whole-GW isFinal status —
  // they update themselves once each matchday's games actually finish, not
  // just once at the very end of the gameweek (and not blocked by one
  // rearranged fixture still pending later in the week).
  await generateFplCourtIfNeeded(gw, gwResults, gwSquadsRollup, livePointsByElement, avgPoints, playersMeta);
  await generatePressConferenceIfNeeded(gw, gwResults, avgPoints);
  await generateMicroBanterIfNeeded(gw, gwResults, gwSquadsRollup, livePointsByElement, playersMeta);

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

// Actual vs Perfect's own accumulator, Lost Points' own accumulator, and
// the two new accumulators below (Transfer ROI, Chip Performance) are the
// four "raw decision signal" collections. Manager DNA and FPL IQ are both
// just different lenses on the SAME four signals — this reads all four for
// every manager in one batched round of gets, so neither of those two
// functions has to duplicate the reads.
async function loadDeepStats(entryIds) {
  async function readAll(collection) {
    const snaps = await Promise.all(entryIds.map((id) => db.doc(`${collection}/${id}`).get()));
    const m = {};
    snaps.forEach((s, i) => { if (s.exists) m[entryIds[i]] = s.data(); });
    return m;
  }
  const [lostPointsMap, actualVsPerfectMap, transferROIMap, chipMap, ownershipMap, luckMap] = await Promise.all([
    readAll("lostPoints"),
    readAll("actualVsPerfect"),
    readAll("transferROI"),
    readAll("chipPerformance"),
    readAll("ownershipHistory"),
    readAll("luckIndex"),
  ]);
  return { lostPointsMap, actualVsPerfectMap, transferROIMap, chipMap, ownershipMap, luckMap };
}

// Ownership History — season-long running average of how "template" or
// "differential" a squad has been, instead of a single current-week
// snapshot. A snapshot is noisy: transfer in 3 differentials the day
// before a sync and you'd look like a maverick even if the rest of the
// season was pure template. Guarded by processedGws only, NOT isFinal —
// squad composition locks the moment the gameweek deadline passes, well
// before bonus points (and therefore isFinal) are confirmed, so there's no
// reason to wait for that.
async function computeOwnershipHistory(gwSquadFullByEntry, ownershipCount, totalManagers, gw) {
  if (!gw || totalManagers === 0) return;
  const writes = [];
  for (const [entryId, squad] of Object.entries(gwSquadFullByEntry)) {
    const ref = db.doc(`ownershipHistory/${entryId}`);
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : { templateSum: 0, diffSum: 0, gwCount: 0, processedGws: [] };
    if ((existing.processedGws || []).includes(gw)) continue;
    const myIds = [...squad.starting.map((p) => p.element), ...squad.bench.map((p) => p.element)];
    if (myIds.length === 0) continue;
    const ownershipPct = myIds.map((id) => ((ownershipCount[id]||0) / totalManagers) * 100);
    const templateThisGw = ownershipPct.reduce((s,v)=>s+v,0) / myIds.length;
    const diffThreshold = Math.max(1, Math.round(totalManagers * 0.15));
    const diffThisGw = (myIds.filter((id) => (ownershipCount[id]||0) <= diffThreshold).length / myIds.length) * 100;
    writes.push(ref.set({
      entryId: parseInt(entryId),
      templateSum: (existing.templateSum||0) + templateThisGw,
      diffSum: (existing.diffSum||0) + diffThisGw,
      gwCount: (existing.gwCount||0) + 1,
      processedGws: [...(existing.processedGws||[]), gw],
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
  }
  if (writes.length > 0) {
    await Promise.all(writes);
    console.log(`Ownership history updated for ${writes.length} managers (GW${gw})`);
  }
}

// Luck Index — separates process from outcome. "Expected" points for your
// starting XI this GW = sum of each player's season-to-date points-per-game
// (FPL's own `points_per_game` field, already free in bootstrap data) ×
// their multiplier. Comparing that to what you ACTUALLY scored shows
// whether a result came from genuine overperformance (a haul above a
// player's normal level) or just from owning strong players who were
// always going to score well. Caveat kept honest: this uses full-season-
// to-date PPG, which includes this GW's own result in the average — a
// slight look-ahead bias that mutes the size of the gap a little. Good
// enough for a season-long "was I lucky or good" signal; not a strict
// pre-registered forecast. isFinal-gated + processedGws guarded like every
// other scored-outcome accumulator here.
async function computeLuckIndex(gwSquadFullByEntry, gwResults, players, gw, isFinal) {
  if (!isFinal) return;
  const writes = [];
  for (const [entryId, squad] of Object.entries(gwSquadFullByEntry)) {
    const r = gwResults.find((x) => String(x.entryId) === String(entryId));
    if (!r) continue;
    const ref = db.doc(`luckIndex/${entryId}`);
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : { totalActual: 0, totalExpected: 0, processedGws: [] };
    if ((existing.processedGws || []).includes(gw)) continue;
    const expected = squad.starting.reduce((s, p) => {
      const ppg = parseFloat(players.get(p.element)?.points_per_game) || 0;
      return s + ppg * (p.multiplier||1);
    }, 0);
    writes.push(ref.set({
      entryId: parseInt(entryId),
      teamName: r.teamName,
      totalActual: (existing.totalActual||0) + r.gwPoints,
      totalExpected: Math.round(((existing.totalExpected||0) + expected)*10)/10,
      processedGws: [...(existing.processedGws||[]), gw],
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
  }
  if (writes.length > 0) {
    await Promise.all(writes);
    console.log(`Luck Index updated for ${writes.length} managers (GW${gw})`);
  }
}

// Transfer ROI — for every transfer, did the player bought outscore the
// player sold in that same gameweek? This is the exact same "delta" used by
// Transfer Hall of Shame, but accumulated PER MANAGER (not just the
// league-wide worst 10), plus that manager's own best/worst individual swap
// kept as evidence. isFinal + processedGws guarded — same
// accumulation-safety pattern as Lost Points / Actual vs Perfect (see
// handoff doc section 7a — this is exactly the bug class that pattern
// exists to prevent).
async function computeTransferROI(gwSquadFullByEntry, livePointsByElement, gw, isFinal, players) {
  if (!isFinal) return;
  const writes = [];
  for (const [entryId, squad] of Object.entries(gwSquadFullByEntry)) {
    if (!squad.transfersIn || squad.transfersIn.length === 0) continue;
    const ref = db.doc(`transferROI/${entryId}`);
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : { totalROI: 0, totalTransfers: 0, processedGws: [], bestSwap: null, worstSwap: null };
    if ((existing.processedGws || []).includes(gw)) continue;
    let gwROI = 0;
    let bestSwap = existing.bestSwap, worstSwap = existing.worstSwap;
    squad.transfersIn.forEach((inT, i) => {
      const outT = squad.transfersOut[i];
      if (!outT) return;
      const inPts = livePointsByElement[inT.element] || 0;
      const outPts = livePointsByElement[outT.element] || 0;
      const delta = inPts - outPts;
      gwROI += delta;
      const evidence = { gw, inName: players.get(inT.element)?.web_name || "?", outName: players.get(outT.element)?.web_name || "?", inPts, outPts, delta };
      if (!bestSwap || delta > bestSwap.delta) bestSwap = evidence;
      if (!worstSwap || delta < worstSwap.delta) worstSwap = evidence;
    });
    writes.push(ref.set({
      entryId: parseInt(entryId),
      teamName: squad.teamName || null,
      totalROI: (existing.totalROI||0) + gwROI,
      totalTransfers: (existing.totalTransfers||0) + squad.transfersIn.length,
      processedGws: [...(existing.processedGws||[]), gw],
      bestSwap, worstSwap,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
  }
  if (writes.length > 0) {
    await Promise.all(writes);
    console.log(`Transfer ROI updated for ${writes.length} managers (GW${gw})`);
  }
}

// Chip Performance — how did each chip do relative to the league average in
// the exact week it was played? A Triple Captain in a week where everyone
// scores big is unremarkable; one in a quiet week where you still hit 100
// is elite. Own processedGws guard (chips are rare — a handful a season —
// so this is a small append-only array, never re-summed).
async function computeChipPerformance(gwSquadFullByEntry, gwResults, avgPoints, gw, isFinal) {
  if (!isFinal) return;
  const sortedScores = [...gwResults].sort((a,b)=>b.gwPoints-a.gwPoints);
  const writes = [];
  for (const [entryId, squad] of Object.entries(gwSquadFullByEntry)) {
    if (!squad.chip) continue;
    const r = gwResults.find((x) => String(x.entryId) === String(entryId));
    if (!r) continue;
    const ref = db.doc(`chipPerformance/${entryId}`);
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : { chips: [], processedGws: [] };
    if ((existing.processedGws || []).includes(gw)) continue;
    const rankThisGw = sortedScores.findIndex((x) => x.entryId === r.entryId) + 1;
    const percentile = Math.round((1 - (rankThisGw-1)/Math.max(sortedScores.length-1,1)) * 100);
    const entry = { chip: squad.chip, gw, points: r.gwPoints, vsAvg: Math.round((r.gwPoints - avgPoints)*10)/10, percentile };
    writes.push(ref.set({
      entryId: parseInt(entryId),
      teamName: r.teamName,
      chips: [...(existing.chips||[]), entry],
      processedGws: [...(existing.processedGws||[]), gw],
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
  }
  if (writes.length > 0) {
    await Promise.all(writes);
    console.log(`Chip performance recorded for ${writes.length} managers (GW${gw})`);
  }
}

// Compound archetypes — the top-2 traits combine into a distinct label
// instead of collapsing to a single dominant trait, which discarded most of
// the texture (two very different managers could land on the same label).
// Falls back to a solo specialist label only when one trait clearly
// dominates (25+ point gap over the second) — a genuine specialist
// shouldn't get a hybrid name just because their #2 trait is a rounding
// error above #3.
const SOLO_ARCHETYPES = { gambler:"🎲 Gambler", template:"📋 Set & Forget", consistent:"🪨 Steady Eddie", clutch:"⚡ Clutch Player", differential:"🦄 Contrarian" };
const PAIR_ARCHETYPES = {
  "gambler|template": "🎰 Reckless Copycat",
  "consistent|gambler": "🎯 Calculated Risk-Taker",
  "clutch|gambler": "🔥 Boom or Bust",
  "differential|gambler": "🎰 Wild Maverick",
  "consistent|template": "📐 The Spreadsheet",
  "clutch|template": "🐑 Smart Sheep",
  "differential|template": "🧩 Balanced Hybrid",
  "clutch|consistent": "🪨 Silent Assassin",
  "consistent|differential": "🔬 Quiet Genius",
  "clutch|differential": "🦄 Momentum Maverick",
};
function archetypeFor(traits) {
  const sorted = Object.entries(traits).sort((a,b)=>b[1]-a[1]);
  const [t1,v1] = sorted[0], [t2,v2] = sorted[1];
  if (v1 - v2 >= 25) return SOLO_ARCHETYPES[t1];
  const key = [t1,t2].sort().join("|");
  return PAIR_ARCHETYPES[key] || SOLO_ARCHETYPES[t1];
}

// Manager DNA — classifies each manager's season-long playing style from
// their actual decisions. Template/Differential now read the season-long
// running average from Ownership History (not a single current-week
// snapshot), and the archetype is a compound of the top-2 traits (see
// above) rather than one dominant trait swallowing all the texture. Layers
// on a "deep dive" built from the accumulators: boom/bust range, captain
// conviction, transfer ROI, chip timing, and Luck Index (actual vs
// expected points, so a hot run reads as "lucky" or "process" correctly).
// A `confidence` field (1-5) is attached so a 3-gameweek read doesn't look
// as authoritative as a 25-gameweek one on the frontend. Needs at least 3
// gameweeks of data to be meaningful.
async function computeManagerDNA(managerHistoryMap, currentGw, deepStats) {
  if (currentGw < 3) return;
  const raw = [];
  for (const [entryId, m] of Object.entries(managerHistoryMap)) {
    const history = m.fullHistory.filter(h => h.gw <= currentGw);
    if (history.length < 2) continue;
    const gwCount = history.length;
    const totalHits = history.reduce((s,h) => s+(h.transferCost||0), 0);
    const gamblerScore = Math.min(100, Math.round(totalHits / gwCount * 12.5));
    const scores = history.map(h=>h.points||0);
    const mean = scores.reduce((s,v)=>s+v,0)/scores.length;
    const variance = scores.reduce((s,v)=>s+Math.pow(v-mean,2),0)/scores.length;
    const consistencyScore = Math.max(0, 100 - Math.round(Math.sqrt(variance)*2.5));
    const rankImprovements = history.filter((h,i)=>i>0&&h.rank<history[i-1].rank).length;
    const clutchScore = Math.round((rankImprovements/Math.max(gwCount-1,1))*100);

    // Template & Differential — season-long average from Ownership History,
    // not a single-week snapshot that could be thrown off by a transfer
    // made the day before this sync ran.
    const own = deepStats.ownershipMap[entryId];
    const templateScore = own && own.gwCount > 0 ? Math.round(own.templateSum/own.gwCount) : 0;
    const differentialScore = own && own.gwCount > 0 ? Math.round(own.diffSum/own.gwCount) : 0;

    const traits = { gambler: gamblerScore, template: templateScore, consistent: consistencyScore, clutch: clutchScore, differential: differentialScore };
    const archetype = archetypeFor(traits);

    const avp = deepStats.actualVsPerfectMap[entryId];
    const troi = deepStats.transferROIMap[entryId];
    const chips = deepStats.chipMap[entryId];
    const luck = deepStats.luckMap[entryId];
    const bestGw = Math.max(...scores), worstGw = Math.min(...scores);
    const avpGwCount = avp ? (avp.processedGws||[]).length : 0;
    const luckGwCount = luck ? (luck.processedGws||[]).length : 0;

    raw.push({
      entryId, teamName: m.entry_name, traits, archetype,
      confidence: Math.min(5, Math.max(1, Math.round(gwCount/4))),
      boomBust: { ratio: worstGw > 0 ? Math.round((bestGw/worstGw)*10)/10 : bestGw, bestGw, worstGw },
      captainConviction: avp && avpGwCount > 0 ? { hitRate: Math.round((avp.perfectCount/avpGwCount)*100), bestCall: avp.bestCall||null, worstCall: avp.worstCall||null } : null,
      transferROI: troi && troi.totalTransfers > 0 ? { avgROI: Math.round((troi.totalROI/troi.totalTransfers)*10)/10, totalTransfers: troi.totalTransfers, bestSwap: troi.bestSwap||null, worstSwap: troi.worstSwap||null } : null,
      chips: chips ? chips.chips : [],
      luckIndex: luck && luckGwCount > 0 ? { total: Math.round((luck.totalActual-luck.totalExpected)*10)/10, perGw: Math.round(((luck.totalActual-luck.totalExpected)/luckGwCount)*10)/10 } : null,
    });
  }

  // Rank Transfer ROI and Luck Index across the league so the frontend can
  // show "top 20%" rather than just a bare average.
  const roiVals = raw.filter(x=>x.transferROI).map(x=>x.transferROI.avgROI).sort((a,b)=>a-b);
  const luckVals = raw.filter(x=>x.luckIndex).map(x=>x.luckIndex.total).sort((a,b)=>a-b);
  const percentileOf = (val, sorted) => sorted.length<2 ? 50 : Math.round((sorted.filter(v=>v<val).length/(sorted.length-1))*100);

  const writes = raw.map((x) => db.doc(`managerDNA/${x.entryId}`).set({
    entryId: parseInt(x.entryId),
    teamName: x.teamName,
    archetype: x.archetype,
    traits: x.traits,
    confidence: x.confidence,
    deepDive: {
      boomBust: x.boomBust,
      captainConviction: x.captainConviction,
      transferROI: x.transferROI ? { ...x.transferROI, percentile: percentileOf(x.transferROI.avgROI, roiVals) } : null,
      chips: x.chips,
      luckIndex: x.luckIndex ? { ...x.luckIndex, percentile: percentileOf(x.luckIndex.total, luckVals) } : null,
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }));
  if (writes.length > 0) {
    await Promise.all(writes);
    console.log(`Manager DNA computed for ${writes.length} managers`);
  }
}

// FPL IQ — a composite decision-quality score, rebuilt to be self-
// calibrating instead of running on hand-picked scoring constants:
//
//  1. Every raw metric (captain gap, bench waste, transfer ROI, chip
//     percentile) is first pulled toward the LEAGUE'S OWN average via
//     Bayesian shrinkage, weighted by how much data backs it — a manager
//     with 2 gameweeks of captain data doesn't get to look "Elite" off one
//     lucky pick; they sit close to the league average until more evidence
//     accumulates. The shrinkage constant (k) is the number of "pretend
//     average gameweeks/transfers/chips" blended in before trusting the
//     observed value.
//  2. Consistency is measured as the spread of your WEEKLY Z-SCORE against
//     that week's league mean (using mean absolute deviation, a robust
//     spread measure), not your own raw score variance — so a blank
//     gameweek for the entire league doesn't read as personal
//     inconsistency, and a single monster haul doesn't distort the read.
//  3. Every shrunk raw metric is then PERCENTILE-RANKED against the field —
//     this is what makes the whole system self-calibrating. It doesn't
//     matter whether this league's average bench waste is 2 pts/gw or 8;
//     sitting in the top 10% always maps to a high score.
//  4. The 5 pillar weights are no longer a fixed guess — they're blended
//     50/50 between a sensible prior and each pillar's actual correlation
//     with season total points IN THIS LEAGUE, so the composite reflects
//     what's actually predictive here rather than what sounds reasonable.
// A `confidence` field (1-5, from total gameweeks played) is attached so a
// 3-gameweek read is visibly less certain than a 25-gameweek one.
async function computeFplIQ(managerHistoryMap, currentGw, deepStats) {
  const entries = Object.entries(managerHistoryMap);

  // League-wide priors for shrinkage — what a manager with zero decisions
  // counted yet should be assumed to look like.
  let sumGap=0, cntGapGw=0, sumBench=0, cntBenchGw=0, sumROI=0, cntROITransfers=0, sumChipPct=0, cntChips=0;
  entries.forEach(([entryId]) => {
    const avp = deepStats.actualVsPerfectMap[entryId]; if (avp) { sumGap += avp.totalGap; cntGapGw += (avp.processedGws||[]).length; }
    const lp = deepStats.lostPointsMap[entryId]; if (lp) { sumBench += lp.totalLost; cntBenchGw += (lp.processedGws||[]).length; }
    const troi = deepStats.transferROIMap[entryId]; if (troi) { sumROI += troi.totalROI; cntROITransfers += troi.totalTransfers; }
    const chips = deepStats.chipMap[entryId]; if (chips) chips.chips.forEach((c) => { sumChipPct += c.percentile; cntChips++; });
  });
  const priorGap = cntGapGw > 0 ? sumGap/cntGapGw : 2;
  const priorBench = cntBenchGw > 0 ? sumBench/cntBenchGw : 2;
  const priorROI = cntROITransfers > 0 ? sumROI/cntROITransfers : 0;
  const priorChipPct = cntChips > 0 ? sumChipPct/cntChips : 50;
  const K_GW = 4, K_TRANSFERS = 3, K_CHIPS = 2; // "pretend" sample sizes blended in before trusting the observed value

  // Per-GW league mean + robust spread (mean absolute deviation), used to
  // z-score each manager's week against the FIELD that week rather than
  // their own season average.
  const byGw = {};
  Object.values(managerHistoryMap).forEach((m) => m.fullHistory.forEach((h) => { if (h.gw <= currentGw) (byGw[h.gw] = byGw[h.gw]||[]).push(h.points||0); }));
  const gwStats = {};
  Object.entries(byGw).forEach(([gwKey, arr]) => {
    const gMean = arr.reduce((s,v)=>s+v,0)/arr.length;
    const mad = arr.reduce((s,v)=>s+Math.abs(v-gMean),0)/arr.length;
    gwStats[gwKey] = { mean: gMean, spread: Math.max(mad,1) };
  });

  const raw = [];
  for (const [entryId, m] of entries) {
    const history = m.fullHistory.filter(h => h.gw <= currentGw);
    if (history.length < 1) continue;

    const zScores = history.map((h) => { const gs = gwStats[h.gw]; return gs ? ((h.points||0)-gs.mean)/gs.spread : 0; });
    const zMean = zScores.reduce((s,v)=>s+v,0)/zScores.length;
    const zSpread = zScores.reduce((s,v)=>s+Math.abs(v-zMean),0)/zScores.length;

    const avp = deepStats.actualVsPerfectMap[entryId];
    const avpGws = avp ? (avp.processedGws||[]).length : 0;
    const avgGap = avpGws > 0 ? avp.totalGap/avpGws : priorGap;
    const shrunkGap = (avpGws*avgGap + K_GW*priorGap) / (avpGws+K_GW);

    const lp = deepStats.lostPointsMap[entryId];
    const lpGws = lp ? (lp.processedGws||[]).length : 0;
    const avgBench = lpGws > 0 ? lp.totalLost/lpGws : priorBench;
    const shrunkBench = (lpGws*avgBench + K_GW*priorBench) / (lpGws+K_GW);

    const troi = deepStats.transferROIMap[entryId];
    const tCount = troi ? troi.totalTransfers : 0;
    const avgROI = tCount > 0 ? troi.totalROI/tCount : priorROI;
    const shrunkROI = (tCount*avgROI + K_TRANSFERS*priorROI) / (tCount+K_TRANSFERS);

    const chips = deepStats.chipMap[entryId];
    const chipCount = chips ? chips.chips.length : 0;
    const avgChipPct = chipCount > 0 ? chips.chips.reduce((s,c)=>s+c.percentile,0)/chipCount : priorChipPct;
    const shrunkChip = (chipCount*avgChipPct + K_CHIPS*priorChipPct) / (chipCount+K_CHIPS);

    raw.push({
      entryId, teamName: m.entry_name, totalPoints: history[history.length-1]?.totalPoints || 0,
      rawVals: { captain: -shrunkGap, transfer: shrunkROI, bench: -shrunkBench, consistency: -zSpread, chip: shrunkChip },
      sampleSizes: { captainGws: avpGws, benchGws: lpGws, transfers: tCount, chips: chipCount, totalGws: history.length },
      evidence: { bestCaptain: avp?.bestCall||null, worstCaptain: avp?.worstCall||null, bestTransfer: troi?.bestSwap||null, worstTransfer: troi?.worstSwap||null },
    });
  }

  const PILLARS = ["captain","transfer","bench","consistency","chip"];
  const sortedVals = {}; PILLARS.forEach((p) => { sortedVals[p] = raw.map((x) => x.rawVals[p]).sort((a,b)=>a-b); });
  const percentileOf = (val, arr) => arr.length<2 ? 50 : Math.round((arr.filter((v) => v<val).length/(arr.length-1))*100);
  raw.forEach((x) => { x.pillarScores = {}; PILLARS.forEach((p) => { x.pillarScores[p] = percentileOf(x.rawVals[p], sortedVals[p]); }); });

  // Data-driven weighting: correlate each pillar's percentile score with
  // season total points across the league, blended 50/50 with a fixed
  // prior so a handful of gameweeks' worth of noisy correlation can't swing
  // the composite wildly early in the season.
  const PRIOR_WEIGHTS = { captain:0.25, transfer:0.25, bench:0.20, consistency:0.15, chip:0.15 };
  function pearson(xs, ys) {
    const n = xs.length; if (n < 3) return 0;
    const mx = xs.reduce((s,v)=>s+v,0)/n, my = ys.reduce((s,v)=>s+v,0)/n;
    const num = xs.reduce((s,v,i)=>s+(v-mx)*(ys[i]-my),0);
    const den = Math.sqrt(xs.reduce((s,v)=>s+(v-mx)**2,0) * ys.reduce((s,v)=>s+(v-my)**2,0));
    return den>0 ? num/den : 0;
  }
  const totalPointsArr = raw.map((x) => x.totalPoints);
  const corrs = {}; PILLARS.forEach((p) => { corrs[p] = Math.abs(pearson(raw.map((x) => x.pillarScores[p]), totalPointsArr)); });
  const corrSum = PILLARS.reduce((s,p)=>s+corrs[p],0) || 1;
  const weights = {}; PILLARS.forEach((p) => { weights[p] = 0.5*PRIOR_WEIGHTS[p] + 0.5*(corrs[p]/corrSum); });
  const wSum = PILLARS.reduce((s,p)=>s+weights[p],0);
  PILLARS.forEach((p) => { weights[p] = weights[p]/wSum; });

  raw.forEach((x) => { x.iq = Math.round(PILLARS.reduce((s,p)=>s+x.pillarScores[p]*weights[p],0)); });
  const iqVals = raw.map((x) => x.iq).sort((a,b)=>a-b);
  const percentileOfIQ = (val) => iqVals.length<2 ? 50 : Math.round((iqVals.filter((v) => v<val).length/(iqVals.length-1))*100);

  const writes = raw.map((x) => {
    const label = x.iq>=85?"🧠 Elite":x.iq>=70?"🎓 Sharp":x.iq>=55?"📚 Learning":x.iq>=40?"🤔 Questionable":"💀 What Are You Doing";
    const confidence = Math.min(5, Math.max(1, Math.round(x.sampleSizes.totalGws/4)));
    return db.doc(`fplIQ/${x.entryId}`).set({
      entryId: parseInt(x.entryId),
      teamName: x.teamName,
      iq: x.iq,
      label,
      percentile: percentileOfIQ(x.iq),
      confidence,
      breakdown: { captainIQ: x.pillarScores.captain, transferIQ: x.pillarScores.transfer, benchIQ: x.pillarScores.bench, consistencyIQ: x.pillarScores.consistency, chipIQ: x.pillarScores.chip },
      weights,
      evidence: x.evidence,
      sampleSizes: x.sampleSizes,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  if (writes.length > 0) {
    await Promise.all(writes);
    console.log(`FPL IQ computed for ${writes.length} managers (weights: ${JSON.stringify(weights)})`);
  }
}

// The One That Got Away — every player transferred out lives on in
// this doc, accumulating points they scored in every subsequent GW.
// Incrementally updated each sync so we never need to re-read past GWs.
// The One That Got Away — every player transferred out lives on in
// this doc, accumulating points they scored in every subsequent GW.
// Incrementally updated each sync so we never need to re-read past GWs.
// Tracks the last GW counted for each tracked player specifically — without
// that, this would keep re-adding the same GW's points on every 15-minute
// sync tick indefinitely, since there was no guard here at all before.
async function computeGotAway(managerHistoryMap, gwTransfersRollup, livePointsByElement, playersMeta, gw, isFinal) {
  const reads = Object.keys(managerHistoryMap).map(id => db.doc(`gotAway/${id}`).get());
  const snaps = await Promise.all(reads);
  const writes = [];
  snaps.forEach((snap, i) => {
    const entryId = parseInt(Object.keys(managerHistoryMap)[i]);
    const m = Object.values(managerHistoryMap)[i];
    const existing = snap.exists ? snap.data() : { players: [] };
    // Only lock in this GW's points once it's actually final — otherwise a
    // sync mid-match would count a partial score and never revisit it.
    let players = (existing.players || []).map(p => {
      if (!isFinal || p.lastCountedGw === gw) return p;
      return {
        ...p,
        pointsSince: (p.pointsSince||0) + (livePointsByElement[p.elementId]||0),
        lastCountedGw: gw,
      };
    });
    // Add newly transferred-out players from this GW — this part doesn't
    // depend on the GW being final, since we know who got sold right away.
    const transfers = gwTransfersRollup[entryId];
    if (transfers?.transfersOut) {
      const trackedIds = new Set(players.map(p=>p.elementId));
      transfers.transfersOut.forEach(elementId => {
        if (!trackedIds.has(elementId)) {
          const p = playersMeta[elementId];
          players.push({ elementId, name: p?.n||"Unknown", soldGw: gw, pointsSince: 0, lastCountedGw: null });
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
// Finds the most recently fully-completed "matchday" (a calendar date, NPT)
// within this gameweek's fixtures — NOT "today", and NOT "the whole
// gameweek". The old version of this logic only checked whether fixtures
// scheduled on TODAY'S date were done, and only had a fallback for once the
// ENTIRE gameweek finished. That broke in the very common case of a
// rearranged/midweek fixture: if one match in the GW gets pushed to
// Wednesday (a top-6 European clash, a postponement), the "whole GW done"
// fallback never fires until Wednesday — even though Friday/Saturday/Sunday's
// results have been sitting there fully confirmed the entire time, and
// someone checking the site Monday or Tuesday sees nothing. This instead
// looks at every calendar date that has fixtures, keeps only the ones
// where EVERY fixture that day has finished AND the date isn't in the
// future, and returns the latest such date — so Monday's sync correctly
// finds "Sunday was the last fully-done matchday" even with a Wednesday
// fixture still pending, and content generates and updates incrementally
// as each day's results land, regardless of what day someone actually
// opens the site.
async function findLatestReadyMatchday(gw) {
  const snap = await db.doc(`gameweekFixtures/gw${gw}`).get();
  if (!snap.exists) return null;
  const fixtures = snap.data().fixtures || [];
  if (fixtures.length === 0) return null;
  const byDate = {};
  fixtures.forEach((f) => {
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(new Date(f.kickoff));
    (byDate[d] = byDate[d] || []).push(f);
  });
  const today = todayNPTServer();
  const readyDates = Object.keys(byDate)
    .filter((d) => d <= today && byDate[d].every((f) => f.finished))
    .sort();
  return readyDates.length ? readyDates[readyDates.length - 1] : null;
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

// Micro Banter — 3-4 short, punchy one-liners about what just happened,
// unlocks GW12. Same per-matchday update pattern as Press Conference/Court.
async function generateMicroBanterIfNeeded(gw, gwResults, gwSquadsRollup, livePointsByElement, playersMeta) {
  if (gw < 12) return;
  const ref = db.doc(`microBanter/gw${gw}`);
  const existing = await ref.get();
  const existingData = existing.exists ? existing.data() : null;
  const latestReady = await findLatestReadyMatchday(gw);
  if (!latestReady) return;
  if (existingData?.lastGeneratedForDate === latestReady) return;
  const byPoints = [...gwResults].sort((a,b)=>b.gwPoints-a.gwPoints);
  const winner = byPoints[0];
  const biggestBench = [...gwResults].sort((a,b)=>b.benchPoints-a.benchPoints)[0];
  const captainBlank = gwResults.find(r => {
    const squad = gwSquadsRollup[r.entryId];
    return squad?.captain && (livePointsByElement[squad.captain]||0) < 3;
  });
  const facts = [
    winner ? `${winner.teamName} is leading this gameweek with ${winner.gwPoints} points` : null,
    biggestBench && biggestBench.benchPoints > 8 ? `${biggestBench.teamName} left ${biggestBench.benchPoints} points on the bench` : null,
    captainBlank ? `${captainBlank.teamName}'s captain blanked` : null,
  ].filter(Boolean);
  if (facts.length === 0) return;
  const prompt = `You are writing short, witty one-liner banter for "K&A Paid FPL", an office Fantasy Premier League mini-league. Based on these facts from Gameweek ${gw} so far, write ${facts.length} punchy, funny one-liners (one per fact, under 20 words each). Plain text, one liner per line, no numbering, no markdown.

Facts:
${facts.map(f=>`- ${f}`).join('\n')}`;
  const text = await callOpenRouter(prompt, 250);
  if (!text) return;
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean).slice(0,4);
  if (lines.length === 0) return;
  await ref.set({
    gw,
    lastGeneratedForDate: latestReady,
    lines,
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`Micro Banter generated for GW${gw}: ${lines.length} lines`);
}

async function generateFplCourtIfNeeded(gw, gwResults, gwSquadsRollup, livePointsByElement, avgPoints, playersMeta) {
  if (gw < 10) return;
  const ref = db.doc(`fplCourt/gw${gw}`);
  const existing = await ref.get();
  const existingData = existing.exists ? existing.data() : null;
  const latestReady = await findLatestReadyMatchday(gw);
  if (!latestReady) return;
  if (existingData?.lastGeneratedForDate === latestReady) return; // already reflects this matchday's results
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
    lastGeneratedForDate: latestReady,
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
// Lost Points Index — each GW, for each manager, finds bench players who
// outscored the weakest starter and accumulates the "lost" gap all season.
// Only counted once a GW is fully final, and tracks which GWs have already
// been counted per manager — without both of those guards, this would
// re-increment the running total every 15 minutes all gameweek long, since
// bench/starter points keep changing live until the whole GW settles.
async function computeLostPoints(gwResults, gwSquadsRollup, livePointsByElement, gw, isFinal) {
  if (!isFinal) return;
  const writes = [];
  for (const r of gwResults) {
    const squad = gwSquadsRollup[r.entryId];
    if (!squad) continue;
    const ref = db.doc(`lostPoints/${r.entryId}`);
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : { totalLost: 0, processedGws: [] };
    if ((existing.processedGws || []).includes(gw)) continue; // already counted this GW
    const startingPts = squad.starting.map(id => livePointsByElement[id] || 0);
    const benchPts = squad.bench.map(id => livePointsByElement[id] || 0);
    const worstStarter = Math.min(...startingPts);
    const lostThisGw = benchPts.reduce((sum, bPts) => {
      return bPts > worstStarter ? sum + (bPts - worstStarter) : sum;
    }, 0);
    writes.push(
      ref.set({
        entryId: r.entryId,
        teamName: r.teamName,
        totalLost: (existing.totalLost||0) + lostThisGw,
        processedGws: [...(existing.processedGws||[]), gw],
        lastGw: gw,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
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
  const latestReady = await findLatestReadyMatchday(gw);
  if (!latestReady) return;
  if (existingData?.lastGeneratedForDate === latestReady) return;
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
    lastGeneratedForDate: latestReady,
    winner: { entryId: winner.entryId, teamName: winner.teamName, points: winner.gwPoints, ...parsed.winner },
    loser: { entryId: loser.entryId, teamName: loser.teamName, points: loser.gwPoints, ...parsed.loser },
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`Press Conference generated for GW${gw}`);
}

// The Death Player — the single player league-wide who, if they haul,
// would cause the most chaos in the standings. Defined as: the
// lowest-owned player among those owned by anyone currently in the top 10
// of the table — a differential among the leaders swings the race hardest.
async function computeDeathPlayer(gwSquadsRollup, standingsManagers, livePointsByElement, gw) {
  if (!gw) return;
  const top10Ids = new Set(
    [...standingsManagers].sort((a,b)=>(b.total||0)-(a.total||0)).slice(0,10).map(m=>m.entry)
  );
  const ownership = {}; // elementId -> count across whole league
  const top10Owners = {}; // elementId -> [teamName] owned by a top-10 manager
  Object.entries(gwSquadsRollup).forEach(([entryId, squad]) => {
    const allIds = [...squad.starting, ...squad.bench];
    allIds.forEach(id => {
      ownership[id] = (ownership[id]||0) + 1;
      if (top10Ids.has(parseInt(entryId))) {
        if (!top10Owners[id]) top10Owners[id] = [];
        top10Owners[id].push(squad.teamName);
      }
    });
  });
  const candidates = Object.entries(top10Owners)
    .map(([id, owners]) => ({ id: parseInt(id), owners, totalOwnership: ownership[id]||0 }))
    .sort((a,b) => a.totalOwnership - b.totalOwnership);
  const deathPlayer = candidates[0];
  if (!deathPlayer) return;
  await db.doc(`deathPlayer/gw${gw}`).set({
    gw,
    elementId: deathPlayer.id,
    ownedByTop10: deathPlayer.owners,
    totalOwnership: deathPlayer.totalOwnership,
    currentPoints: livePointsByElement[deathPlayer.id] || 0,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// Actual vs Perfect — cumulative gap between what each manager actually
// scored and what they'd have scored with the perfect captain pick every
// week (best-scoring player in their own starting XI, captained instead).
// Same double-counting risk as Lost Points above — only counted once final,
// tracked per-GW so a repeat sync run can never re-add the same week twice.
async function computeActualVsPerfect(gwResults, gwSquadsRollup, livePointsByElement, gw, isFinal, players) {
  if (!isFinal) return;
  const writes = [];
  for (const r of gwResults) {
    const squad = gwSquadsRollup[r.entryId];
    if (!squad || !squad.captain) continue;
    const ref = db.doc(`actualVsPerfect/${r.entryId}`);
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : { totalGap: 0, processedGws: [], perfectCount: 0, bestCall: null, worstCall: null };
    if ((existing.processedGws || []).includes(gw)) continue;
    const captainPts = livePointsByElement[squad.captain] || 0;
    const bestPossible = Math.max(...squad.starting.map(id => livePointsByElement[id] || 0));
    const gap = bestPossible - captainPts;
    // Captain conviction evidence — kept for Manager DNA / FPL IQ's
    // "best call" / "worst call" callouts, so the score comes with a real
    // example attached instead of just a number.
    const captainName = players?.get(squad.captain)?.web_name || "?";
    const evidence = { gw, captainName, points: captainPts, gap };
    let bestCall = existing.bestCall, worstCall = existing.worstCall;
    if (!bestCall || gap < bestCall.gap || (gap === bestCall.gap && captainPts > bestCall.points)) bestCall = evidence;
    if (!worstCall || gap > worstCall.gap) worstCall = evidence;
    writes.push(
      ref.set({
        entryId: r.entryId,
        teamName: r.teamName,
        totalGap: (existing.totalGap||0) + gap,
        processedGws: [...(existing.processedGws||[]), gw],
        perfectCount: (existing.perfectCount||0) + (gap === 0 && captainPts > 0 ? 1 : 0),
        bestCall,
        worstCall,
        lastGw: gw,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
    );
  }
  if (writes.length > 0) await Promise.all(writes);
}

// Achievements — permanent badges, checked every sync, never removed once
// earned. Each manager's doc just grows over the season.
const ACHIEVEMENT_DEFS = {
  first_win:      { label: "🏆 First Blood",       desc: "Won your first gameweek" },
  century:        { label: "💯 Century Club",       desc: "Scored 100+ in a single gameweek" },
  bench_disaster: { label: "🪑 Bench Disaster",     desc: "Left 20+ points on the bench in one GW" },
  zero_hero:      { label: "💀 Zero Hero",          desc: "Scored under 20 points in a gameweek" },
  perfect_captain:{ label: "🎯 Perfect Captain",    desc: "Your captain was the top scorer in your own squad" },
  risk_taker:     { label: "🎲 Risk Taker",         desc: "Took a hit of 12+ points on transfers" },
  giant_slayer:   { label: "🤖 Giant Slayer",       desc: "Beat the Algorithm ghost team in a gameweek" },
  comeback:       { label: "📈 The Comeback",       desc: "Climbed 10+ places in the overall rank in one GW" },
};
async function computeAchievements(gwResults, gwSquadsRollup, livePointsByElement, managerHistoryMap, gw, isFinal) {
  if (!isFinal) return; // check against settled numbers only — a mid-week spike shouldn't permanently earn (or narrowly miss) a badge
  const ghostSnap = await db.doc(`ghostTeams/gw${gw}`).get();
  const algorithmPts = ghostSnap.exists ? (ghostSnap.data().algorithm?.points || 0) : null;
  const writes = [];
  for (const r of gwResults) {
    const squad = gwSquadsRollup[r.entryId];
    const m = managerHistoryMap[r.entryId];
    if (!squad || !m) continue;
    const earned = [];
    const history = m.fullHistory.filter(h => h.gw <= gw).sort((a,b)=>a.gw-b.gw);
    const isFirstWin = history.length > 0 && history[history.length-1].rank === 1 && !history.slice(0,-1).some(h=>h.rank===1);
    // (approximate "first win" as first time reaching rank 1 in the mini-league history — good enough signal)
    if (r.gwPoints >= 100) earned.push("century");
    if (r.benchPoints >= 20) earned.push("bench_disaster");
    if (r.gwPoints > 0 && r.gwPoints < 20) earned.push("zero_hero");
    if (r.transferCost >= 12) earned.push("risk_taker");
    if (squad.captain) {
      const capPts = livePointsByElement[squad.captain] || 0;
      const bestInSquad = Math.max(...squad.starting.map(id => livePointsByElement[id] || 0));
      if (capPts === bestInSquad && capPts > 0) earned.push("perfect_captain");
    }
    if (algorithmPts !== null && r.gwPoints > algorithmPts) earned.push("giant_slayer");
    if (history.length >= 2) {
      const rankGain = (history[history.length-2].rank||99) - (history[history.length-1].rank||99);
      if (rankGain >= 10) earned.push("comeback");
    }
    if (earned.length === 0) continue;
    writes.push((async () => {
      const ref = db.doc(`achievements/${r.entryId}`);
      const snap = await ref.get();
      const existing = snap.exists ? (snap.data().earned || []) : [];
      const existingIds = new Set(existing.map(e => e.id));
      const newOnes = earned.filter(id => !existingIds.has(id)).map(id => ({ id, gw, earnedAt: new Date().toISOString() }));
      if (newOnes.length === 0) return;
      await ref.set({
        entryId: r.entryId,
        teamName: r.teamName,
        earned: [...existing, ...newOnes],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    })());
  }
  if (writes.length > 0) {
    await Promise.all(writes);
    console.log(`Achievements checked for GW${gw}`);
  }
}

// League Record Book — permanent season records, only updated when broken.
async function computeRecordBook(gwResults, gw, isFinal) {
  if (!isFinal) return; // don't let a still-moving mid-week number set (and then confusingly re-set) a permanent record
  if (gwResults.length === 0) return;
  const ref = db.doc("recordBook/season");
  const snap = await ref.get();
  const records = snap.exists ? snap.data() : {};
  const highest = [...gwResults].sort((a,b)=>b.gwPoints-a.gwPoints)[0];
  const lowest = [...gwResults].sort((a,b)=>a.gwPoints-b.gwPoints)[0];
  const biggestBenchGw = [...gwResults].sort((a,b)=>b.benchPoints-a.benchPoints)[0];
  const biggestHitGw = [...gwResults].sort((a,b)=>b.transferCost-a.transferCost)[0];
  const updates = {};
  if (!records.highestGw || highest.gwPoints > records.highestGw.points) {
    updates.highestGw = { entryId: highest.entryId, teamName: highest.teamName, points: highest.gwPoints, gw };
  }
  if (!records.lowestGw || lowest.gwPoints < records.lowestGw.points) {
    updates.lowestGw = { entryId: lowest.entryId, teamName: lowest.teamName, points: lowest.gwPoints, gw };
  }
  if (!records.biggestBenchWaste || biggestBenchGw.benchPoints > records.biggestBenchWaste.points) {
    updates.biggestBenchWaste = { entryId: biggestBenchGw.entryId, teamName: biggestBenchGw.teamName, points: biggestBenchGw.benchPoints, gw };
  }
  if (!records.biggestHit || biggestHitGw.transferCost > records.biggestHit.points) {
    updates.biggestHit = { entryId: biggestHitGw.entryId, teamName: biggestHitGw.teamName, points: biggestHitGw.transferCost, gw };
  }
  if (Object.keys(updates).length === 0) return;
  await ref.set({ ...records, ...updates, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  console.log(`Record Book updated for GW${gw}: ${Object.keys(updates).join(', ')}`);
}

// Manager Evolution — snapshots each manager's DNA archetype every 4
// gameweeks, building a timeline of how their playing style has shifted.
async function computeManagerEvolutionSnapshot(managerHistoryMap, gw) {
  if (gw < 3 || gw % 4 !== 0) return; // only snapshot every 4th GW, and DNA needs 3+ GWs to mean anything
  const writes = [];
  for (const entryId of Object.keys(managerHistoryMap)) {
    const dnaSnap = await db.doc(`managerDNA/${entryId}`).get();
    if (!dnaSnap.exists) continue;
    const dna = dnaSnap.data();
    writes.push(
      db.doc(`managerEvolution/${entryId}`).set({
        entryId: parseInt(entryId),
        teamName: dna.teamName,
        snapshots: admin.firestore.FieldValue.arrayUnion({ gw, archetype: dna.archetype, traits: dna.traits }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true })
    );
  }
  if (writes.length > 0) {
    await Promise.all(writes);
    console.log(`Manager Evolution snapshotted at GW${gw}`);
  }
}

// Transfer Hall of Shame — running, season-long list of the worst transfers
// league-wide by points lost (incoming player scored fewer points than the
// one dropped, same gameweek). Only evaluated once a GW is fully final —
// scores are still moving otherwise, and would record the same transfer
// with a different (wrong) delta on every sync tick. Tracks which GWs have
// already been processed so it never double-counts once final either.
async function computeTransferHallOfShame(gwTransfersRollup, livePointsByElement, gw, isFinal) {
  if (!isFinal) return;
  const ref = db.doc("transferHallOfShame/season");
  const snap = await ref.get();
  const existingData = snap.exists ? snap.data() : { worst: [], processedGws: [] };
  if ((existingData.processedGws || []).includes(gw)) return; // already recorded this GW's transfers
  const candidates = [];
  Object.values(gwTransfersRollup).forEach(entry => {
    (entry.transfersIn||[]).forEach((inId, i) => {
      const outId = entry.transfersOut?.[i];
      if (outId === undefined) return;
      const delta = (livePointsByElement[inId]||0) - (livePointsByElement[outId]||0);
      if (delta < -3) { // only genuinely bad swaps are worth immortalising
        candidates.push({ gw, teamName: entry.teamName, inId, outId, delta });
      }
    });
  });
  const combined = [...(existingData.worst||[]), ...candidates].sort((a,b)=>a.delta-b.delta).slice(0,10);
  await ref.set({
    worst: combined,
    processedGws: [...(existingData.processedGws||[]), gw],
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
