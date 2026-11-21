#!/usr/bin/env python3
"""Claude's 2027 draft board: rank rookies on what history says predicts a startable fantasy player.

Runs nightly in GitHub Actions (needs ESPN, Sleeper and GitHub release downloads). Writes data/claude-board.json.

Training set: every QB, RB, WR and TE drafted 2015 to (last finished season - 1), from nflverse's draft_picks.csv.
Outcome ("hit"): a top-12 QB, top-24 RB, top-30 WR or top-12 TE season in half-PPR points in any of the first three
NFL seasons (Sleeper season stats), the same definition as the pick hit rates.
Three factors, as asked:
  1. College production: number of college seasons before the draft with good stats (ESPN college stats;
     QB 2,500+ pass yds or 20+ pass TD or 2,800+ total yds; RB 900+ scrimmage yds or 10+ TD; WR 700+ rec yds or 50+ rec;
     TE 450+ rec yds or 35+ rec), capped at 4.
  2. Draft capital: NFL draft pick (log scale). For 2027 prospects before the NFL draft: Kiper's big board rank, or a
     projection from the dynasty consensus rank for players he does not list. Real picks replace it once nflverse has them.
  3. Landing spot: the drafting team's points per game the season before, compared with the league (z-score).
     Unknown before the draft, so prospects get the league average until then.
Model: logistic regression with position terms, checked by leaving out one draft class at a time.
"""
import csv, importlib.util, io, json, math, os, re, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
T0 = time.time(); BUDGET = float(os.environ.get("BOARD_BUDGET_S", "1200"))   # stop looking up new players after this; the next run continues
from datetime import date

UA = "dynasty-desk-board"
def get(url, tries=3):
    for i in range(tries):
        r = subprocess.run(["curl", "-sSfL", "--max-time", "25", "-A", UA, url], capture_output=True)
        if r.returncode == 0:
            return r.stdout.decode("utf-8", "replace")
        time.sleep(1.5 * (i + 1))
    raise RuntimeError("failed " + url)
def pkey(n):
    n = n.lower(); n = re.sub(r"['.]", "", n); n = re.sub(r"[^a-z0-9 ]", " ", n)
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", n); return re.sub(r"\s+", " ", n).strip()
def skey(s):  # school key
    s = s.lower().replace("st.", "state").replace("&", "and")
    s = re.sub(r"\b(university|of|the)\b", " ", s); s = re.sub(r"[^a-z0-9 ]", " ", s); return re.sub(r"\s+", " ", s).strip()
def num(x):
    try: return float(str(x).replace(",", ""))
    except (TypeError, ValueError): return 0.0

TODAY = date.today()
LAST_DONE = TODAY.year - 1 if TODAY.month >= 2 else TODAY.year - 2   # last finished NFL season
CUR_CFB = TODAY.year if TODAY.month >= 8 else TODAY.year - 1         # college season in progress or just ended
LIM = {"QB": 12, "RB": 24, "WR": 30, "TE": 12}

# ---------- college stats (ESPN), cached in data/college-cache.json ----------
CACHE_F = "data/college-cache.json"
try: CACHE = json.load(open(CACHE_F))
except Exception: CACHE = {}
STAT_NAMES = {"passingYards": "py", "passingTouchdowns": "ptd", "rushingYards": "ry", "rushingTouchdowns": "rtd",
              "receptions": "rec", "receivingYards": "recy", "receivingTouchdowns": "rectd", "gamesPlayed": "gp"}
dbg = {"n": 0}
def espn_seasons(aid):
    j = json.loads(get(f"https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/athletes/{aid}/stats"))
    out = {}
    for cat in j.get("categories", []):
        names = cat.get("names") or []
        for row in cat.get("statistics", []):
            y = (row.get("season") or {}).get("year")
            if not y: continue
            s = out.setdefault(str(y), {})
            for nm, v in zip(names, row.get("stats", [])):
                k = STAT_NAMES.get(nm)
                if k: s[k] = max(s.get(k, 0), num(v))
    if dbg["n"] < 2:
        dbg["n"] += 1
        print("  espn sample", aid, [c.get("name") for c in j.get("categories", [])], dict(list(out.items())[:2]))
    return out
