#!/usr/bin/env python3
"""Remote Hub SSH integration against a throwaway sshd container.

Drives the real helper binary over stdio. Requires docker. If docker is not
available, exits with code 3 and prints "not run"."""
import json
import os
import random
import shutil
import socket
import struct
import subprocess
import sys
import time

HELPER = os.environ.get("REMOTE_HUB_HELPER", os.path.join(os.path.dirname(__file__), "..", "..", "bin", "remote-hub-helper"))
IMAGE = "remote-hub-sshd-test"
NOT_RUN = 3


def docker_available():
    return shutil.which("docker") is not None


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


class Helper:
    def __init__(self):
        self.p = subprocess.Popen([HELPER], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.seq = 0
        self.send({"type": "hello", "protocol": 1})
        ack = self.read_control()
        assert ack["type"] == "hello_ack", ack
        self.generation = ack["generation"]

    def send(self, msg):
        self.p.stdin.write(enc_control(msg))
        self.p.stdin.flush()

    def read_frame(self):
        hdr = self.p.stdout.read(4)
        if len(hdr) < 4:
            return None
        ln = struct.unpack("<I", hdr)[0]
        body = self.p.stdout.read(ln)
        return body[0], body[1:]

    def read_control(self):
        while True:
            f = self.read_frame()
            if f is None:
                return None
            kind, payload = f
            if kind == 0x01:
                return json.loads(payload)

    def read_stream(self):
        while True:
            f = self.read_frame()
            if f is None:
                return None
            kind, payload = f
            if kind == 0x02:
                sid, seq = struct.unpack("<II", payload[:8])
                return sid, seq, payload[8:]

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
        return resp["sessionId"]

    def credit(self, sid, n):
        self.send({"type": "session.credit", "id": 200, "sessionId": sid, "bytes": n})
        self.read_control()

    def input_bytes(self, sid, data):
        self.p.stdin.write(enc_stream(sid, self.seq, data))
        self.p.stdin.flush()
        self.seq += 1

    def read_until(self, sid, needle, timeout=10):
        buf = b""
        deadline = time.time() + timeout
        while time.time() < deadline:
            r = self.read_stream()
            if r is None:
                return buf
            rsid, _seq, data = r
            if rsid == sid:
                buf += data
                if needle in buf:
                    return buf
        return buf

    def close(self, sid):
        self.send({"type": "session.close", "id": 300, "sessionId": sid})
        while True:
            resp = self.read_control()
            if resp.get("type") == "session.closed":
                return resp


def main():
    if not docker_available():
        print("not run")
        return NOT_RUN

    helper = os.path.abspath(HELPER)
    if not os.path.exists(helper):
        print("helper binary missing at", helper)
        return NOT_RUN

    # Isolated temp dir (never the real ~/.ssh).
    tmp = subprocess.check_output(["mktemp", "-d"]).decode().strip()
    try:
        subprocess.check_call(["docker", "build", "-q", "-t", IMAGE, os.path.dirname(os.path.abspath(__file__))])
        # Generate an ed25519 key.
        key = os.path.join(tmp, "id_ed25519")
        subprocess.check_call(["ssh-keygen", "-t", "ed25519", "-N", "", "-f", key, "-q"])
        port = free_port()
        cid = subprocess.check_output([
            "docker", "run", "-d", "-p", f"127.0.0.1:{port}:22", IMAGE,
        ]).decode().strip()
        try:
            # Install the generated public key for root, then wait for sshd.
            with open(key + ".pub") as f:
                pubkey = f.read().encode()
            subprocess.run(
                ["docker", "exec", "-i", cid, "sh", "-c", "mkdir -p /root/.ssh && cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"],
                input=pubkey,
                check=True,
            )
            time.sleep(2)
            # Seed known_hosts from the container host key.
            hostkey = subprocess.check_output(["docker", "exec", cid, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"]).decode().strip()
            known_hosts = os.path.join(tmp, "known_hosts")
            with open(known_hosts, "w") as f:
                f.write(f"[127.0.0.1]:{port} {hostkey}\n")
            cfg = os.path.join(tmp, "config")
            with open(cfg, "w") as f:
                f.write("Host rh\n  StrictHostKeyChecking yes\n")
            ssh_argv = [
                "ssh", "-tt",
                "-F", cfg,
                "-o", f"UserKnownHostsFile={known_hosts}",
                "-i", key,
                "-o", "IdentitiesOnly=yes",
                "-p", str(port),
                "--", "root@127.0.0.1",
            ]
            cases(cid, ssh_argv, known_hosts)
            print("integration ok")
            return 0
        finally:
            subprocess.call(["docker", "rm", "-f", cid])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def cases(cid, argv, known_hosts):
    # Case 1: key auth, echo a UTF-8 line.
    h = Helper()
    sid = h.open_ssh(argv)
    h.credit(sid, 1 << 20)
    h.input_bytes(sid, b"printf 'h\xc3\xa9llo-%s\n' ok\n")
    out = h.read_until(sid, b"h\xc3\xa9llo-ok")
    assert b"h\xc3\xa9llo-ok" in out, out
    # Case 2: resize to 100x30.
    h.send({"type": "session.resize", "id": 400, "sessionId": sid, "cols": 100, "rows": 30})
    h.read_control()
    h.input_bytes(sid, b"stty size\n")
    out = h.read_until(sid, b"30 100")
    assert b"30 100" in out, out
    # Case 4: remote "exit 7" propagates through the real PTY to ssh's exit code.
    h.input_bytes(sid, b"exit 7\n")
    closed = None
    deadline = time.time() + 10
    while time.time() < deadline:
        resp = h.read_control()
        if resp is not None and resp.get("type") == "session.closed" and resp.get("sessionId") == sid:
            closed = resp
            break
    assert closed is not None, "session never closed"
    assert closed.get("exitCode") == 7, closed
    assert closed.get("reason") == "exited", closed


if __name__ == "__main__":
    sys.exit(main())
