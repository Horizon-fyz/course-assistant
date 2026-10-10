import sqlite3, os, sys

profiles = ['browser-profile-cdp', 'browser-profile-edge', 'browser-profile']
base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

for p in profiles:
    db = os.path.join(base, p, 'Default', 'Network', 'Cookies')
    if not os.path.exists(db):
        print(f'  {p}: 无 cookie 库 ({db})')
        continue
    try:
        con = sqlite3.connect(f"file:{db.replace(chr(92), '/')}?mode=ro", uri=True)
        rows = con.execute("SELECT host_key, name FROM cookies WHERE host_key LIKE '%zhihuishu%'").fetchall()
        con.close()
    except Exception as e:
        print(f'  {p}: 读取失败 {e}')
        continue
    keys = [r for r in rows if any(k in r[1] for k in ('SESSION', 'CASTGC', 'jt-cas', 'token'))]
    print(f'  {p}: 智慧树 cookie {len(rows)} 条，关键票据 {len(keys)} 条')
    for h, n in keys[:10]:
        print(f'      {h:45s} {n}')