def find_player(name, school, pos):
    q = re.sub(r"\s+(Jr\.?|Sr\.?|II|III|IV)$", "", name)
    j = json.loads(get("https://site.web.api.espn.com/apis/search/v2?limit=10&query=" + q.replace(" ", "%20")))
    cands = []
    for blk in j.get("results", []):
        for c in blk.get("contents", []) if blk.get("type") == "player" else []:
            m = re.search(r"l:(\d+)~a:(\d+)", c.get("uid", ""))
            if not m or pkey(c.get("displayName", "")) != pkey(name): continue
            sub = skey(c.get("subtitle", "")); sch = skey(school.split(" / ")[0])
            score = (2 if m.group(1) == "23" else 1) + (3 if sch and (sch in sub or sub.startswith(sch)) else 0)
            cands.append((score, m.group(2)))
    return [a for _, a in sorted(cands, reverse=True)]
LOCK = threading.Lock()
def save_cache():
    with LOCK:
        json.dump(CACHE, open(CACHE_F, "w"), separators=(",", ":"))
def college(name, school, pos, draft_year, fresh_days=None):
    k = pkey(name) + "|" + str(draft_year)
    c = CACHE.get(k)
    if c and (fresh_days is None or time.time() - c.get("t", 0) < fresh_days * 86400):
        return c
    if time.time() - T0 > BUDGET:
        return c or {"t": 0, "id": None, "s": {}, "pending": 1}
    c = {"t": time.time(), "id": None, "s": {}}
    try:
        for aid in find_player(name, school, pos)[:3]:
            s = {y: v for y, v in espn_seasons(aid).items() if int(y) < draft_year}
            if s:
                c = {"t": time.time(), "id": aid, "s": s}; break
            time.sleep(.15)
    except Exception as e:
        c["err"] = str(e)[:80]
    with LOCK:
        CACHE[k] = c
    return c
def prefetch(items):  # items: (name, school, pos, draft_year, fresh_days); looks players up 6 at a time, saving every 50
    todo = [x for x in items if not (CACHE.get(pkey(x[0]) + "|" + str(x[3])) and (x[4] is None or time.time() - CACHE[pkey(x[0]) + "|" + str(x[3])].get("t", 0) < x[4] * 86400))]
    print("college lookups needed", len(todo))
    done = [0]
    def one(x):
        college(*x); done[0] += 1
        if done[0] % 50 == 0:
            save_cache(); print("  looked up", done[0], "in", int(time.time() - T0), "s", flush=True)
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(one, todo))
    save_cache()
def good(pos, s, partial=False):
    f = 1.0
    if partial:  # season in progress: scale to 12 games
        gp = s.get("gp") or 0; f = 12 / gp if 0 < gp < 12 else 1.1
    py, ptd, ry, rtd, rec, recy, rectd = (s.get(x, 0) * f for x in ("py", "ptd", "ry", "rtd", "rec", "recy", "rectd"))
    if pos == "QB": return py >= 2500 or ptd >= 20 or py + ry >= 2800
    if pos == "RB": return ry + recy >= 900 or rtd + rectd >= 10
    if pos == "WR": return recy >= 700 or rec >= 50
    return recy >= 450 or rec >= 35
def good_years(pos, seasons, partial_year=None):
    ys = [int(y) for y, s in seasons.items() if good(pos, s, partial=(int(y) == partial_year))]
    return sorted(ys)

# ---------- NFL side ----------
DP = [r for r in csv.DictReader(io.StringIO(get("https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv")))
      if r["position"] in LIM and int(r["season"]) >= 2015]
GAMES = [r for r in csv.DictReader(io.StringIO(get("https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv")))
         if r["game_type"] == "REG" and r["home_score"]]
PPG = {}
for r in GAMES:
    for t, s in ((r["home_team"], r["home_score"]), (r["away_team"], r["away_score"])):
        PPG.setdefault((int(r["season"]), t), []).append(float(s))
