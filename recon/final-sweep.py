import os, json, sqlite3, re

print("=== 全盘搜索其他凭据库 ===")
roots = [
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\User Data"),
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data"),
    os.path.expandvars(r"%APPDATA%\Opera Software"),
    os.path.expandvars(r"%LOCALAPPDATA%\BraveSoftware"),
    os.path.expandvars(r"%APPDATA%\Mozilla\Firefox\Profiles"),
]
for root in roots:
    if not os.path.exists(root):
        print(f"[missing] {root}")
        continue
    hits = []
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            if fn.lower() in ("login data", "logins.json", "cookies.sqlite", "cookies"):
                hits.append(os.path.join(dirpath, fn))
    print(f"[{root}] credential files: {len(hits)}")
    for h in hits:
        print("   ", h)

# Edge / Chrome Login Data 里是否有 zhihuishu
print("\n=== Edge/Chrome saved passwords matching zhihuishu ===")
for root in roots[:4]:
    if not os.path.exists(root):
        continue
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            if fn.lower() == "login data":
                p = os.path.join(dirpath, fn)
                try:
                    con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
                    con.row_factory = sqlite3.Row
                    rows = con.execute("SELECT origin_url, username_value, length(password_value) AS plen FROM logins WHERE origin_url LIKE '%zhihuishu%' OR origin_url LIKE '%polymas%'").fetchall()
                    print(f"[{p}] matches={len(rows)}")
                    for r in rows:
                        print(f"    origin={r['origin_url']} user={r['username_value']} pwd_len={r['plen']}")
                    con.close()
                except Exception as e:
                    print(f"[{p}] ERROR {e}")

# Windows 凭据管理器是否列出相关条目
print("\n=== Firefox 全 profile 的 logins.json 主机名汇总（找教育/学校相关）===")
FF = os.path.expandvars(r"%APPDATA%\Mozilla\Firefox\Profiles")
if os.path.exists(FF):
    for prof in os.listdir(FF):
        p = os.path.join(FF, prof, "logins.json")
        if os.path.exists(p):
            try:
                data = json.load(open(p, encoding="utf-8"))
                hosts = [l.get("hostname", "") for l in data.get("logins", [])]
                edu = [h for h in hosts if re.search(r"edu|zhs|zhihui|polymas|school|univ|college", h, re.I)]
                print(f"[{prof}] total={len(hosts)} edu-related={edu}")
            except Exception as e:
                print(f"[{prof}] ERROR {e}")
