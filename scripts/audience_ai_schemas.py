from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator


SCHEMA_VERSION = "audience-ai/1"

STRING_LIST = {
    "type": "array",
    "items": {"type": "string"},
}
EVIDENCE_LIST = {
    "type": "array",
    "items": {"type": "string", "minLength": 1},
    "uniqueItems": True,
}


COMMENT_INSIGHT = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "commentId",
        "status",
        "skipReason",
        "postId",
        "parentCommentId",
        "rootThreadId",
        "userId",
        "level",
        "themeIds",
        "sentiment",
        "stance",
        "intent",
        "needs",
        "questions",
        "objections",
        "painPoints",
        "desiredOutcomes",
        "engagementRole",
        "actionability",
        "confidence",
        "evidenceRefs",
        "qualityFlags",
    ],
    "properties": {
        "commentId": {"type": "string", "minLength": 1},
        "status": {"enum": ["analyzed", "skipped"]},
        "skipReason": {"type": "string"},
        "postId": {"type": "string", "minLength": 1},
        "parentCommentId": {"type": "string"},
        "rootThreadId": {"type": "string", "minLength": 1},
        "userId": {"type": "string", "minLength": 1},
        "level": {"enum": ["comment", "reply"]},
        "themeIds": STRING_LIST,
        "sentiment": {"enum": ["positive", "neutral", "negative", "mixed", "unclear"]},
        "stance": {
            "enum": [
                "support",
                "oppose",
                "question",
                "supplement",
                "personal_experience",
                "unrelated",
                "unclear",
            ]
        },
        "intent": {
            "enum": [
                "seek_information",
                "share_experience",
                "evaluate",
                "recommend",
                "complain",
                "request_help",
                "express_identity",
                "socialize",
                "purchase_or_action_interest",
                "unclear",
            ]
        },
        "needs": STRING_LIST,
        "questions": STRING_LIST,
        "objections": STRING_LIST,
        "painPoints": STRING_LIST,
        "desiredOutcomes": STRING_LIST,
        "engagementRole": {"type": "string", "minLength": 1},
        "actionability": {"enum": ["high", "medium", "low", "none", "unknown"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "evidenceRefs": EVIDENCE_LIST,
        "qualityFlags": STRING_LIST,
    },
}


THREAD_INSIGHT = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "postId",
        "status",
        "skipReason",
        "rootThreadId",
        "commentIds",
        "theme",
        "evolution",
        "mainViewpoints",
        "disagreements",
        "consensus",
        "unresolvedQuestions",
        "highValueReplyIds",
        "authorParticipated",
        "interactionDepth",
        "sentimentShift",
        "confidence",
        "evidenceRefs",
        "qualityFlags",
    ],
    "properties": {
        "postId": {"type": "string", "minLength": 1},
        "status": {"enum": ["analyzed", "partial", "skipped"]},
        "skipReason": {"type": "string"},
        "rootThreadId": {"type": "string", "minLength": 1},
        "commentIds": {"type": "array", "items": {"type": "string"}, "minItems": 1, "uniqueItems": True},
        "theme": {"type": "string"},
        "evolution": {"type": "string"},
        "mainViewpoints": STRING_LIST,
        "disagreements": STRING_LIST,
        "consensus": STRING_LIST,
        "unresolvedQuestions": STRING_LIST,
        "highValueReplyIds": {"type": "array", "items": {"type": "string"}, "uniqueItems": True},
        "authorParticipated": {"type": "boolean"},
        "interactionDepth": {"enum": ["none", "shallow", "moderate", "deep", "unknown"]},
        "sentimentShift": {"type": "string"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "evidenceRefs": EVIDENCE_LIST,
        "qualityFlags": STRING_LIST,
    },
}


THREAD_MAP_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "required": ["schemaVersion", "commentInsights", "threadInsights"],
    "properties": {
        "schemaVersion": {"const": SCHEMA_VERSION},
        "commentInsights": {"type": "array", "items": COMMENT_INSIGHT},
        "threadInsights": {"type": "array", "items": THREAD_INSIGHT},
    },
}


