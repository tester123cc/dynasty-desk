# Dynasty Desk — notes for Claude Code

Single-file static web app (`index.html`) served by GitHub Pages at tester123cc.github.io/dynasty-desk. It is for two Sleeper superflex dynasty leagues. Leaguemates use the same link, so **always update `index.html` in place** (same filename). Add `?v=N` to the URL to bust the cache after a release.

## Leagues and user
- Boo Boo Baby: Sleeper id `1314551881690787840`, key A, half PPR. User's team "Little St-Browns Island", roster id 12. The user is rebuilding here and wants to be a title favorite by 2029.
- The Flight Log: id `1376273128933593088`, key B, full PPR. User's team "Critical Chase Theory".
- The user works mostly from a phone. Keep UI phone-first. They say "merge" when they want a PR merged; do not merge without being asked.

## Layout
- `index.html`: the whole app (CSS, JS, embedded snapshot data). The 2027 rookie board is a second single-file page embedded as the string `RB27_HTML` in a persistent iframe; parent and child talk by `postMessage` (`dd-live`, `rb27-ready`, `rb27-h`, `rb27-haul`/`dd-haul`).
- `scripts/fetch-data.mjs`: nightly values job. `scripts/crawl-trades.mjs`: market trades from KeepTradeCut's trade database. Workflow: `.github/workflows/data.yml`, daily plus manual dispatch. Outputs `data/values.json`, `data/history.json`, `data/market-trades.json`.
- Rookie board sources live in `/home/claude/rb27` in cloud sessions only (not in the repo). To edit the board, use `scripts/rb27.py` (`out` to a file, edit, `in` to re-embed; it handles the string escaping).

## Key internals
- Values: DynastyProcess CSV + FantasyCalc (per-league ppr/numQbs) + KeepTradeCut, blended by `S.weights`; `adj = value*mult*ageF*modeF`. `mv(p,L)` is market value without age discount (used for trade grading). KeepTradeCut's rankings page now keeps players in `<script id="ktc-players">` JSON; `parseKTC` reads that first (same code in `scripts/fetch-data.mjs`). Browsers can't fetch KeepTradeCut (CORS), so the app uses the nightly copy in `data/values.json` when it is under 48h old. Missing player ages are filled from Sleeper birth dates (`BDX`, `applyBD`).
- Offers: `makeOffers`/`makeSells`, tuned by `learnTrades(L)` (league trades plus market trades). Pending trades: `PENDING`, `pendCard`; Sleeper may not return proposals.
- Draft order: `projOrder(lg)` runs 1,000 season sims (drives My picks slots); falls back to `draftOrder` (today's order, used by Home and Roster). The "Projected final draft order" card runs its own 700-sim `projSim`. Odds and projections are cached by `VER`, which bumps when injuries/teams load, so they recompute once that data arrives. Pick ids: `pk_<lg>_<round>_<origRoster>[_yy]`.
- Live draft sync (v7.14): `drFind` looks for the 2027 rookie draft in the league's drafts and in its 2027 renewal (`/user/<id>/leagues/nfl/2027` where `previous_league_id` matches; renewals get a new league id). `drPoll`/`drTick` poll `/draft/<id>`, `/picks` and `/traded_picks`: every 8s while drafting, 60s paused, 30s within 3h of a scheduled start, else 5 min; slower when the tab is hidden; restarted after each Sleeper sync. `drPayload` goes to the board as `dd-draft`; the board matches names with `nkey` (drops Jr/Sr/II), makes `x_` stub players for picks not on the board, stores it in `S.sl`, and shows it on Draft day (`vSync`), Board (taken tags) and Mock ("Start from the live draft"). Once Sleeper has a draft order, `dd-live` sends that order and snake setting. Test without a live draft: load `tests/draft-harness.js` in the page and call `__setupFake({...})`, which fakes only the draft endpoints behind `jget`.
- Market tab: `pMarket`, `mktItem`, `mktRows`; KeepTradeCut ppr codes 1=0, 2=.5, 3=1, 4=tiered; tep 0-3.

## Working rules
- Verify with Playwright against the local file. Check both leagues and every tab render. Run `node --check` on the extracted script.
- Cloud sandbox network blocks Sleeper, FantasyCalc, KeepTradeCut. Treat live-data paths as unverified until tested on the user's computer or in GitHub Actions. Say so plainly.
- GitHub: `gh api` REST only (GraphQL is blocked). Push with `git -c push.negotiate=true push`. The data job commits to the branch it runs on, so `git pull --rebase` before pushing. Commit trailers: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and the session URL.
- KeepTradeCut has no public API. We read its trade-database page's own POST (`/dynasty/trade-database/trades`). Call it at most daily and do not hammer it.

## Roadmap (not done)
Re-rank rookies after the April NFL draft; trend arrows from `data/history.json`; refresh rookie rankings (they go stale weekly; Dynasty Nerds only publishes a top 25).

## Status as of Nov 20, 2026 (checked on the live site)
- Live Sleeper sync works (week 11; Boo Boo Baby 17 trades, The Flight Log 5). Pending trades did not show up in either league, so Sleeper likely does not return proposals; the Builder grade is the dependable path.
- Prior-season trade history returned nothing (`old: 0`); check whether the leagues have a `previous_league_id`.
- Market tab: 15,000 KeepTradeCut trades on file, about 14,800 priced; the market sample sets the typical trade gap and consolidation premium (v7.11).
- Boo Boo Baby rarely clears the buy bar; when nothing is Likely/Possible, Ideas now shows the best sell idea per position (v7.12).
- Rookie rankings: `RK.pros` (Draft → Board, My picks) is generated from the 2027 Board's `RAW` rows and uses the same consensus formula. If you update the 2027 Board, regenerate `RK.pros` too.
- Not verified live: free agents tab, Trust Center ledger over time, mock draft with live league data, nightly job workflow permission for pushing data (worked on Nov 20).
- Open PRs/merges are tracked on GitHub; the user says "merge" to approve.