PPG = {k: sum(v) / len(v) for k, v in PPG.items()}
TEAMMAP = {"GNB": "GB", "KAN": "KC", "NOR": "NO", "NWE": "NE", "SFO": "SF", "TAM": "TB", "LVR": "LV", "SDG": "SD", "LAR": "LA"}
ALT = {"LV": "OAK", "LAC": "SD", "LA": "STL", "OAK": "LV", "SD": "LAC", "STL": "LA"}
def land_z(team, season):
    t = TEAMMAP.get(team, team); y = season - 1
    v = PPG.get((y, t)) or PPG.get((y, ALT.get(t, "")))
    allv = [x for (yy, _), x in PPG.items() if yy == y]
    if v is None or len(allv) < 20: return 0.0
    m = sum(allv) / len(allv); sd = (sum((x - m) ** 2 for x in allv) / len(allv)) ** .5 or 1
    return (v - m) / sd

players = json.loads(get("https://api.sleeper.app/v1/players/nfl"))
SID = {}
for sid, p in players.items():
    if p.get("position") in LIM:
        n = p.get("full_name") or (str(p.get("first_name", "")) + " " + str(p.get("last_name", "")))
        SID.setdefault((pkey(n), p["position"]), sid)
RANKS = {}
def ranks(year):
    if year not in RANKS:
        st = json.loads(get(f"https://api.sleeper.app/v1/stats/nfl/regular/{year}"))
        rk = {}
        for pos in LIM:
            ids = sorted(((s.get("pts_half_ppr") or 0, sid) for sid, s in st.items() if players.get(sid, {}).get("position") == pos), reverse=True)
            for i, (_, sid) in enumerate(ids): rk[sid] = i + 1
        RANKS[year] = rk
    return RANKS[year]

# ---------- training rows ----------
_prosp_raw = None
prefetch([(r["pfr_player_name"], r["college"], r["position"], int(r["season"]), None) for r in DP if int(r["season"]) <= LAST_DONE - 1])
rows = []; skipped = 0
for r in DP:
    y = int(r["season"])
    if y > LAST_DONE - 1: continue      # need two finished NFL seasons
    pos = r["position"]; sid = SID.get((pkey(r["pfr_player_name"]), pos))
    if sid:
        best = min(ranks(yy).get(sid, 999) for yy in (y, y + 1, y + 2) if yy <= LAST_DONE)
        hit = 1 if best <= LIM[pos] else 0
    elif num(r.get("games")) >= 30:
        skipped += 1; continue           # a real career we could not match: leave it out rather than call it a miss
    else:
        hit = 0; best = None
    c = college(r["pfr_player_name"], r["college"], pos, y)
    if c.get("pending"): continue
    gy = good_years(pos, c["s"])
    rows.append({"y": y, "n": r["pfr_player_name"], "pos": pos, "pick": int(r["pick"]), "team": r["team"], "school": r["college"],
                 "good": min(4, len(gy)), "cf": 1 if c["s"] else 0, "land": round(land_z(r["team"], y), 2), "hit": hit})
print("training rows", len(rows), "skipped", skipped, "with college stats", sum(x["cf"] for x in rows), "time", int(time.time() - T0))
save_cache()
if len([x for x in rows if x["cf"]]) < 150:
    print("not enough players with college stats yet; the next run continues the lookups"); sys.exit(0)
rows = [x for x in rows if x["cf"]]   # train only on players whose college stats were found

