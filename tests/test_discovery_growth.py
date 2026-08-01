import sys
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from run_project_workflow import merge_discovered_cards


def test_merge_discovered_cards_preserves_existing_and_appends_new_posts():
    existing = [
        {
            "note_id": "note-1",
            "note_url": "https://www.xiaohongshu.com/explore/note-1?xsec_token=old",
            "title": "已保存标题",
            "saved_marker": "keep-me",
        },
        {
            "note_id": "note-2",
            "note_url": "https://www.xiaohongshu.com/explore/note-2",
            "title": "",
        },
    ]
    discovered = [
        {
            "note_id": "note-1",
            "note_url": "https://www.xiaohongshu.com/explore/note-1?xsec_token=new",
            "title": "不应覆盖旧标题",
        },
        {
            "note_id": "note-2",
            "note_url": "https://www.xiaohongshu.com/explore/note-2",
            "title": "补齐标题",
        },
        {
            "note_id": "note-3",
            "note_url": "https://www.xiaohongshu.com/explore/note-3",
            "title": "新发现帖子",
        },
    ]

    merged = merge_discovered_cards(existing, discovered)

    assert [card["note_id"] for card in merged] == ["note-1", "note-2", "note-3"]
    assert merged[0]["title"] == "已保存标题"
    assert merged[0]["saved_marker"] == "keep-me"
    assert merged[1]["title"] == "补齐标题"


def test_merge_discovered_cards_deduplicates_rotating_query_tokens_by_url():
    existing = [{"note_url": "https://www.xiaohongshu.com/explore/note-4?xsec_token=old"}]
    discovered = [{"note_url": "https://www.xiaohongshu.com/explore/note-4?xsec_token=new", "title": "标题"}]

    merged = merge_discovered_cards(existing, discovered)

    assert len(merged) == 1
    assert merged[0]["title"] == "标题"
