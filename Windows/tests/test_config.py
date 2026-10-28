from pathlib import Path
import tempfile
import unittest

from nova.config import NovaConfig, validate_gguf


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = NovaConfig(self.root / "config.json")

    def tearDown(self):
        self.temp.cleanup()

    def test_validates_and_persists_low_resource_settings(self):
        settings = self.config.update_settings({
            "context": 1024, "threads": 2, "batch": 32,
            "rpcEnabled": True, "rpcEndpoints": ["192.168.1.20:50052"],
        })
        self.assertEqual(settings["context"], 1024)
        self.assertTrue(settings["rpcEnabled"])
        loaded = NovaConfig(self.root / "config.json")
        self.assertEqual(loaded.settings["rpcEndpoints"], ["192.168.1.20:50052"])

    def test_rejects_invalid_rpc_and_unsafe_values(self):
        for payload in [
            {"context": 3000, "threads": 2, "batch": 64},
            {"context": 2048, "threads": 99, "batch": 64},
            {"context": 2048, "threads": 2, "batch": 64, "rpcEndpoints": ["http://node:50052"]},
            {"context": 2048, "threads": 2, "batch": 64, "rpcEnabled": True, "rpcEndpoints": []},
        ]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.config.update_settings(payload)

    def test_gguf_magic_is_required(self):
        model = self.root / "model.gguf"
        model.write_bytes(b"NOPE" + b"0" * 20)
        with self.assertRaises(ValueError):
            validate_gguf(model)
        model.write_bytes(b"GGUF" + b"0" * 20)
        self.assertEqual(validate_gguf(model), model)


if __name__ == "__main__":
    unittest.main()
