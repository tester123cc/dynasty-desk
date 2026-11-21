#!/usr/bin/env python3
"""One-time backfill for the Draft tab's pick cards. Runs in GitHub Actions (needs api.github.com and Sleeper).

Writes two files from DynastyProcess's values.csv git history:

data/pick-hits.json   How often rookie picks at each slot became startable players.
    Slot order: each rookie class ranked by DynastyProcess superflex value (value_2qb) on the first
    archived values.csv after June 1 of its draft year, which is after rookie drafts, so the order is
    close to where the player went (1.01 = most valuable rookie). 12-team slots.
    Hit: a top-12 QB, top-24 RB, top-30 WR or top-12 TE season in half-PPR points, in any of the player's
    first three NFL seasons (Sleeper season stats). Classes need at least two finished seasons.

data/pick-seasons.json  What an upcoming-draft pick was worth through the year.
    For each archived date: the value of next draft's 1st, 2nd and 3rd round picks (the generic "YYYY 1st",
    or the average of the slotted "YYYY Pick 1.01".."1.12" once those appear), scaled so the top player is 10000.

Usage (repo root): python3 -I scripts/backfill-picks.py   (GH_TOKEN in the environment raises GitHub's rate limit)
"""
import csv, io, json, os, re, statistics, subprocess, sys
from datetime import date

API = "https://api.github.com/repos/dynastyprocess/data/commits?path=files/values.csv&per_page=100&page={page}"
RAW = "https://raw.githubusercontent.com/dynastyprocess/data/{sha}/files/values.csv"
TOK = os.environ.get("GH_TOKEN", "")

def get(url, api=False):
    cmd = ["curl", "-sSfL", "--max-time", "90", "-A", "dynasty-desk-backfill"]
    if api and TOK:
        cmd += ["-H", "Authorization: Bearer " + TOK]
    return subprocess.run(cmd + [url], check=True, capture_output=True).stdout.decode("utf-8")

def pkey(n):
    n = n.lower()
    n = re.sub(r"['.]", "", n)
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    n = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", n)
    return re.sub(r"\s+", " ", n).strip()

# every commit that touched values.csv, newest first; keep the last commit of each day
by_day = {}
for page in range(1, 30):
    cs = json.loads(get(API.format(page=page), api=True))
    if not cs:
        break
    for c in cs:
        by_day.setdefault(c["commit"]["committer"]["date"][:10], c["sha"])
days = sorted(by_day)
print("commits back to", days[0], "days", len(days))
CACHE = {}
def rows_on(d):
    if d not in CACHE:
        CACHE[d] = list(csv.DictReader(io.StringIO(get(RAW.format(sha=by_day[d])))))
    return CACHE[d]
def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0

# ---------- pick values through the year ----------
seasons = []
last = None
for d in days:
    if last and (date.fromisoformat(d) - date.fromisoformat(last)).days < 12:
        continue
    try:
        rows = rows_on(d)
    except Exception as e:
        print("skip", d, e); continue
    last = d
    mx = max((num(r.get("value_2qb")) for r in rows), default=0)
    if mx <= 0:
        continue
    y0 = int(d[:4]); dy = y0 if d[5:] < "05-15" else y0 + 1   # next rookie draft
    out = {"d": d, "y": dy}
    for rnd, sfx in ((1, "1st"), (2, "2nd"), (3, "3rd")):
        slotted = [num(r.get("value_2qb")) for r in rows if re.match(rf"^{dy} Pick {rnd}\.\d\d$", r.get("player", ""))]
        gen = [num(r.get("value_2qb")) for r in rows if r.get("player", "") in (f"{dy} {sfx}", f"{dy} Mid {sfx}")]
        v = statistics.mean(slotted) if len(slotted) >= 6 else (gen[0] if gen else None)
        if v:
            out["r%d" % rnd] = round(v / mx * 10000)
    if "r1" in out:
        seasons.append(out)
print("pick-seasons rows", len(seasons))
json.dump({"src": "DynastyProcess values.csv git history (value_2qb, top player = 10000)", "rows": seasons},
          open("data/pick-seasons.json", "w"), separators=(",", ":"))

# ---------- hit rates by slot ----------
players = json.loads(get("https://api.sleeper.app/v1/players/nfl"))
sid_by = {}
for sid, p in players.items():
    if p.get("position") in ("QB", "RB", "WR", "TE"):
        n = p.get("full_name") or (str(p.get("first_name", "")) + " " + str(p.get("last_name", "")))
        sid_by.setdefault((pkey(n), p["position"]), sid)
LIM = {"QB": 12, "RB": 24, "WR": 30, "TE": 12}
STATS = {}
def finishes(year):
    if year not in STATS:
        try:
            st = json.loads(get(f"https://api.sleeper.app/v1/stats/nfl/regular/{year}"))
        except Exception:
            st = {}
        ranks = {}
        for pos in LIM:
            ids = [(s.get("pts_half_ppr") or 0, sid) for sid, s in st.items() if players.get(sid, {}).get("position") == pos]
            for i, (_, sid) in enumerate(sorted(ids, reverse=True)):
                ranks[sid] = i + 1
        STATS[year] = ranks if ids else {}
    return STATS[year]
this_year = date.today().year
last_done = this_year - 1 if date.today().month >= 2 else this_year - 2   # last finished NFL season
classes = []
slots = {i: {"n": 0, "hit": 0, "ex": []} for i in range(1, 49)}
for dy in range(2015, this_year):
    if last_done - dy < 1:
        continue   # need two finished seasons
    after = [d for d in days if d >= f"{dy}-06-01" and d < f"{dy}-08-01"]
    if not after:
        continue
    rows = rows_on(after[0])
    rk = sorted(((num(r.get("value_2qb")), r) for r in rows if str(r.get("draft_year", "")).strip() == str(dy) and r.get("pos") in LIM), key=lambda x: -x[0])[:48]
    if len(rk) < 24:
        continue
    yrs = [y for y in (dy, dy + 1, dy + 2) if y <= last_done]
    ranks = [finishes(y) for y in yrs]
    cls = {"y": dy, "on": after[0], "seasons": yrs, "n": 0, "hits": 0}
    for i, (_, r) in enumerate(rk):
        sid = sid_by.get((pkey(r["player"]), r["pos"]))
        best = min([rr.get(sid, 999) for rr in ranks]) if sid else 999
        hit = 1 if best <= LIM[r["pos"]] else 0
        s = slots[i + 1]; s["n"] += 1; s["hit"] += hit
        if len(s["ex"]) < 8:
            s["ex"].append([dy, r["player"], r["pos"], best if best < 999 else None])
        cls["n"] += 1; cls["hits"] += hit
    classes.append(cls)
    print("class", dy, "on", after[0], "hits", cls["hits"], "of", cls["n"])
out = {"src": "DynastyProcess values.csv git history (rookie order after each draft) + Sleeper season stats",
       "hit": "top-12 QB, top-24 RB, top-30 WR or top-12 TE in half-PPR points in any of the first three seasons",
       "classes": classes, "slots": {k: v for k, v in slots.items() if v["n"]}}
json.dump(out, open("data/pick-hits.json", "w"), separators=(",", ":"))
print("pick-hits classes", [c["y"] for c in classes])
