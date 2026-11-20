# Dynasty Desk — notes for Claude Code

Single-file static web app (`index.html`) served by GitHub Pages at tester123cc.github.io/dynasty-desk. It is for two Sleeper superflex dynasty leagues. Leaguemates use the same link, so **always update `index.html` in place** (same filename). Add `?v=N` to the URL to bust the cache after a release.

## Leagues and user
- Boo Boo Baby: Sleeper id `1314551881690787840`, key A, half PPR. User's team "Little St-Browns Island", roster id 12. The user is rebuilding here and wants to be a title favorite by 2029.
- The Flight Log: id `1376273128933593088`, key B, full PPR. User's team "Critical Chase Theory".
- The user works mostly from a phone. Keep UI phone-first. They say "merge" when they want a PR merged; do not merge without being asked.

## Layout
- `index.html`: the whole app (CSS, JS, embedded snapshot data). The 2027 rookie board is a second single-file page embedded as the string `RB27_HTML` in a persistent iframe; parent and child talk by `postMessage` (`dd-live`, `rb27-ready`, `rb27-h`, `rb27-haul`/`dd-haul`).
- `scripts/fetch-data.mjs`: nightly values job. `scripts/crawl-trades.mjs`: market trades from KeepTradeCut's trade database. Workflow: `.github/workflows/data.yml`, daily plus manual dispatch. Outputs `data/values.json`, `data/history.json`, `data/market-trades.json`.
- Rookie board sources live in `/home/claude/rb27` in cloud sessions only (not in the repo); re-extract the board from `RB27_HTML` if you need to edit it.

## Key internals
- Values: DynastyProcess CSV + FantasyCalc (per-league ppr/numQbs) + KeepTradeCut, blended by `S.weights`; `adj = value*mult*ageF*modeF`. `mv(p,L)` is market value without age discount (used for trade grading).
- Offers: `makeOffers`/`makeSells`, tuned by `learnTrades(L)` (league trades plus market trades). Pending trades: `PENDING`, `pendCard`; Sleeper may not return proposals.
- Draft order: `projOrder(lg)` runs 1,000 season sims; falls back to `draftOrder`. Pick ids: `pk_<lg>_<round>_<origRoster>[_yy]`.
- Market tab: `pMarket`, `mktItem`, `mktRows`; KeepTradeCut ppr codes 1=0, 2=.5, 3=1, 4=tiered; tep 0-3.

## Working rules
- Verify with Playwright against the local file. Check both leagues and every tab render. Run `node --check` on the extracted script.
- Cloud sandbox network blocks Sleeper, FantasyCalc, KeepTradeCut. Treat live-data paths as unverified until tested on the user's computer or in GitHub Actions. Say so plainly.
- GitHub: `gh api` REST only (GraphQL is blocked). Push with `git -c push.negotiate=true push`. The data job commits to the branch it runs on, so `git pull --rebase` before pushing. Commit trailers: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and the session URL.
- KeepTradeCut has no public API. We read its trade-database page's own POST (`/dynasty/trade-database/trades`). Call it at most daily and do not hammer it.

## Roadmap (not done)
Live Sleeper draft sync; re-rank rookies after the April NFL draft; trend arrows from `data/history.json`; refresh rookie rankings (they go stale weekly; Dynasty Nerds only publishes a top 25).