PROFILE_CONTEXT = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "availableFields",
        "missingFields",
        "usedFields",
        "collectedAt",
        "accessStatus",
        "profileMode",
        "recentPublicPostCount",
    ],
    "properties": {
        "availableFields": STRING_LIST,
        "missingFields": STRING_LIST,
        "usedFields": STRING_LIST,
        "collectedAt": {"type": "string"},
        "accessStatus": {"type": "string"},
        "profileMode": {
            "enum": ["none", "available_header", "collect_missing_header", "recent_public_posts"]
        },
        "recentPublicPostCount": {"type": "integer", "minimum": 0},
    },
}


USER_INSIGHT = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "userId",
        "status",
        "skipReason",
        "postId",
        "displayName",
        "interactionRole",
        "mainThemes",
        "expressedNeeds",
        "expressedConcerns",
        "questions",
        "stanceToPost",
        "engagementDepth",
        "observableInterests",
        "possibleContentNeeds",
        "profileCoverage",
        "profileContext",
        "sourceScope",
        "confidence",
        "evidenceRefs",
        "qualityFlags",
    ],
    "properties": {
        "userId": {"type": "string", "minLength": 1},
        "status": {"enum": ["analyzed", "skipped"]},
        "skipReason": {"type": "string"},
        "postId": {"type": "string", "minLength": 1},
        "displayName": {"type": "string"},
        "interactionRole": {"type": "string", "minLength": 1},
        "mainThemes": STRING_LIST,
        "expressedNeeds": STRING_LIST,
        "expressedConcerns": STRING_LIST,
        "questions": STRING_LIST,
        "stanceToPost": {
            "enum": [
                "support",
                "oppose",
                "question",
                "supplement",
                "personal_experience",
                "unrelated",
                "mixed",
                "unclear",
            ]
        },
        "engagementDepth": {"enum": ["single", "repeat", "threaded", "deep", "unknown"]},
        "observableInterests": STRING_LIST,
        "possibleContentNeeds": STRING_LIST,
        "profileCoverage": {"enum": ["none", "partial", "header", "recent_public_posts"]},
        "profileContext": PROFILE_CONTEXT,
        "sourceScope": STRING_LIST,
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "evidenceRefs": EVIDENCE_LIST,
        "qualityFlags": STRING_LIST,
    },
}


USER_BATCH_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "required": ["schemaVersion", "userInsights"],
    "properties": {
        "schemaVersion": {"const": SCHEMA_VERSION},
        "userInsights": {"type": "array", "items": USER_INSIGHT},
    },
}


EVIDENCED_TEXT = {
    "type": "object",
    "additionalProperties": False,
    "required": ["text", "evidenceRefs"],
    "properties": {
        "text": {"type": "string"},
        "evidenceRefs": EVIDENCE_LIST,
    },
}


