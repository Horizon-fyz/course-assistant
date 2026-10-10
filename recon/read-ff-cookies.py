import sqlite3, json, os, sys

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffcookie")
DB = os.path.join(WORK, "cookies.sqlite")

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
con.row_factory = sqlite3.Row
cur = con.cursor()

cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in cur.fetchall()]

rows = cur.execute("""
    SELECT host, name, value, path, expiry, isSecure, isHttpOnly
    FROM moz_cookies
    WHERE host LIKE '%zhihuishu%' OR host LIKE '%polymas%'
    ORDER BY host, name
""").fetchall()

print("tables:", tables)
print("total zhihuishu cookies:", len(rows))

byhost = {}
for r in rows:
    byhost.setdefault(r["host"], []).append(r)

for h in sorted(byhost):
    names = sorted({r["name"] for r in byhost[h]})
    print(f"{h}  ({len(byhost[h])} cookies)")
    print("   ", ", ".join(names))

# 落盘完整凭据（本地文件）
out = {}
for h, rs in byhost.items():
    out[h] = [
        {
            "name": r["name"],
            "value": r["value"],
            "path": r["path"],
            "expiry": r["expiry"],
            "secure": bool(r["isSecure"]),
            "httpOnly": bool(r["isHttpOnly"]),
        }
        for r in rs
    ]
with open(os.path.join(WORK, "zhs-cookies.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

# 直接生成各关键域的 Cookie 请求头字符串
def header_for(suffix):
    parts = []
    for h, rs in byhost.items():
        if h.endswith(suffix):
            for r in rs:
                parts.append(f'{r["name"]}={r["value"]}')
    return "; ".join(parts)

targets = [
    "onlineweb.zhihuishu.com",
    "onlineservice-api.zhihuishu.com",
    "hike.zhihuishu.com",
    "coursehome.zhihuishu.com",
    "zhihuishu.com",
    "polymas.com",
]
hdrs = {t: header_for(t) for t in targets}
with open(os.path.join(WORK, "cookie-headers.json"), "w", encoding="utf-8") as f:
    json.dump(hdrs, f, ensure_ascii=False, indent=2)

print()
for t in targets:
    v = hdrs[t]
    print(f"header[{t}] len={len(v)} names={[p.split('=')[0] for p in v.split('; ') if p]}")
