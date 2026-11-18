#!/usr/bin/env python3
"""A throwaway SSH server that offers ONLY keyboard-interactive, with prompts that imitate the
texts OpenSSH writes for a password and for a key passphrase. Every authentication attempt is
logged (method, and that a prompt was shown), so a test can prove which methods a client used.
It never grants access."""
import socket
import sys
import threading

import paramiko

KEY = paramiko.RSAKey.generate(2048)


class Server(paramiko.ServerInterface):
    def get_allowed_auths(self, username):
        return "keyboard-interactive"

    def check_auth_none(self, username):
        print(f"ATTEMPT none user={username}", flush=True)
        return paramiko.AUTH_FAILED

    def check_auth_password(self, username, password):
        print(f"ATTEMPT password user={username}", flush=True)
        return paramiko.AUTH_FAILED

    def check_auth_publickey(self, username, key):
        print(f"ATTEMPT publickey user={username}", flush=True)
        return paramiko.AUTH_FAILED

    def check_auth_interactive(self, username, submethods):
        print(f"ATTEMPT keyboard-interactive user={username}", flush=True)
        query = paramiko.InteractiveQuery("", "")
        query.add_prompt(f"{username}@127.0.0.1's password: ", False)
        query.add_prompt("Enter passphrase for key '/tmp/anything': ", False)
        return query

    def check_auth_interactive_response(self, responses):
        print(f"RESPONSES count={len(responses)}", flush=True)
        return paramiko.AUTH_FAILED


def serve(client):
    transport = paramiko.Transport(client)
    transport.add_server_key(KEY)
    try:
        transport.start_server(server=Server())
        transport.accept(10)
    except Exception as error:  # a client that gives up is normal
        print(f"CLOSED {type(error).__name__}", flush=True)
    finally:
        transport.close()


sock = socket.socket()
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("0.0.0.0", 2222))
sock.listen(10)
print("HOSTKEY " + KEY.get_name() + " " + KEY.get_base64(), flush=True)
print("READY", flush=True)
while True:
    conn, _ = sock.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
