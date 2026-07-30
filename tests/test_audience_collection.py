from scripts.audience_collection import (
    _post_source,
    _summary,
    compact_count,
    extract_comments_from_payload,
    merge_user,
    parse_profile_snapshot,
)


def test_compact_count_supports_common_xiaohongshu_units():
    assert compact_count("1.2万") == 12000
    assert compact_count("3k") == 3000
    assert compact_count("988") == 988
    assert compact_count("") is None


def test_nested_replies_keep_their_parent_comment():
    payload = {
        "data": {
            "comments": [
                {
                    "id": "root-1",
                    "content": "顶层评论",
                    "user_info": {"user_id": "u-1", "nickname": "甲"},
                    "sub_comments": [
                        {
                            "id": "reply-1",
                            "content": "楼中楼回复",
                            "user_info": {"user_id": "u-2", "nickname": "乙"},
                        }
                    ],
                }
            ]
        }
    }

    comments = {
        item["comment_id"]: item
        for item in extract_comments_from_payload(payload, post_id="note-1", note_url="https://example.test/note-1")
    }

    assert comments["root-1"]["parent_comment_id"] == ""
    assert comments["root-1"]["level"] == "comment"
    assert comments["reply-1"]["parent_comment_id"] == "root-1"
    assert comments["reply-1"]["level"] == "reply"


def test_post_source_includes_author_and_expected_comment_count():
    posts = _post_source([
        {
            "note_id": "note-1",
            "title": "示例帖子",
            "note_url": "https://www.xiaohongshu.com/explore/note-1",
            "author": "原帖主",
            "author_profile": "https://www.xiaohongshu.com/user/profile/author-1",
            "comment_count": "1.5万",
        }
    ])

    assert len(posts) == 1
    assert posts[0]["expected_comment_count"] == 15000
    assert posts[0]["author"]["user_id"] == "author-1"
    assert posts[0]["author"]["roles"] == ["author"]


def test_summary_only_reports_complete_when_posts_and_profiles_are_complete():
    posts = [{"status": "complete"}]
    comments = [{"parent_comment_id": ""}, {"parent_comment_id": "root-1"}]
    users = [{"enrichment_status": "complete"}]

    completed = _summary(posts, comments, users)
    assert completed["status"] == "complete"
    assert completed["topLevelComments"] == 1
    assert completed["repliesCollected"] == 1

    partial = _summary(posts, comments, [{"enrichment_status": "partial"}])
    assert partial["status"] == "partial"


def test_real_name_replaces_placeholder_during_user_merge():
    merged = merge_user(
        {"user_id": "u-1", "display_name": "未命名用户", "roles": ["commenter"], "post_ids": [], "comment_count": 0},
        {"user_id": "u-1", "display_name": "真实昵称", "roles": ["author"], "post_ids": ["note-1"], "comment_count": 0},
    )

    assert merged["display_name"] == "真实昵称"
    assert merged["roles"] == ["author", "commenter"]


def test_profile_requires_verified_public_page_before_completion():
    existing = {"user_id": "u-1", "display_name": "评论者", "enrichment_status": "pending"}

    unverified = parse_profile_snapshot({"profile_loaded": False, "display_name": "异常页面"}, existing)
    assert unverified["enrichment_status"] == "partial"
    assert unverified["access_status"] == "profile_not_verified"

    verified = parse_profile_snapshot({"profile_loaded": True, "display_name": "公开昵称"}, existing)
    assert verified["enrichment_status"] == "complete"
    assert verified["access_status"] == "public_profile_ok"
