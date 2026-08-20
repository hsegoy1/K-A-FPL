# K&A Paid FPL — Matchday Sheet

Tracks the office FPL league (League ID `878289`): live standings, per-manager
history (like FPL's own points page), a fun-stats panel per gameweek (GW
winner, wooden spoon, most captained, biggest bench, most transfer hits), and
a running log of GW winners for the prize pot.

## How it works

- `scripts/sync.js` — a Node script that calls the public FPL API (no auth
  needed to read it) and writes standings + history + stats into Firestore.
- `.github/workflows/sync.yml` — runs that script automatically once a day
  (also runnable manually from the GitHub Actions tab).
- `public/` — the actual website (plain HTML/CSS/JS, no build step) that
  reads from Firestore and renders the table, stats, and manager drill-down.
  Deployed on Firebase Hosting.

No FPL login or password is ever needed — league standings and history are
public data.

## One-time setup

### 1. Push this to GitHub

```bash
git remote add origin <your-repo-url>
git add .
git commit -m "Initial site"
git branch -M main
git push -u origin main
```

### 2. Create a Firebase service account (for the sync script)

The sync script needs admin access to write to Firestore. This is separate
from the public web config already in `public/firebase-config.js`.

1. Firebase Console → ⚙️ Project settings → **Service accounts** tab
2. Click **Generate new private key** → downloads a `.json` file
3. Open that file, copy its *entire contents*

### 3. Add GitHub repo secrets

In your GitHub repo → Settings → Secrets and variables → Actions → New
repository secret:

- `FIREBASE_SERVICE_ACCOUNT` → paste the full JSON from step 2
- `FPL_LEAGUE_ID` → `878289`

That's it — the Action will now run daily and keep Firestore updated. You can
also trigger it manually anytime from the **Actions** tab → "Sync FPL data to
Firestore" → **Run workflow** (useful right after a gameweek deadline).

### 4. Deploy the website

Install the Firebase CLI once (any team member can do this):

```bash
npm install -g firebase-tools
firebase login
```

Then from the project folder:

```bash
firebase deploy --only hosting,firestore:rules
```

Your site will be live at `https://office-fpl-league.web.app`.

### 5. Run the first sync manually

Before the site has anything to show, run the sync once locally (or trigger
the GitHub Action manually — easier, since the secret's already there):

```bash
export FPL_LEAGUE_ID=878289
export FIREBASE_SERVICE_ACCOUNT="$(cat path/to/serviceAccountKey.json)"
npm install
npm run sync
```

## Day-to-day maintenance

- The Action re-syncs automatically every day — nothing to do.
- To re-run after a specific gameweek locks, trigger the Action manually so
  the site updates immediately instead of waiting for the next scheduled run.
- To change the prize/stat logic (e.g. add a "most transfers" stat), edit
  `scripts/sync.js` — it's the single source of truth for what gets computed.
- To restyle or add pages, edit files in `public/` directly — no build step,
  just `firebase deploy --only hosting` after changes.

## Notes

- The web `firebaseConfig` in `public/firebase-config.js` is safe to be
  public — Firebase web API keys aren't secrets. Access is controlled by
  `firestore.rules` (public read, no client writes).
- Only the sync script (via the service account) can write to Firestore.
