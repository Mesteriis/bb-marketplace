#!/usr/bin/env python3
"""Remote Hub SSH integration against a throwaway sshd container.

Drives the real helper binary over stdio. Requires docker. If docker is not
available, exits with code 3 and prints "not run"."""
import hashlib
import json
import os
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import time

HELPER = os.environ.get("REMOTE_HUB_HELPER", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "bin", "remote-hub-helper"))
IMAGE = "remote-hub-sshd-test"
NOT_RUN = 3

# Every helper spawned by this run, so the driver can tear them down on any
# exit path (success, failure, or Ctrl+C) and never leave a stray process.
_HELPERS = []


def docker_available():
    try:
        subprocess.check_call(["docker", "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        return True
    except Exception:
        return False


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def enc_control(msg):
    body = b"\x01" + json.dumps(msg).encode()
    return struct.pack("<I", len(body)) + body


def enc_stream(session_id, seq, data):
    body = b"\x02" + struct.pack("<II", session_id, seq) + data
    return struct.pack("<I", len(body)) + body


def sha256_file(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


class Helper:
    def __init__(self, argv=None):
        cmd = [HELPER] + (argv if argv else [])
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        _HELPERS.append(self)
        self.seq = 0
        self.send({"type": "hello", "protocol": 1})
        ack = self.read_control()
        assert ack["type"] == "hello_ack", ack

    def send(self, msg):
        self.p.stdin.write(enc_control(msg))
        self.p.stdin.flush()

    def _read_exact(self, n, timeout):
        fd = self.p.stdout.fileno()
        buf = b""
        deadline = time.time() + timeout
        while len(buf) < n and time.time() < deadline:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            ready, _, _ = select.select([fd], [], [], remaining)
            if not ready:
                break
            try:
                chunk = os.read(fd, n - len(buf))
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
        return buf

    def read_frame(self, timeout=2.0):
        hdr = self._read_exact(4, timeout)
        if len(hdr) < 4:
            return None
        ln = struct.unpack("<I", hdr)[0]
        body = self._read_exact(ln, timeout)
        if len(body) < ln:
            return None
        return body[0], body[1:]

    def read_control(self, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            f = self.read_frame(timeout=deadline - time.time())
            if f is None:
                return None
            kind, payload = f
            if kind == 0x01:
                return json.loads(payload)
        return None

    def open_ssh(self, argv, cols=80, rows=24):
        self.send({
            "type": "session.open_ssh",
            "id": 100,
            "cols": cols,
            "rows": rows,
            "program": "/usr/bin/ssh",
            "argv": argv,
            "env": {"TERM": "xterm-256color"},
            "cwd": None,
        })
        resp = self.read_control()
        assert resp["type"] == "session.opened", resp
        return resp["sessionId"], resp["pid"]

    def credit(self, sid, n):
        self.send({"type": "session.credit", "id": 200, "sessionId": sid, "bytes": n})
        resp = self.read_control()
        assert resp["type"] == "session.credit_ack", resp

    def input_bytes(self, sid, data):
        self.p.stdin.write(enc_stream(sid, self.seq, data))
        self.p.stdin.flush()
        self.seq += 1

    def read_until(self, sid, needle, timeout=10):
        buf = b""
        deadline = time.time() + timeout
        while time.time() < deadline:
            f = self.read_frame(timeout=deadline - time.time())
            if f is None:
                return buf
            kind, payload = f
            if kind == 0x02 and len(payload) >= 8:
                rsid = struct.unpack("<II", payload[:8])[0]
                if rsid == sid:
                    buf += payload[8:]
                    if needle in buf:
                        return buf
        return buf

    def read_until_any(self, needles, timeout=10):
        """Read stream frames until every sid's needle is present."""
        bufs = {sid: b"" for sid in needles}
        deadline = time.time() + timeout
        while time.time() < deadline:
            f = self.read_frame(timeout=deadline - time.time())
            if f is None:
                break
            kind, payload = f
            if kind == 0x02 and len(payload) >= 8:
                rsid = struct.unpack("<II", payload[:8])[0]
                if rsid in bufs:
                    bufs[rsid] += payload[8:]
            if all(needles[sid] in bufs[sid] for sid in needles):
                break
        return bufs

    def read_until_closed(self, sid, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            f = self.read_frame(timeout=deadline - time.time())
            if f is None:
                return None
            kind, payload = f
            if kind == 0x01:
                msg = json.loads(payload)
                if msg.get("type") == "session.closed" and msg.get("sessionId") == sid:
                    return msg
        return None

    def collect_until_closed(self, sid, timeout=15):
        """Return (stream_bytes_for_sid, closed_control) draining to close."""
        buf = b""
        deadline = time.time() + timeout
        while time.time() < deadline:
            f = self.read_frame(timeout=deadline - time.time())
            if f is None:
                break
            kind, payload = f
            if kind == 0x01:
                msg = json.loads(payload)
                if msg.get("type") == "session.closed" and msg.get("sessionId") == sid:
                    return buf, msg
            elif kind == 0x02 and len(payload) >= 8:
                rsid = struct.unpack("<II", payload[:8])[0]
                if rsid == sid:
                    buf += payload[8:]
        return buf, None

    def kill(self):
        self.p.send_signal(signal.SIGKILL)

    def terminate(self):
        try:
            self.p.kill()
        except Exception:
            pass
        try:
            self.p.wait(timeout=2)
        except Exception:
            pass

    def wait(self):
        return self.p.wait()


def ssh_argv(port, key, known_hosts, cfg):
    return [
        "ssh", "-tt",
        "-F", cfg,
        "-o", "UserKnownHostsFile=" + known_hosts,
        "-i", key,
        "-o", "IdentitiesOnly=yes",
        "-p", str(port),
        "--", "root@127.0.0.1",
    ]


def main():
    if not docker_available():
        print("not run")
        return NOT_RUN

    helper = os.path.abspath(HELPER)
    if not os.path.exists(helper):
        print("helper binary missing at", helper)
        return NOT_RUN

    tmp = subprocess.check_output(["mktemp", "-d"]).decode().strip()
    cid = None
    try:
        subprocess.check_call(["docker", "build", "-q", "-t", IMAGE, os.path.dirname(os.path.abspath(__file__))], stdout=subprocess.DEVNULL)
        key = os.path.join(tmp, "id_ed25519")
        subprocess.check_call(["ssh-keygen", "-t", "ed25519", "-N", "", "-f", key, "-q"])
        port = free_port()
        cid = subprocess.check_output(["docker", "run", "-d", "-p", f"127.0.0.1:{port}:22", IMAGE]).decode().strip()
        with open(key + ".pub") as f:
            pubkey = f.read().encode()
        subprocess.run(
            ["docker", "exec", "-i", cid, "sh", "-c", "mkdir -p /root/.ssh && cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"],
            input=pubkey, check=True,
        )
        time.sleep(2)
        hostkey = subprocess.check_output(["docker", "exec", cid, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"]).decode().strip()

        known_hosts = os.path.join(tmp, "known_hosts")
        with open(known_hosts, "w") as f:
            f.write(f"[127.0.0.1]:{port} {hostkey}\n")
        cfg = os.path.join(tmp, "config")
        with open(cfg, "w") as f:
            f.write("Host rh\n")

        cases(tmp, port, key, known_hosts, cfg)
        print("integration ok")
        return 0
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
    finally:
        for hp in _HELPERS:
            hp.terminate()
        if cid is not None:
            subprocess.call(["docker", "rm", "-f", cid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(tmp, ignore_errors=True)


def cases(tmp, port, key, known_hosts, cfg):
    def mark(n):
        print('case ' + n, flush=True)

    mark('1')
    # Case 1: key auth, echo a UTF-8 line.
    h = Helper()
    sid, _pid = h.open_ssh(ssh_argv(port, key, known_hosts, cfg))
    h.credit(sid, 1 << 20)
    h.input_bytes(sid, b"printf 'h\xc3\xa9llo-%s\n' ok\n")
    out = h.read_until(sid, b"h\xc3\xa9llo-ok")
    assert b"h\xc3\xa9llo-ok" in out, out

    mark('2')
    # Case 2: resize to 100x30.
    h.send({"type": "session.resize", "id": 400, "sessionId": sid, "cols": 100, "rows": 30})
    h.read_control()
    h.input_bytes(sid, b"stty size\n")
    out = h.read_until(sid, b"30 100")
    assert b"30 100" in out, out

    mark('3')
    # Case 3: Ctrl+C (byte 0x03) interrupts sleep 300.
    h.input_bytes(sid, b"sleep 300\n")
    time.sleep(1.0)
    h.input_bytes(sid, b"\x03")
    time.sleep(0.5)
    h.input_bytes(sid, b"echo after-int\n")
    out = h.read_until(sid, b"after-int", timeout=10)
    assert b"after-int" in out, out

    mark('4')
    # Case 4: remote "exit 7" propagates through the real PTY to ssh's exit code.
    h.input_bytes(sid, b"exit 7\n")
    closed = h.read_until_closed(sid)
    assert closed is not None and closed.get("exitCode") == 7, closed

    mark('5')
    # Case 5: unknown host key (empty known_hosts). ssh's own prompt appears; a
    # remote command typed before answering must not run; answering no closes
    # with exit 255 and the empty known_hosts file stays empty.
    empty_kh = os.path.join(tmp, "empty_known_hosts")
    open(empty_kh, "w").close()
    h5 = Helper()
    sid5, _pid5 = h5.open_ssh(ssh_argv(port, key, empty_kh, cfg))
    h5.credit(sid5, 1 << 20)
    out5 = h5.read_until(sid5, b"Are you sure you want to continue connecting", timeout=15)
    assert b"Are you sure you want to continue connecting" in out5, out5
    # The remote shell must not have started: a successful login prints the
    # Alpine motd and a shell prompt, and neither may appear before answering.
    assert b"Welcome to Alpine" not in out5, out5
    assert b"~#" not in out5, out5
    h5.input_bytes(sid5, b"no\n")
    collected5, closed5 = h5.collect_until_closed(sid5)
    assert closed5 is not None and closed5.get("exitCode") == 255, closed5
    assert closed5.get("reason") == "ssh_error", closed5
    assert b"Welcome to Alpine" not in collected5, collected5
    assert os.path.getsize(empty_kh) == 0

    mark('6')
    # Case 6: changed host key. ssh refuses with exit 255 and the seeded
    # known_hosts file is byte-identical afterwards.
    changed_kh = os.path.join(tmp, "changed_known_hosts")
    other_key = os.path.join(tmp, "other_host_key")
    subprocess.check_call(["ssh-keygen", "-t", "ed25519", "-N", "", "-f", other_key, "-q"])
    with open(other_key + ".pub") as f:
        other_pub = f.read().strip()
    with open(changed_kh, "w") as f:
        f.write(f"[127.0.0.1]:{port} {other_pub}\n")
    before = sha256_file(changed_kh)
    h6 = Helper()
    sid6, _pid6 = h6.open_ssh(ssh_argv(port, key, changed_kh, cfg))
    h6.credit(sid6, 1 << 20)
    out6 = h6.read_until(sid6, b"REMOTE HOST IDENTIFICATION HAS CHANGED", timeout=15)
    assert b"REMOTE HOST IDENTIFICATION HAS CHANGED" in out6, out6
    closed6 = h6.read_until_closed(sid6)
    assert closed6 is not None and closed6.get("exitCode") == 255, closed6
    assert sha256_file(changed_kh) == before

    mark('7')
    # Case 7: two parallel sessions, each echoing only its own marker, then A
    # runs yes with its credit drained to zero while B still answers.
    h7 = Helper()
    sa, _pa = h7.open_ssh(ssh_argv(port, key, known_hosts, cfg))
    sb, _pb = h7.open_ssh(ssh_argv(port, key, known_hosts, cfg))
    h7.credit(sa, 2048)
    h7.credit(sb, 1 << 20)
    h7.input_bytes(sa, b"printf 'marker-A\n'\n")
    h7.input_bytes(sb, b"printf 'marker-B\n'\n")
    bufs = h7.read_until_any({sa: b"marker-A", sb: b"marker-B"}, timeout=10)
    assert b"marker-A" in bufs[sa] and b"marker-B" not in bufs[sa], bufs
    assert b"marker-B" in bufs[sb] and b"marker-A" not in bufs[sb], bufs
    h7.input_bytes(sa, b"yes\n")
    time.sleep(0.5)
    h7.input_bytes(sb, b"echo b-alive\n")
    outb2 = h7.read_until(sb, b"b-alive", timeout=2)
    assert b"b-alive" in outb2, outb2

    mark('8')
    # Case 8: SIGKILL the helper mid-session; within 5 s no ssh child that was
    # recorded before the kill remains (the PTY master close hangs it up).
    h8 = Helper()
    sid8, pid8 = h8.open_ssh(ssh_argv(port, key, known_hosts, cfg))
    h8.credit(sid8, 1 << 20)
    h8.input_bytes(sid8, b"sleep 300\n")
    time.sleep(0.5)
    h8.kill()
    deadline = time.time() + 5
    alive = True
    while time.time() < deadline:
        try:
            os.kill(pid8, 0)
            time.sleep(0.1)
        except OSError:
            alive = False
            break
    assert not alive, f"ssh child {pid8} still alive after helper SIGKILL"


if __name__ == "__main__":
    sys.exit(main())
