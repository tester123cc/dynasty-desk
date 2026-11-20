#!/usr/bin/env python3
"""One-time backfill of weekly expert values for trend arrows.

DynastyProcess publishes values.csv about once a week; its git history is the archive.
For each week in the window this takes the last commit of that day, builds the same
top-400 expert map the nightly job writes to data/history.json (value_2qb scaled so
the top player is 10000, keyed by the app's pkey), and writes data/history-weekly.json.
The app merges both files, preferring the nightly rows on any shared date.

Usage (repo root):  python3 -I scripts/backfill-history.py [weeks=13]
"""
import csv, io, json, re, subprocess, sys

WEEKS = int(sys.argv[1]) if len(sys.argv) > 1 else 13
API = "https://api.github.com/repos/dynastyprocess/data/commits?path=files/values.csv&per_page=100"
RAW = "https://raw.githubusercontent.com/dynastyprocess/data/{sha}/files/values.csv"

def get(url):  # curl: uses the system's certificate store (some python.org installs have none)
    return subprocess.run(["curl", "-sSfL", "--max-time", "60", "-A", "dynasty-desk-backfill", url],
                          check=True, capture_output=True).stdout.decode("utf-8")

def pkey(n):  # same as pkey() in index.html and scripts/fetch-data.mjs
    n = n.lower()
    n = re.sub(r"['.]", "", n)
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    n = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", n)
    return re.sub(r"\s+", " ", n).strip()

def pick_key(n):
    m = re.match(r"^(\d{4}) (Early|Mid|Late) (\d)(st|nd|rd|th)", n)
    return f"{m[1]} {m[3]}{m[4]} ({m[2]})" if m else n

def row_from_csv(text):
    rows = list(csv.DictReader(io.StringIO(text)))
    vals, mx, date = [], 0.0, ""
    for r in rows:
        try:
            v = float(r.get("value_2qb") or 0)
        except ValueError:
            continue
        if v <= 1:
            continue
        n = r.get("player") or ""
        if r.get("pos") == "PICK":
            if not re.match(r"^202[7-9]", n):
                continue
            n = pick_key(n)
        vals.append((n, v)); mx = max(mx, v)
        date = date or (r.get("scrape_date") or "")
    if len(vals) < 50:
        return None
    m = {}
    for n, v in vals:
        m[pkey(n)] = round(v / mx * 10000)
    top = sorted(m.items(), key=lambda kv: -kv[1])[:400]
    return date[:10], dict(top)

commits = json.loads(get(API))
by_day = {}
for c in commits:  # newest first: keep the last commit of each day
    d = c["commit"]["committer"]["date"][:10]
    by_day.setdefault(d, c["sha"])
days = sorted(by_day)[-WEEKS:]
out = []
for d in days:
    res = row_from_csv(get(RAW.format(sha=by_day[d])))
    if res:
        sd, v = res
        out.append({"d": sd or d, "v": v})
        print(d, "->", sd, len(v), "players")
out = sorted({r["d"]: r for r in out}.values(), key=lambda r: r["d"])
with open("data/history-weekly.json", "w") as f:
    json.dump({"src": "DynastyProcess values.csv git history", "rows": out}, f, separators=(",", ":"))
print("wrote", len(out), "weekly rows")