# ---------- model ----------
POSD = ["RB", "WR", "TE"]
def feats(x): return [-math.log(x["pick"]), x["good"], x["land"]] + [1.0 if x["pos"] == p else 0.0 for p in POSD]
FN = ["Draft pick", "Good college seasons", "Landing offense", "RB", "WR", "TE"]
def fit(R, cols=None, lam=1.0, it=3000, lr=.1):
    X = [feats(x) for x in R]
    if cols is not None: X = [[v if j in cols else 0.0 for j, v in enumerate(f)] for f in X]
    k = len(X[0]); mu = [sum(f[j] for f in X) / len(X) for j in range(k)]
    sd = [((sum((f[j] - mu[j]) ** 2 for f in X) / len(X)) ** .5) or 1 for j in range(k)]
    Z = [[(f[j] - mu[j]) / sd[j] for j in range(k)] for f in X]; Y = [x["hit"] for x in R]
    w = [0.0] * k; b = math.log((sum(Y) + 1) / (len(Y) - sum(Y) + 1))
    for _ in range(it):
        gw = [0.0] * k; gb = 0.0
        for z, yv in zip(Z, Y):
            p = 1 / (1 + math.exp(-(b + sum(wi * zi for wi, zi in zip(w, z))))); e = p - yv
            gb += e
            for j in range(k): gw[j] += e * z[j]
        n = len(Z); b -= lr * gb / n
        for j in range(k): w[j] -= lr * (gw[j] / n + lam * w[j] / n)
    return {"w": w, "b": b, "mu": mu, "sd": sd, "cols": cols}
def pred(m, x):
    f = feats(x)
    if m["cols"] is not None: f = [v if j in m["cols"] else 0.0 for j, v in enumerate(f)]
    z = [(f[j] - m["mu"][j]) / m["sd"][j] for j in range(len(f))]
    return 1 / (1 + math.exp(-(m["b"] + sum(wi * zi for wi, zi in zip(m["w"], z)))))
def auc(ps, ys):
    pos = [p for p, y in zip(ps, ys) if y]; neg = [p for p, y in zip(ps, ys) if not y]
    if not pos or not neg: return None
    return sum((p > q) + .5 * (p == q) for p in pos for q in neg) / (len(pos) * len(neg))
def loco(cols):  # leave one draft class out
    ps, ys = [], []
    for y in sorted({x["y"] for x in rows}):
        tr = [x for x in rows if x["y"] != y]; te = [x for x in rows if x["y"] == y]
        m = fit(tr, cols, it=1200)
        ps += [pred(m, x) for x in te]; ys += [x["hit"] for x in te]
    return {"brier": round(sum((p - y) ** 2 for p, y in zip(ps, ys)) / len(ys), 4), "auc": round(auc(ps, ys), 3)}
FULL = loco(None); PICK = loco([0, 3, 4, 5])
M = fit(rows)
print("model", [round(v, 3) for v in M["w"]], "loco full", FULL, "pick only", PICK)

# ---------- patterns (plain hit rates, for the page) ----------
def rate(sel):
    s = [x for x in rows if sel(x)]; return {"n": len(s), "hit": round(sum(x["hit"] for x in s) / len(s), 3) if s else None}
patterns = {
 "pick": [dict(lab=l, **rate(f)) for l, f in [("Picks 1–15", lambda x: x["pick"] <= 15), ("16–32", lambda x: 16 <= x["pick"] <= 32),
          ("Round 2", lambda x: 33 <= x["pick"] <= 64), ("Round 3", lambda x: 65 <= x["pick"] <= 100), ("Rounds 4–7", lambda x: x["pick"] > 100)]],
 "good": [dict(lab=l, **rate(f)) for l, f in [("0 good college seasons", lambda x: x["good"] == 0), ("1", lambda x: x["good"] == 1),
          ("2", lambda x: x["good"] == 2), ("3 or more", lambda x: x["good"] >= 3)]],
 "goodDay12": [dict(lab=l, **rate(f)) for l, f in [("0–1 good seasons", lambda x: x["pick"] <= 64 and x["good"] <= 1),
          ("2", lambda x: x["pick"] <= 64 and x["good"] == 2), ("3 or more", lambda x: x["pick"] <= 64 and x["good"] >= 3)]],
 "land": [dict(lab=l, **rate(f)) for l, f in [("Bottom-10 offense", lambda x: x["land"] <= -.6), ("Middle", lambda x: -.6 < x["land"] < .6),
          ("Top-10 offense", lambda x: x["land"] >= .6)]],
}