SYNTHESIS_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "required": [
        "schemaVersion",
        "postContext",
        "themes",
        "distributions",
        "audienceSegments",
        "contentFit",
        "contentOpportunities",
        "risks",
        "limitations",
        "evidenceRefs",
    ],
    "properties": {
        "schemaVersion": {"const": SCHEMA_VERSION},
        "postContext": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "mainTheme",
                "facts",
                "opinions",
                "expressionStyle",
                "contentStructure",
                "claims",
                "intendedAudience",
                "questions",
                "solutions",
                "discussionTriggers",
                "contextComplete",
                "confidence",
                "evidenceRefs",
            ],
            "properties": {
                "mainTheme": {"type": "string"},
                "facts": STRING_LIST,
                "opinions": STRING_LIST,
                "expressionStyle": {"type": "string"},
                "contentStructure": STRING_LIST,
                "claims": STRING_LIST,
                "intendedAudience": STRING_LIST,
                "questions": STRING_LIST,
                "solutions": STRING_LIST,
                "discussionTriggers": STRING_LIST,
                "contextComplete": {"type": "boolean"},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "evidenceRefs": EVIDENCE_LIST,
            },
        },
        "themes": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["themeId", "name", "description", "commentCount", "userCount", "evidenceRefs"],
                "properties": {
                    "themeId": {"type": "string", "minLength": 1},
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "commentCount": {"type": "integer", "minimum": 0},
                    "userCount": {"type": "integer", "minimum": 0},
                    "evidenceRefs": EVIDENCE_LIST,
                },
            },
        },
        "distributions": {
            "type": "object",
            "additionalProperties": False,
            "required": ["sentiment", "stance", "intent"],
            "properties": {
                name: {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["label", "count", "share"],
                        "properties": {
                            "label": {"type": "string"},
                            "count": {"type": "integer", "minimum": 0},
                            "share": {"type": "number", "minimum": 0, "maximum": 1},
                        },
                    },
                }
                for name in ("sentiment", "stance", "intent")
            },
        },
        "audienceSegments": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "segmentId",
                    "name",
                    "definition",
                    "userCount",
                    "primaryUserCount",
                    "secondaryUserCount",
                    "commentCount",
                    "share",
                    "representativeNeeds",
                    "representativeQuestions",
                    "confidence",
                    "coverageLimitations",
                    "evidenceRefs",
                ],
                "properties": {
                    "segmentId": {"type": "string", "minLength": 1},
                    "name": {"type": "string"},
                    "definition": {"type": "string"},
                    "userCount": {"type": "integer", "minimum": 0},
                    "primaryUserCount": {"type": "integer", "minimum": 0},
                    "secondaryUserCount": {"type": "integer", "minimum": 0},
                    "commentCount": {"type": "integer", "minimum": 0},
                    "share": {"type": "number", "minimum": 0, "maximum": 1},
                    "representativeNeeds": STRING_LIST,
                    "representativeQuestions": STRING_LIST,
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "coverageLimitations": STRING_LIST,
                    "evidenceRefs": EVIDENCE_LIST,
                },
            },
        },
        "contentFit": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "alignmentScore",
                "understood",
                "misunderstood",
                "unansweredQuestions",
                "positiveDrivers",
                "objectionDrivers",
                "missingInformation",
                "credibilityIssues",
                "recommendations",
                "evidenceRefs",
            ],
            "properties": {
                "alignmentScore": {"type": "number", "minimum": 0, "maximum": 1},
                "understood": {"type": "array", "items": EVIDENCED_TEXT},
                "misunderstood": {"type": "array", "items": EVIDENCED_TEXT},
                "unansweredQuestions": {"type": "array", "items": EVIDENCED_TEXT},
                "positiveDrivers": {"type": "array", "items": EVIDENCED_TEXT},
                "objectionDrivers": {"type": "array", "items": EVIDENCED_TEXT},
                "missingInformation": {"type": "array", "items": EVIDENCED_TEXT},
                "credibilityIssues": {"type": "array", "items": EVIDENCED_TEXT},
                "recommendations": {"type": "array", "items": EVIDENCED_TEXT},
                "evidenceRefs": EVIDENCE_LIST,
            },
        },
        "contentOpportunities": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["type", "title", "rationale", "segmentIds", "confidence", "evidenceRefs"],
                "properties": {
                    "type": {
                        "enum": [
                            "follow_up_topic",
                            "faq",
                            "comment_reply",
                            "clarification",
                            "supporting_evidence",
                            "case_study",
                            "segment_angle",
                            "risk_warning",
                        ]
                    },
                    "title": {"type": "string"},
                    "rationale": {"type": "string"},
                    "segmentIds": STRING_LIST,
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "evidenceRefs": EVIDENCE_LIST,
                },
            },
        },
        "risks": {"type": "array", "items": EVIDENCED_TEXT},
        "limitations": STRING_LIST,
        "evidenceRefs": EVIDENCE_LIST,
    },
}


def schema_errors(payload: Any, schema: dict[str, Any]) -> list[str]:
    validator = Draft202012Validator(schema)
    errors: list[str] = []
    for error in sorted(validator.iter_errors(payload), key=lambda item: list(item.absolute_path)):
        path = ".".join(str(part) for part in error.absolute_path) or "$"
        errors.append(f"{path}: {error.message}")
    return errors


def assert_schema(payload: Any, schema: dict[str, Any]) -> None:
    errors = schema_errors(payload, schema)
    if errors:
        raise ValueError("; ".join(errors[:20]))
