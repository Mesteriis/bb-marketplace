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


def covers_legacy(key, old, current):
    """Only provable supersets or a later confirmed root turn may supersede a backup."""
    if old == current:
        return True
    if key.startswith("agent-errors:") and isinstance(old, list) and isinstance(current, list):
        return all(item in current for item in old)
    if key.startswith("reminder-v06:") and isinstance(old, dict) and isinstance(current, dict):
        return (current.get("turnId") is not None
                and current.get("turnId") != old.get("turnId")
                and current.get("rootConfirmed") is True
                and current.get("since", 0) > old.get("since", 0)
                and current.get("lastSeq", 0) > old.get("lastSeq", 0))
    if key.startswith("bars:") and isinstance(old, list) and isinstance(current, list):
        # A confirmed human reply may clear a wait while the open UI reads a plan.
        for previous in old:
            updated = next((item for item in current if item.get("id") == previous.get("id")), None)
            if previous == updated:
                continue
            if (not updated or previous.get("state") != "needs_input"
                    or updated.get("state") != "running"
                    or updated.get("createdAt") != previous.get("createdAt")
                    or updated.get("updatedAt", 0) <= previous.get("updatedAt", 0)
                    or updated.get("stages") != previous.get("stages")
                    or updated.get("title") != previous.get("title")):
                return False
        return True
    return False


def apply(source, keep_newer_runtime=False):
    snapshot = json.loads(source.read_text())
    if snapshot.get("format") != 1:
        raise RuntimeError("Unsupported snapshot")
    entries = snapshot["entries"]
    imported = unchanged = kept = 0
    for offset in range(0, len(entries), 10):
        batch = entries[offset:offset + 10]
        result = rpc("progress_import", {"entries": batch})
        imported += result["imported"]
        unchanged += result["unchanged"]
        if result["conflicts"]:
            actual = {e["key"]: e["value"] for e in rpc("progress_export", {"keys": result["conflicts"]})["entries"]}
            for entry in batch:
                if entry["key"] not in result["conflicts"]:
                    continue
                if not keep_newer_runtime or not covers_legacy(entry["key"], entry["value"], actual.get(entry["key"])):
                    raise RuntimeError("Existing Sidebar state conflicts; nothing was overwritten; stop before uninstall")
                kept += 1
        actual = rpc("progress_export", {"keys": [e["key"] for e in batch]})["entries"]
        actual = {e["key"]: e["value"] for e in actual}
        for entry in batch:
            current = actual.get(entry["key"])
            if current != entry["value"] and not (keep_newer_runtime and covers_legacy(entry["key"], entry["value"], current)):
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
    print(f"Verified all {len(entries)} records: {imported} imported, {unchanged} already present, {kept} newer runtime records retained")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--export", type=Path)
    group.add_argument("--apply", type=Path)
    parser.add_argument("--keep-newer-runtime", action="store_true", help="Keep error supersets and proven newer root-turn budgets; never overwrite a conflict")
    arguments = parser.parse_args()
    try:
        export(arguments.export) if arguments.export else apply(arguments.apply, arguments.keep_newer_runtime)
    except (RuntimeError, ValueError, sqlite3.Error, OSError, KeyError) as error:
        parser.exit(1, f"Migration stopped: {error}\n")