# ---------- 2027 prospects (the 2027 Board's rows) ----------
spec = importlib.util.spec_from_file_location("rb27", "scripts/rb27.py"); rb = importlib.util.module_from_spec(spec); spec.loader.exec_module(rb)
src = open("index.html", encoding="utf-8").read(); a, b2 = rb.span(src); board = rb.decode(src[a:b2])
raw_txt = board[board.index("const RAW=[") + len("const RAW="):]; raw_txt = raw_txt[:raw_txt.index("];") + 1]
RAW = json.loads(raw_txt.replace("null", "null"))
DY = CUR_CFB + 1
actual = {(pkey(r["pfr_player_name"]), r["position"]): r for r in DP if int(r["season"]) == DY}
cons = lambda r: (lambda v: sum(v) / len(v) if v else None)([x for x in r[3:6] if isinstance(x, (int, float))])
both = [(math.log(cons(r)), math.log(r[6])) for r in RAW if isinstance(r[6], (int, float)) and cons(r)]
if len(both) >= 5:
    mx = sum(x for x, _ in both) / len(both); my = sum(y for _, y in both) / len(both)
    sl = sum((x - mx) * (y - my) for x, y in both) / (sum((x - mx) ** 2 for x, _ in both) or 1); ic = my - sl * mx
else:
    sl, ic = 1.0, math.log(2)
kmax = max([r[6] for r in RAW if isinstance(r[6], (int, float))] or [25])
prefetch([(r[0], r[2], r[1], DY, 6) for r in RAW if r[1] in LIM])
prospects = []
for r in RAW:
    name, pos, school = r[0], r[1], r[2]
    if pos not in LIM: continue
    c = college(name, school, pos, DY, fresh_days=6)
    gy = good_years(pos, c["s"], partial_year=CUR_CFB)
    act = actual.get((pkey(name), pos))
    if act:
        pick, src_, team = int(act["pick"]), "actual", act["team"]; lz = land_z(team, DY)
    else:
        team, lz = None, 0.0
        if isinstance(r[6], (int, float)): pick, src_ = int(r[6]), "Kiper"
        elif cons(r): pick, src_ = max(kmax + 1, round(math.exp(ic + sl * math.log(cons(r))))), "projected"
        else: pick, src_ = 120, "projected"
    x = {"pick": pick, "good": min(4, len(gy)), "land": lz, "pos": pos}
    seas = [{"y": int(y), **{k: int(v) for k, v in s.items() if k in ("py", "ptd", "ry", "rtd", "rec", "recy", "rectd", "gp")}, "g": int(y) in gy}
            for y, s in sorted(c["s"].items())]
    prospects.append({"n": name, "pos": pos, "school": school, "cons": round(cons(r), 1) if cons(r) else None, "pick": pick, "pickSrc": src_,
                      "team": TEAMMAP.get(team, team) if team else None, "land": round(lz, 2), "good": x["good"], "goodYears": gy,
                      "found": bool(c["s"]), "seasons": seas, "p": round(pred(M, x), 3)})
prospects.sort(key=lambda p: -p["p"])
for i, p in enumerate(prospects): p["rank"] = i + 1
json.dump(CACHE, open(CACHE_F, "w"), separators=(",", ":"))
out = {"t": int(time.time() * 1000), "draftYear": DY, "hitDef": "top-12 QB, top-24 RB, top-30 WR or top-12 TE in half-PPR points in any of the first three NFL seasons",
       "train": {"n": len(rows), "classes": sorted({x["y"] for x in rows}), "hits": sum(x["hit"] for x in rows), "skipped": skipped},
       "model": {"names": FN, "w": [round(v, 3) for v in M["w"]], "b": round(M["b"], 3), "loco": FULL, "pickOnly": PICK},
       "patterns": patterns, "prospects": prospects}
json.dump(out, open("data/claude-board.json", "w"), separators=(",", ":"))
print("prospects", len(prospects), "found college stats", sum(p["found"] for p in prospects), "top", [(p["n"], p["p"]) for p in prospects[:5]])
