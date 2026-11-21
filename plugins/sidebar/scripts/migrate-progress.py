#!/usr/bin/env python3
"""Back up the disabled legacy plugin; import without overwrites and verify every record.

The SQLite schema is checked before reading. No writes to the BB database, no
secret settings, no plan contents on stdout. Uninstall is deliberately separate.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

SETTINGS = {"automaticReminders", "isolateClaude", "claudeExecutable", "effects",
            "autoClose", "autoCloseSeconds", "speed", "sounds"}


def bb(*args):
    result = subprocess.run(["bb", *args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("BB command failed; legacy plugin was not removed")
    return json.loads(result.stdout)


def rpc(method, payload):
    with tempfile.TemporaryDirectory(prefix="sidebar-migration-") as directory:
        path = Path(directory) / "input.json"
        path.write_text(json.dumps(payload))
        path.chmod(0o600)
        return bb("plugin", "rpc", "call", "makosh-sidebar", method,
                  "--input-file", str(path), "--json")


def export(destination):
    state = bb("status", "--json")
    plugins = bb("plugin", "list", "--json")["plugins"]
    legacy = next((p for p in plugins if p["id"] == "plan-progress"), None)
    if legacy is None or legacy["enabled"]:
        raise RuntimeError("Export requires the installed legacy plugin to be disabled")
    database = Path(state["dataDir"]) / "bb.db"
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    try:
        for table in ("plugin_kv", "plugin_settings"):
            columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
            if not {"plugin_id", "key", "value"} <= columns:
                raise RuntimeError("Unsupported BB storage schema")
        entries = [{"key": key, "value": json.loads(value)} for key, value in
                   connection.execute("SELECT key,value FROM plugin_kv WHERE plugin_id=? ORDER BY key",
                                      ("plan-progress",))]
        if any(not e["key"].startswith(("bars:", "agent-errors:", "reminder-v06:")) for e in entries):
            raise RuntimeError("Unknown legacy state; export stopped")
        settings = {key: json.loads(value) for key, value in connection.execute(
            "SELECT key,value FROM plugin_settings WHERE plugin_id=?", ("plan-progress",))
                    if key in SETTINGS}
    finally:
        connection.close()
    # O_EXCL prevents replacing a previous backup, and permissions apply at creation.
    with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        json.dump({"format": 1, "exportedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   "entries": entries, "settings": settings}, file)
    print(f"Backed up {len(entries)} records; legacy plugin untouched")


def apply(source):
    snapshot = json.loads(source.read_text())
    if snapshot.get("format") != 1:
        raise RuntimeError("Unsupported snapshot")
    entries = snapshot["entries"]
    imported = unchanged = 0
    for offset in range(0, len(entries), 10):
        batch = entries[offset:offset + 10]
        result = rpc("progress_import", {"entries": batch})
        if result["conflicts"]:
            raise RuntimeError("Existing Sidebar state conflicts; nothing was overwritten; stop before uninstall")
        imported += result["imported"]
        unchanged += result["unchanged"]
        actual = rpc("progress_export", {"keys": [e["key"] for e in batch]})["entries"]
        if {e["key"]: e["value"] for e in actual} != {e["key"]: e["value"] for e in batch}:
            raise RuntimeError("Migration verification failed; stop before uninstall")
    # Only known non-secret progress settings; never copy plugin-wide settings blindly.
    for key, value in snapshot.get("settings", {}).items():
        if key not in SETTINGS:
            raise RuntimeError("Unknown setting")
        result = subprocess.run(["bb", "plugin", "config", "makosh-sidebar", "set", key,
                                 str(value).lower() if isinstance(value, bool) else str(value)],
                                capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError("Could not restore a progress setting; stop before uninstall")
    print(f"Verified all {len(entries)} records: {imported} imported, {unchanged} already present")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--export", type=Path)
    group.add_argument("--apply", type=Path)
    arguments = parser.parse_args()
    try:
        export(arguments.export) if arguments.export else apply(arguments.apply)
    except (RuntimeError, ValueError, sqlite3.Error, OSError, KeyError) as error:
        parser.exit(1, f"Migration stopped: {error}\n")
