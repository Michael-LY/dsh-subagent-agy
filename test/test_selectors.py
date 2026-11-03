"""Unit tests for the pure reply-completion policy in selectors.py."""

import importlib.util
import unittest
from pathlib import Path

SELECTORS_PATH = Path(__file__).resolve().parents[1] / "scripts" / "gemini_research" / "selectors.py"
spec = importlib.util.spec_from_file_location("gemini_selectors", SELECTORS_PATH)
selectors = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selectors)


class ShouldFinishReplyTest(unittest.TestCase):
    def test_stop_visible_never_finishes(self):
        # Historical action buttons are page-wide and must not bypass Stop.
        self.assertFalse(
            selectors.should_finish_reply(
                last_text="half answer",
                stable_for=10,
                stop_count=1,
                saw_stop=True,
                action_in_latest=5,
            )
        )

    def test_stop_gone_and_seen_returns_true(self):
        self.assertTrue(
            selectors.should_finish_reply(
                last_text="complete answer",
                stable_for=2.5,
                stop_count=0,
                saw_stop=True,
                action_in_latest=0,
            )
        )

    def test_latest_action_without_stop_seen_returns_true(self):
        self.assertTrue(
            selectors.should_finish_reply(
                last_text="complete answer",
                stable_for=2.6,
                stop_count=0,
                saw_stop=False,
                action_in_latest=1,
            )
        )

    def test_short_stability_returns_false(self):
        self.assertFalse(
            selectors.should_finish_reply(
                last_text="still streaming",
                stable_for=2.4,
                stop_count=0,
                saw_stop=True,
                action_in_latest=0,
            )
        )

    def test_empty_text_returns_false(self):
        self.assertFalse(
            selectors.should_finish_reply(
                last_text="",
                stable_for=99,
                stop_count=0,
                saw_stop=True,
                action_in_latest=1,
            )
        )


class ModelHelpersTest(unittest.TestCase):
    def test_normalise_text(self):
        self.assertEqual(selectors._normalise_text("  Flash-Lite   极速回答 "), "flash-lite 极速回答")

    def test_model_id_from_label_flash_lite_vs_flash(self):
        self.assertEqual(selectors._model_id_from_label("3.5 Flash-Lite 极速回答"), "flash-lite")
        self.assertEqual(selectors._model_id_from_label("3.8 Flash 全方位帮助"), "flash")
        self.assertEqual(selectors._model_id_from_label("3.1 Pro 高级推理"), "pro")
        self.assertEqual(selectors._model_id_from_label("4 Argon 复杂任务"), "argon")

    def test_model_tokens_do_not_mix_flash_and_flash_lite(self):
        flash_tokens = selectors._model_tokens("flash", "3.8 Flash 全方位帮助")
        lite_tokens = selectors._model_tokens("flash-lite", "3.5 Flash-Lite 极速回答")
        self.assertIn("3.8 flash", flash_tokens)
        self.assertIn("flash-lite", lite_tokens)
        self.assertNotIn("flash-lite", flash_tokens)


if __name__ == "__main__":
    unittest.main()
