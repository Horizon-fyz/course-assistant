import sqlite3, os, re, json

# Firefox profile：跟随当前用户 APPDATA，并自动挑选最近使用的 profile
FF_ROOT = os.path.join(os.environ.get("APPDATA", ""), "Mozilla", "Firefox", "Profiles")
_cands = [os.path.join(FF_ROOT, d) for d in (os.listdir(FF_ROOT) if os.path.isdir(FF_ROOT) else [])
          if os.path.exists(os.path.join(FF_ROOT, d, "cookies.sqlite"))]
FF = max(_cands, key=lambda d: os.path.getmtime(os.path.join(d, "cookies.sqlite"))) if _cands else FF_ROOT
print(f"profile = {FF}")

def q(db, sql, args=()):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, args).fetchall()]
    finally:
        con.close()

# 1) 历史记录中的智慧树 URL
places = os.path.join(FF, "places.sqlite")
rows = q(places, """
    SELECT p.url, p.title, p.visit_count, p.last_visit_date
    FROM moz_places p
    WHERE p.url LIKE '%zhihuishu%' OR p.url LIKE '%polymas%' OR p.title LIKE '%智慧树%'
    ORDER BY p.last_visit_date DESC
""")

print(f"=== zhihuishu history entries: {len(rows)} ===")
ids = {}
for r in rows[:120]:
    u = r["url"]
    print(f"- {u}")
    print(f"    title={r['title']!r} visits={r['visit_count']} last={r['last_visit_date']}")
    for key in ("courseId", "recruitId", "userId", "uid", "cId", "scId", "paramId", "rid"):
        for m in re.finditer(rf"[?&#/]{key}=([A-Za-z0-9_-]+)", u):
            ids.setdefault(key, set()).add(m.group(1))
    for m in re.finditer(r"#/[a-zA-Z]+/(\d{5,})", u):
        ids.setdefault("pathid", set()).add(m.group(1))

print("\n=== extracted ids ===")
for k, v in ids.items():
    print(f"{k}: {sorted(v)}")

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffcookie", "history-ids.json"), "w", encoding="utf-8") as f:
    json.dump({k: sorted(v) for k, v in ids.items()}, f, ensure_ascii=False, indent=2)

# 2) cookie 过期时间：判断会话是何时失效的
cookies = q(os.path.join(FF, "cookies.sqlite"),
            "SELECT host,name,expiry,lastAccessed,creationTime FROM moz_cookies WHERE host LIKE '%zhihuishu%' ORDER BY lastAccessed DESC")
print("\n=== cookie timestamps (top 8 by lastAccessed) ===")
import datetime
def ts(v):
    if not v: return None
    try:
        return datetime.datetime.fromtimestamp(v / 1000000).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return v
for c in cookies[:8]:
    print(f"{c['host']:42s} {c['name']:28s} last={ts(c['lastAccessed'])} created={ts(c['creationTime'])} expires={ts(c['expiry'])}")

# 3) 表单历史里是否有智慧树相关输入（仅看字段名与域名，不打印值）
try:
    fh = q(places.replace("places.sqlite", "formhistory.sqlite"),
           "SELECT fieldname, timesUsed FROM moz_formhistory")
    print(f"\n=== form history fields: {len(fh)} ===")
    for r in fh[:40]:
        print(f"   {r['fieldname']}  used={r['timesUsed']}")
except Exception as e:
    print("formhistory:", e)
