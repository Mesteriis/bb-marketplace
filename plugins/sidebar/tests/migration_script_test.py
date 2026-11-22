import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("migration", Path(__file__).parent.parent / "scripts/migrate-progress.py")
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def test_error_superset_keeps_new_observations(self):
        error = {"id": "error", "state": "error"}
        self.assertTrue(migration.covers_legacy("agent-errors:t", [], [error]))
        self.assertTrue(migration.covers_legacy("agent-errors:t", [error], [error, {"id": "other"}]))
        self.assertFalse(migration.covers_legacy("agent-errors:t", [error], []))

    def test_only_newer_confirmed_root_can_replace_old_reminder_budget(self):
        old = {"turnId": "old", "since": 10, "lastSeq": 20, "sent": True}
        new = {"turnId": "new", "since": 11, "lastSeq": 21, "rootConfirmed": True, "sent": False}
        self.assertTrue(migration.covers_legacy("reminder-v06:t", old, new))
        for change in ({"rootConfirmed": False}, {"turnId": "old"}, {"turnId": None}, {"since": 10}, {"lastSeq": 20}):
            self.assertFalse(migration.covers_legacy("reminder-v06:t", old, {**new, **change}))

    def test_accepted_answer_can_clear_wait_without_changing_the_plan(self):
        old = {"id": "plan", "state": "needs_input", "title": "Plan", "stages": [], "createdAt": 1, "updatedAt": 2}
        new = {**old, "state": "running", "updatedAt": 3}
        self.assertTrue(migration.covers_legacy("bars:t", [old], [new]))
        for change in ({"state": "done"}, {"updatedAt": 2}, {"title": "Other"}, {"stages": [{"name": "Other"}]}):
            self.assertFalse(migration.covers_legacy("bars:t", [old], [{**new, **change}]))

    def test_apply_never_overwrites_conflicts_even_in_runtime_retention_mode(self):
        old = {"turnId": "old", "since": 10, "lastSeq": 20}
        new = {"turnId": "new", "since": 11, "lastSeq": 21, "rootConfirmed": True}
        store = {"agent-errors:t": [{"id": "new-error"}], "reminder-v06:t": new}

        def rpc(method, payload):
            if method == "progress_export":
                return {"entries": [{"key": k, "value": store[k]} for k in payload["keys"] if k in store]}
            result = {"imported": 0, "unchanged": 0, "conflicts": []}
            for entry in payload["entries"]:
                key, value = entry["key"], entry["value"]
                if key in store and store[key] != value:
                    result["conflicts"].append(key)
                elif key in store:
                    result["unchanged"] += 1
                else:
                    store[key] = value
                    result["imported"] += 1
            return result

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "backup.json"
            source.write_text(json.dumps({"format": 1, "entries": [{"key": "agent-errors:t", "value": []}, {"key": "reminder-v06:t", "value": old}], "settings": {}}))
            with patch.object(migration, "rpc", side_effect=rpc), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(RuntimeError):
                    migration.apply(source)
                migration.apply(source, keep_newer_runtime=True)
            self.assertEqual(store["agent-errors:t"], [{"id": "new-error"}])
            self.assertEqual(store["reminder-v06:t"], new)


if __name__ == "__main__":
    unittest.main()
