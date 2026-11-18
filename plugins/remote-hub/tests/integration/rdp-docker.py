#!/usr/bin/env python3
"""Remote Hub RDP integration against a throwaway xrdp container.

Drives the real helper binary over stdio. Requires docker. If docker is not
available, exits with code 3 and prints "not run"."""
import base64, hashlib, json, os, select, shutil, signal, socket, struct, subprocess, sys, time

HELPER = os.environ.get("REMOTE_HUB_HELPER", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "bin", "remote-hub-helper"))
IMAGE = "remote-hub-rdp-test"
NOT_RUN = 3

_HELPERS = []

def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

def wait_pid_gone(pid, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not pid_alive(pid): return True
        time.sleep(0.05)
    return not pid_alive(pid)

def png_pixels(png_bytes):
    """Decode an 8-bit RGBA, non-interlaced PNG into (width, height, rows)."""
    import zlib
    assert png_bytes[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat, width, height = 8, b"", 0, 0
    while pos < len(png_bytes):
        ln, = struct.unpack(">I", png_bytes[pos:pos + 4]); typ = png_bytes[pos + 4:pos + 8]
        data = png_bytes[pos + 8:pos + 8 + ln]; pos += 12 + ln
        if typ == b"IHDR":
            width, height, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", data)
            assert (depth, ctype, interlace) == (8, 6, 0), "expected 8-bit RGBA, non-interlaced"
        elif typ == b"IDAT": idat += data
    raw = zlib.decompress(idat); bpp = 4; stride = width * bpp
    rows, prev = [], bytearray(stride)
    for y in range(height):
        f = raw[y * (stride + 1)]; line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0; b = prev[i]; c = prev[i - bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line); prev = line
    return width, height, rows

def distinct_pixels(png_bytes):
    w, h, rows = png_pixels(png_bytes)
    return len({bytes(r[x * 4:x * 4 + 4]) for r in rows for x in range(w)})

def docker_available():
    try:
        subprocess.check_call(["docker", "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        return True
    except Exception:
        return False

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close(); return port

def enc_control(msg):
    body = b"\x01" + json.dumps(msg).encode()
    return struct.pack("<I", len(body)) + body

def sha256_file(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()

class Helper:
    def __init__(self):
        self.trace = []  # every control message read, in order
        self.p = subprocess.Popen([HELPER], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        _HELPERS.append(self)
        self.send({"type": "hello", "protocol": 3})
        ack = self.read_control()
        assert ack["type"] == "hello_ack", ack

    def send(self, msg):
        self.p.stdin.write(enc_control(msg)); self.p.stdin.flush()

    def _read_exact(self, n, timeout):
        fd = self.p.stdout.fileno(); buf = b""; deadline = time.time() + timeout
        while len(buf) < n and time.time() < deadline:
            ready, _, _ = select.select([fd], [], [], max(0, deadline - time.time()))
            if not ready: break
            try: chunk = os.read(fd, n - len(buf))
            except OSError: break
            if not chunk: break
            buf += chunk
        return buf

    def read_frame(self, timeout=2.0):
        hdr = self._read_exact(4, timeout)
        if len(hdr) < 4: return None
        ln = struct.unpack("<I", hdr)[0]
        body = self._read_exact(ln, timeout)
        if len(body) < ln: return None
        return body[0], body[1:]

    def read_control(self, timeout=10.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            f = self.read_frame(timeout=deadline - time.time())
            if f is None: return None
            kind, payload = f
            if kind == 0x01:
                msg = json.loads(payload)
                self.trace.append(msg)
                return msg
        return None

    def states(self):
        """The rdp.state names seen so far, in order. Picture counters travel as `stats ...` lines on the same message
        type; they are measurements whose number and timing depend on the traffic, not states, so they are left out."""
        return [m["state"] for m in self.trace if m.get("type") == "rdp.state" and not m["state"].startswith("stats ")]

    def stats_lines(self):
        return [m["state"] for m in self.trace if m.get("type") == "rdp.state" and m["state"].startswith("stats ")]

    def open_rdp(self, host, port, user, password, width=800, height=600, expected=None, options=None):
        request = {"type": "session.open_rdp", "id": 100, "host": host, "port": port,
                   "username": user, "password": password, "domain": None,
                   "width": width, "height": height, "expectedFingerprint": expected}
        if options is not None:
            request["options"] = options
        self.send(request)
        resp = self.read_control()
        assert resp["type"] == "session.opened", resp
        return resp["sessionId"], resp["pid"]

    def cert_decision(self, sid, fp, accept):
        self.send({"type": "rdp.cert_decision", "id": 200, "sessionId": sid, "fingerprint": fp, "accept": accept})
        return self.read_control()

    def input(self, sid, events):
        self.send({"type": "rdp.input", "id": 300, "sessionId": sid, "events": events})
        return self.read_control()

    def screenshot(self, sid):
        self.send({"type": "rdp.screenshot", "id": 400, "sessionId": sid})
        deadline = time.time() + 10
        while time.time() < deadline:
            resp = self.read_control(timeout=deadline - time.time())
            if resp is None: return None
            if resp.get("type") == "rdp.screenshot": return resp
        return None

    def read_until(self, pred, timeout=20.0):
        """Read control frames until pred(msg) is true; returns the matching msg."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            f = self.read_frame(timeout=deadline - time.time())
            if f is None: return None
            kind, payload = f
            if kind == 0x01:
                m = json.loads(payload)
                self.trace.append(m)
                if pred(m): return m
        return None

    def kill(self):
        self.p.send_signal(signal.SIGKILL)

    def terminate(self):
        try: self.p.kill()
        except Exception: pass
        try: self.p.wait(timeout=2)
        except Exception: pass

    def terminate_and_check_engines(self, pids):
        """Kill the helper hard and require its engines to end on their own
        (they must not rely on anyone cleaning up after a SIGKILLed helper)."""
        self.terminate()
        for pid in pids:
            assert wait_pid_gone(pid, 5), "engine %d outlived its killed helper" % pid

    def wait(self):
        return self.p.wait()

def key_seq(text):
    """scancode down/up events for a lowercase US string ('\\n' is Enter)."""
    SC = {c: sc for c, sc in zip("abcdefghijklmnopqrstuvwxyz", [
        0x1e,0x30,0x2e,0x20,0x12,0x21,0x22,0x23,0x17,0x24,0x25,0x26,0x32,0x31,0x18,0x19,0x10,0x13,0x1f,0x14,0x16,0x2f,0x11,0x2d,0x15,0x2c])}
    SC["-"] = 0x0c
    SC["\n"] = 0x1c
    events = []
    for ch in text:
        sc = SC[ch]
        events.append({"kind":"key","scancode":sc,"extended":False,"down":True})
        events.append({"kind":"key","scancode":sc,"extended":False,"down":False})
    return events

def main():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    if not docker_available():
        print("not run"); return NOT_RUN
    helper = os.path.abspath(HELPER)
    if not os.path.exists(helper):
        print("helper binary missing at", helper); return NOT_RUN

    here = os.path.dirname(os.path.abspath(__file__))
    subprocess.check_call(["docker", "build", "-q", "-t", IMAGE, "-f", os.path.join(here, "rdp-Dockerfile"), here], stdout=subprocess.DEVNULL)

    tmp = subprocess.check_output(["mktemp", "-d"]).decode().strip()
    cid = None
    try:
        user = "rdptest"
        password = "pw-" + os.urandom(8).hex()
        port = free_port()
        cid = subprocess.check_output(["docker", "run", "-d",
            "-e", "RDP_USER=" + user, "-e", "RDP_PASSWORD=" + password,
            "-p", "127.0.0.1:%d:3389" % port, IMAGE]).decode().strip()
        # Wait for xrdp to accept TCP connections.
        deadline = time.time() + 60
        while True:
            try:
                socket.create_connection(("127.0.0.1", port), timeout=1).close()
                break
            except OSError:
                assert time.time() < deadline, "xrdp did not come up"
                time.sleep(0.5)
        time.sleep(2)

        cases(tmp, cid, port, user, password)
        print("integration ok")
        return 0
    finally:
        for hp in _HELPERS: hp.terminate()
        if cid is not None:
            subprocess.call(["docker", "rm", "-f", cid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(tmp, ignore_errors=True)

def cert_fingerprint(cid):
    out = subprocess.check_output(["docker", "exec", cid, "openssl", "x509", "-in", "/etc/xrdp/cert.pem", "-noout", "-fingerprint", "-sha256"]).decode()
    return out.strip().split("=", 1)[1]

def dexec(cid, user, *cmd, env=None):
    args = ["docker", "exec"]
    if user: args += ["-u", user]
    for k, v in (env or {}).items(): args += ["-e", "%s=%s" % (k, v)]
    r = subprocess.run(args + [cid] + list(cmd), capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr

def wait_session(cid, user, timeout=60):
    """Wait until the user's X session (the xterm of startwm.sh) is running."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if dexec(cid, None, "pgrep", "-u", user, "xterm")[0] == 0: return
        time.sleep(0.5)
    raise AssertionError("the xrdp X session never started (no xterm for %s)" % user)

def poll(fn, timeout, what):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last: return last
        time.sleep(0.3)
    raise AssertionError("timed out: " + what + " (last: %r)" % (last,))

def no_password_in(helper, password, what):
    blob = json.dumps(helper.trace)
    assert password not in blob, "password literal in %s output" % what

def cases(tmp, cid, port, user, password):
    def mark(n): print("case " + n, flush=True)
    fp = cert_fingerprint(cid)
    DISPLAY = {"DISPLAY": ":10"}

    mark("1")
    # Case 1: strict validation -> cert_prompt with the container's fingerprint,
    # the real endpoint and a stable reason code; the state trace shows no
    # `authenticating` before the decision.
    h = Helper()
    sid, pid = h.open_rdp("127.0.0.1", port, user, password)
    prompt = h.read_until(lambda m: m.get("type") == "rdp.cert_prompt", timeout=30)
    assert prompt is not None, "expected cert_prompt"
    assert prompt["fingerprint"] == fp, (prompt["fingerprint"], fp)
    assert (prompt["host"], prompt["port"]) == ("127.0.0.1", port), prompt
    assert prompt["reason"] == "untrusted_root", prompt
    assert h.states() == ["connecting", "tls", "cert_prompt"], h.states()

    mark("2")
    # Case 2: accept once -> desktop_ready; the presented certificate is reported
    # (not validated); the screenshot decodes to 800x600 with > 16 distinct pixels.
    h.cert_decision(sid, fp, "once")
    desktop = h.read_until(lambda m: m.get("type") == "rdp.desktop", timeout=30)
    assert desktop is not None, "expected desktop_ready"
    certs = [m for m in h.trace if m.get("type") == "rdp.certificate"]
    assert certs and certs[0]["fingerprint"] == fp and certs[0]["validated"] is False, certs
    assert h.states().index("authenticating") > h.states().index("cert_prompt"), h.states()
    wait_session(cid, user)
    time.sleep(2)
    shot = h.screenshot(sid)
    assert shot is not None, "expected screenshot"
    png = base64.b64decode(shot["png"])
    assert shot["width"] == 800 and shot["height"] == 600, shot
    w, hgt, _ = png_pixels(png)
    assert (w, hgt) == (800, 600), (w, hgt)
    assert distinct_pixels(png) > 16, "screenshot is (nearly) a single colour"

    mark("3")
    # Case 3: type `hello-rdp` + Enter via scancodes -> /tmp/typed.txt. There
    # is no window manager, so keys go to the window under the pointer: put the
    # pointer over the xterm (at +410+0) first.
    geom = {"geom_width": 800, "geom_height": 600}
    h.input(sid, [dict(kind="mouse_move", x=500, y=100, **geom)])
    poll(lambda: dexec(cid, user, "xdotool", "getmouselocation", env=DISPLAY)[1].startswith("x:500 y:100"), 10, "pointer over xterm")
    h.input(sid, key_seq("hello-rdp\n"))
    typed = poll(lambda: dexec(cid, user, "cat", "/tmp/typed.txt")[1], 10, "typed.txt")
    assert typed == "hello-rdp\n", repr(typed)

    mark("4")
    # Case 4: pointer move to framebuffer (200,150), then a left click inside
    # the xev window at +0+0 (400x300), whose log records the ButtonPress.
    h.input(sid, [dict(kind="mouse_move", x=200, y=150, **geom)])
    loc = poll(lambda: dexec(cid, user, "xdotool", "getmouselocation", env=DISPLAY)[1].startswith("x:200 y:150") and True, 10, "mouse location")
    h.input(sid, [dict(kind="mouse_button", button="left", down=True, x=200, y=150, **geom),
                  dict(kind="mouse_button", button="left", down=False, x=200, y=150, **geom)])
    log = poll(lambda: dexec(cid, None, "cat", "/tmp/xev.log")[1] if "ButtonPress" in dexec(cid, None, "cat", "/tmp/xev.log")[1] else "", 10, "xev ButtonPress")
    assert "button 1" in log and "ButtonRelease" in log, log

    mark("9")
    # Case 9: disconnect does not log the user off: after session.close the
    # session's xterm still runs.
    h.send({"type": "session.close", "id": 900, "sessionId": sid})
    closed9 = h.read_until(lambda m: m.get("type") == "session.closed", timeout=10)
    assert closed9 is not None and closed9["reason"] == "killed_by_close", closed9
    assert wait_pid_gone(pid, 5), "engine survived session.close"
    time.sleep(2)
    assert dexec(cid, None, "pgrep", "-u", user, "xterm")[0] == 0, "the user's session was logged off"
    no_password_in(h, password, "session 1")
    h.terminate()

    mark("5")
    # Case 5: wrong password. SKIPPED, with proven evidence: xrdp (TLS-only
    # security, no NLA) does not authenticate at the RDP protocol level. The
    # connection reaches desktop_ready and xrdp then runs its OWN login against
    # PAM, showing a "login failed" screen inside the desktop. So no
    # protocol-level `auth_failed` can be produced against xrdp. The mapping of
    # CredSSP / AccessDenied failures to `auth_failed` is covered by the literal
    # unit tests in helper/src/rdp/mapping.rs, and Windows NLA by
    # docs/rdp-windows-check.md. The probe below keeps the stated reason true:
    # if xrdp ever starts failing at the protocol level this case must be enabled.
    h5 = Helper()
    sid5, pid5 = h5.open_rdp("127.0.0.1", port, user, "wrong-" + password)
    assert h5.read_until(lambda m: m.get("type") == "rdp.cert_prompt", timeout=30) is not None
    h5.cert_decision(sid5, fp, "once")
    outcome5 = h5.read_until(lambda m: m.get("type") in ("session.closed", "rdp.desktop"), timeout=30)
    assert outcome5 is not None and outcome5["type"] == "rdp.desktop", ("xrdp now fails at protocol level: enable case 5", outcome5)
    assert h5.states() == ["connecting", "tls", "cert_prompt", "authenticating"], h5.states()
    sesman = poll(lambda: dexec(cid, None, "sh", "-c", "grep -c 'pam_authenticate failed' /var/log/xrdp-sesman.log")[1].strip() not in ("", "0"),
                  15, "xrdp's own PAM login failure")
    no_password_in(h5, "wrong-" + password, "session 5")
    print("case 5 skipped: xrdp does not authenticate at the RDP protocol level; a wrong password reaches "
          "desktop_ready and fails in xrdp's own PAM login (xrdp-sesman.log: pam_authenticate failed)", flush=True)
    h5.terminate()

    mark("6")
    # Case 6: expectedFingerprint of a different certificate -> closed
    # cert_changed, no `authenticating` and no prompt.
    h6 = Helper()
    wrong_fp = "00" + fp[2:]
    sid6, pid6 = h6.open_rdp("127.0.0.1", port, user, password, expected=wrong_fp)
    closed6 = h6.read_until(lambda m: m.get("type") == "session.closed", timeout=30)
    assert closed6 is not None and closed6.get("reason") == "cert_changed", closed6
    assert h6.states() == ["connecting", "tls"], h6.states()
    no_password_in(h6, password, "session 6")
    print("case 6b and case 8 run through the real service in tests/integration/rdp-service.test.ts: a trusted "
          "certificate replaced on a trusted host:port yields a prompt with reason cert_changed (trust lives in "
          "src/core/rdp-trust.ts), and two views of one session are multiplexed by src/core/rdp-views.ts.", flush=True)
    h6.terminate()

    mark("6a")
    # Case 6a: expectedFingerprint of THIS (self-signed, failing-validation)
    # certificate -> connects with no prompt; the certificate is still reported
    # as not validated.
    h6a = Helper()
    sid6a, pid6a = h6a.open_rdp("127.0.0.1", port, user, password, expected=fp)
    desktop6a = h6a.read_until(lambda m: m.get("type") == "rdp.desktop", timeout=30)
    assert desktop6a is not None, ("pinned match must connect", h6a.states())
    assert "cert_prompt" not in h6a.states(), h6a.states()
    certs6a = [m for m in h6a.trace if m.get("type") == "rdp.certificate"]
    assert certs6a and certs6a[0]["fingerprint"] == fp and certs6a[0]["validated"] is False, certs6a
    no_password_in(h6a, password, "session 6a")
    h6a.terminate()

    mark("P1")
    # Case P1: the connection options are honoured end to end. Each preset connects to the real xrdp, paints, and the
    # stats line carries received bytes. (A server may ignore the effect flags; what is asserted is that the connection
    # works with every option set and that the bytes are counted, so the coordinator can compare them on a real host.)
    PRESETS = {
        "slow": {"compression": True, "colorDepth": 16, "wallpaper": False, "fullWindowDrag": False, "menuAnimations": False, "fontSmoothing": True, "desktopComposition": False, "themes": False},
        "balanced": {"compression": True, "colorDepth": 32, "wallpaper": False, "fullWindowDrag": False, "menuAnimations": False, "fontSmoothing": True, "desktopComposition": False, "themes": True},
        "quality": {"compression": False, "colorDepth": 32, "wallpaper": True, "fullWindowDrag": True, "menuAnimations": True, "fontSmoothing": True, "desktopComposition": True, "themes": True},
        "depth24": {"compression": False, "colorDepth": 24, "wallpaper": True, "fullWindowDrag": True, "menuAnimations": True, "fontSmoothing": True, "desktopComposition": True, "themes": True},
    }
    seen_bytes = {}
    for name, opts in PRESETS.items():
        h8 = Helper()
        sid8, pid8 = h8.open_rdp("127.0.0.1", port, user, password, options=opts)
        assert h8.read_until(lambda m: m.get("type") == "rdp.cert_prompt", timeout=30) is not None, name
        h8.cert_decision(sid8, fp, "once")
        t_decided = time.time()
        assert h8.read_until(lambda m: m.get("type") == "rdp.desktop", timeout=30) is not None, ("desktop with options " + name, h8.states())
        t_desktop = time.time() - t_decided
        def stats_kv(line):
            return dict(p.split("=") for p in line.split()[1:])
        def with_bytes():
            ok = [stats_kv(l) for l in h8.stats_lines() if int(stats_kv(l)["updates"]) > 0 and int(stats_kv(l)["bytes"]) > 0]
            return ok[-1] if ok else None
        # The stats line may already have arrived (with the desktop); otherwise keep reading.
        deadline = time.time() + 20
        kv = with_bytes()
        while kv is None and time.time() < deadline:
            h8.read_until(lambda m: m.get("type") == "rdp.state" and m["state"].startswith("stats "), timeout=max(0.1, deadline - time.time()))
            kv = with_bytes()
        assert kv is not None, ("a stats line with received bytes for " + name, h8.stats_lines(), [(m.get("type"), m.get("state")) for m in h8.trace][-12:])
        # Let the picture settle (the engine flushes its counters every 1.5 s), then read the final numbers.
        h8.read_until(lambda m: False, timeout=4)
        final = [stats_kv(l) for l in h8.stats_lines()][-1]
        seen_bytes[name] = {"desktop_s": round(t_desktop, 2), "updates": int(final["updates"]), "pixels": int(final["pixels"]), "bytes": int(final["bytes"]), "avg": int(final["avg"]), "last_update_ms": int(final["last_ms"])}
        no_password_in(h8, password, "session 8 " + name)
        h8.terminate()
    print("case P1 per preset (xrdp 800x600, after a 4 s settle):", seen_bytes, flush=True)
    # A depth outside the closed set never starts an engine.
    h8b = Helper()
    h8b.send({"type": "session.open_rdp", "id": 101, "host": "127.0.0.1", "port": port, "username": user, "password": password, "domain": None,
              "width": 800, "height": 600, "expectedFingerprint": None, "options": dict(PRESETS["slow"], colorDepth=8)})
    refused = h8b.read_control()
    assert refused["type"] == "error" and refused["code"] == "rdp_invalid_options", refused
    h8b.terminate()

    mark("7")
    # Case 7: kill the container during desktop_ready -> network_error within
    # 10 s, and the engine is gone.
    h7 = Helper()
    sid7, pid7 = h7.open_rdp("127.0.0.1", port, user, password)
    assert h7.read_until(lambda m: m.get("type") == "rdp.cert_prompt", timeout=30) is not None
    h7.cert_decision(sid7, fp, "once")
    h7.read_until(lambda m: m.get("type") == "rdp.desktop", timeout=30)
    t0 = time.time()
    subprocess.run(["docker", "kill", cid], capture_output=True)
    closed7 = h7.read_until(lambda m: m.get("type") == "session.closed", timeout=12)
    assert closed7 is not None and closed7.get("reason") == "network_error", closed7
    assert time.time() - t0 < 10, "network_error took %.1fs" % (time.time() - t0)
    assert wait_pid_gone(pid7, 5), "engine %d still alive after its session closed" % pid7
    # A hard-killed helper must not leave an engine behind either.
    hk = Helper()
    skid, pidk = hk.open_rdp("127.0.0.1", free_port(), user, password)  # refused port: engine ends itself
    hk.terminate_and_check_engines([pidk])

if __name__ == "__main__":
    sys.exit(main())
