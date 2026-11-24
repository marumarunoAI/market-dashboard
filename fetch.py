"""Fetch server-side sources (Yahoo, FRED) into data/<id>.json. Run by the scheduled workflow.

Each file: {"d1": [[unix_sec, value], ...], "h4": [...], "marks": [[unix_sec, change_pct_points], ...]}
data/status.json records per-indicator ok/error so the UI can show what failed.
A failed fetch keeps the previous file, so a transient outage never erases data.
"""
import csv, io, json, os, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone

UA = {"User-Agent": "Mozilla/5.0 (market-dashboard; github actions)"}


def get(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read().decode()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))


def day(ts):  # unix seconds at UTC midnight of a YYYY-MM-DD string
    return int(datetime.strptime(ts, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def yahoo_chart(symbol, params):
    url = f"https://query2.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?{params}"
    r = json.loads(get(url))["chart"]["result"][0]
    closes = r["indicators"]["quote"][0]["close"]
    return r["meta"].get("gmtoffset", 0), [(t, c) for t, c in zip(r["timestamp"], closes) if c is not None]


def yahoo_daily(symbol):
    offset, rows = yahoo_chart(symbol, f"period1=0&period2={int(time.time())}&interval=1d")
    out = {}  # keyed by exchange-local date; last row of a day wins (Yahoo appends a live bar)
    for t, c in rows:
        d = datetime.fromtimestamp(t + offset, timezone.utc).strftime("%Y-%m-%d")
        out[day(d)] = round(c, 6)
    return sorted(out.items())


def yahoo_4h(symbol):  # Yahoo keeps ~730 days of 60m bars; bucket closes into 4h UTC bars
    _, rows = yahoo_chart(symbol, "range=730d&interval=60m")
    out = {}
    for t, c in rows:
        out[t - t % 14400] = round(c, 6)
    return sorted(out.items())


def yahoo(ind):
    return {"d1": yahoo_daily(ind["symbol"]), "h4": yahoo_4h(ind["symbol"])}


def fred_series(sid):
    key = os.environ.get("FRED_API_KEY")
    if key:
        q = urllib.parse.urlencode({"series_id": sid, "api_key": key, "file_type": "json"})
        obs = json.loads(get(f"https://api.stlouisfed.org/fred/series/observations?{q}"))["observations"]
        rows = [(o["date"], o["value"]) for o in obs]
    else:
        rows = list(csv.reader(io.StringIO(get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"))))[1:]
    return [[day(d), float(v)] for d, v in rows if v not in (".", "")]


def fred(ind):
    out = {"d1": fred_series(ind["symbol"])}
    if ind.get("marks"):  # changes in the target rate = hikes / cuts
        s = fred_series(ind["marks"])
        out["marks"] = [[t, round(v - p, 4)] for (_, p), (t, v) in zip(s, s[1:]) if v != p]
    return out


FETCHERS = {"yahoo": yahoo, "fred": fred}


def main():
    inds = json.load(open("indicators.json"))
    status = {}
    for ind in inds:
        jobs = []
        if ind["source"] in FETCHERS:
            jobs.append((ind["id"], lambda ind=ind: FETCHERS[ind["source"]](ind)))
        if ind.get("backfill"):  # Yahoo daily history used before a live source's first bar
            jobs.append((ind["id"] + "_backfill", lambda ind=ind: {"d1": yahoo_daily(ind["backfill"])}))
        for name, job in jobs:
            try:
                data = job()
                if not data["d1"]:
                    raise ValueError("no rows")
                json.dump(data, open(f"data/{name}.json", "w"), separators=(",", ":"))
                last = datetime.fromtimestamp(data["d1"][-1][0], timezone.utc).strftime("%Y-%m-%d")
                status[name] = {"ok": True, "last": last}
                print(f"ok   {name:16} {len(data['d1']):6} d1  {len(data.get('h4', [])):6} h4  last {last}")
            except Exception as e:
                status[name] = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
                print(f"FAIL {name:16} {e}")
    status["_fetched_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    status["_fred_mode"] = "api" if os.environ.get("FRED_API_KEY") else "fredgraph.csv (keyless)"
    json.dump(status, open("data/status.json", "w"), indent=1)
    if all(not v["ok"] for k, v in status.items() if not k.startswith("_")):
        sys.exit("every fetch failed")


if __name__ == "__main__":
    main()
