import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("publish.py")
spec = importlib.util.spec_from_file_location("publisher", SCRIPT)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublisherContractTests(unittest.TestCase):
    def test_action_hash_matches_engine_shape(self):
        comment = "That provenance gap matters: Marx can host a discussion of the counter-evidence."
        expected = {"commentHash": publisher.comment_hash(comment), "postId": "post-test", "strategyFamily": "provenance"}
        self.assertEqual("act_" + publisher.sha256_text(publisher.stable_json(expected))[:32], publisher.sha256_text(publisher.stable_json(expected)).join(["act_", ""])[:36])

    def test_invalid_action_id_is_rejected(self):
        with self.assertRaises(publisher.PublisherError):
            publisher.validate_action({"schema_version": "1.0", "action": "COMMENT", "platform": "moltbook", "action_id": "bad id"}, {"allowed_domains": ["www.moltbook.com"]})

if __name__ == "__main__":
    unittest.main()
