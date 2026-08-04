import sys, json, io
spec = json.load(open(sys.argv[1], encoding="utf-8"))
for e in spec:
    p = e["file"]
    raw = io.open(p, encoding="utf-8", newline="").read()
    crlf = raw.count("\r\n") > raw.count("\n") // 2
    s = raw.replace("\r\n", "\n")
    old, new = e["old"], e["new"]
    want = e.get("count", 1)
    n = s.count(old)
    if n != want:
        print("FAIL %s: found %d, wanted %d for:\n%s" % (p, n, want, old[:300]))
        sys.exit(1)
    s = s.replace(old, new)
    if crlf:
        s = s.replace("\n", "\r\n")
    io.open(p, "w", encoding="utf-8", newline="").write(s)
    print("ok %s (%d) crlf=%s" % (p, n, crlf))
