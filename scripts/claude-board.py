#!/usr/bin/env python3
"""Claude draft board (probe stage): checks which college stats sources answer from GitHub Actions."""
import json, os, subprocess
TOK = os.environ.get("GH_TOKEN", "")
def get(url, api=False):
    cmd = ["curl", "-sSL", "--max-time", "60", "-A", "dynasty-desk-board", "-w", "\n%{http_code}"]
    if api and TOK:
        cmd += ["-H", "Authorization: Bearer " + TOK]
    out = subprocess.run(cmd + [url], capture_output=True).stdout.decode("utf-8", "replace")
    body, _, code = out.rpartition("\n")
    return code, body
c, b = get("https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases?per_page=100", api=True)
print("sdv releases", c)
try:
    for r in json.loads(b):
        names = [a["name"] for a in r.get("assets", [])]
        if "cfb" in r["tag_name"].lower() or any("player" in n for n in names):
            print("  tag", r["tag_name"], len(names), [n for n in names if "202" in n][:6])
except Exception as e:
    print("  parse", e, b[:200])
for u in ["https://site.web.api.espn.com/apis/search/v2?query=Jeremiah%20Smith&limit=5",
          "https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/athletes/4870906/stats",
          "https://site.api.espn.com/apis/site/v2/sports/football/college-football/athletes/4870906",
          "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/athletes/4870906/statistics"]:
    c, b = get(u)
    print("espn", c, u[:100]); print("  ", b[:700].replace("\n", " "))
