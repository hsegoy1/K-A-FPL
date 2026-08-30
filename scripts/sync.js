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
      const transfersIn = transfersThisGw.map((t) => ({ element: t.element_in, cost: t.element_in_cost }));
      const transfersOut = transfersThisGw.map((t) => ({ element: t.element_out, cost: t.element_out_cost }));

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

  // AI-generated gameweek recap ("The Autopsy") — same reasoning as
  // mwWinners above: only once bonus points are confirmed, so the story
  // isn't narrated off numbers that could still shift.
  if (isFinal) {
    await generateAutopsyIfNeeded(gw, { gwWinner, gwLoser, biggestBench, mostHits, mostCaptained, avgPoints });
  }

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
