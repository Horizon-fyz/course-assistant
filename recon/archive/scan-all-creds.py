import sqlite3, os, json, glob

def q(db, sql, args=()):
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        rows = con.execute(sql, args).fetchall()
        con.close()
        return [dict(r) for r in rows]
    except Exception as e:
        return [{"__error__": str(e)}]

def scan_cookie_db(label, db):
    if not os.path.exists(db):
        print(f"[{label}] no file")
        return
    print(f"\n[{label}] {db}")
    rows = q(db, "SELECT host,name,value,path,isSecure,isHttpOnly,expiry FROM moz_cookies WHERE host LIKE '%zhihuishu%' OR host LIKE '%polymas%'")
    if rows and "__error__" in rows[0]:
        print("   ERROR:", rows[0]["__error__"])
        return
    print(f"   zhihuishu/polymas cookies: {len(rows)}")
    for r in sorted(rows, key=lambda x: (x["host"], x["name"])):
        val = r["value"] or ""
        print(f"   {r['host']:45s} {r['name']:35s} len={len(val):5d} secure={r['isSecure']} httpOnly={r['isHttpOnly']}")

# 一律跟随当前用户的环境变量，不写死用户名与 profile 哈希
FF = os.path.expandvars(r"%APPDATA%\Mozilla\Firefox\Profiles")
if os.path.isdir(FF):
    for prof in os.listdir(FF):
        scan_cookie_db(f"FF:{prof}", os.path.join(FF, prof, "cookies.sqlite"))

FF_LOCAL = os.path.expandvars(r"%LOCALAPPDATA%\Mozilla\Firefox\Profiles")
if os.path.isdir(FF_LOCAL):
    for prof in os.listdir(FF_LOCAL):
        scan_cookie_db(f"FF-local:{prof}", os.path.join(FF_LOCAL, prof, "cookies.sqlite"))

# Firefox 保存的登录账号（只看有没有，不打印密码）
print("\n=== Firefox saved logins (logins.json) ===")
for prof in (os.listdir(FF) if os.path.isdir(FF) else []):
    p = os.path.join(FF, prof, "logins.json")
    if not os.path.exists(p):
        print(f"[{prof}] no logins.json")
        continue
    try:
        data = json.load(open(p, encoding="utf-8"))
        logins = data.get("logins", [])
        print(f"[{prof}] {len(logins)} saved logins")
        for lg in logins:
            host = lg.get("hostname", "")
            print(f"   hostname={host}  hasUsername={'usernameField' in lg}  hasPassword={'passwordField' in lg}")
    except Exception as e:
        print(f"[{prof}] ERROR {e}")

# Edge cookie 库（加密，这里只列数量与是否含 zhihuishu 主机名）
print("\n=== Edge cookies ===")
edge = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Network\Cookies")
if os.path.exists(edge):
    rows = q(edge, "SELECT host_key,name,length(encrypted_value) AS elen,is_secure,is_httponly FROM cookies WHERE host_key LIKE '%zhihuishu%' OR host_key LIKE '%polymas%'")
    if rows and "__error__" in rows[0]:
        print("   ERROR:", rows[0]["__error__"])
    else:
        print(f"   zhihuishu/polymas cookies: {len(rows)}")
        for r in sorted(rows, key=lambda x: (x["host_key"], x["name"])):
            print(f"   {r['host_key']:45s} {r['name']:35s} enc_len={r['elen']}")
else:
    print("   no Edge cookie db")
