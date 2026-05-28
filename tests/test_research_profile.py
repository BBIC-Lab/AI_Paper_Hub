from src.research_profile import (
    fallback_research_directions_from_subscriptions,
    normalize_research_directions,
    resolve_research_directions,
)


def test_normalize_research_directions_splits_dedupes_and_caps():
    value = "symbolic regression、equation discovery，symbolic regression;PySR\ninterpretable ML"
    items = normalize_research_directions(value, limit=3)

    assert items == ["symbolic regression", "equation discovery", "PySR"]


def test_resolve_research_directions_prefers_configured_values():
    config = {
        "reader_profile": {"research_directions": ["causal discovery", "symbolic regression"]},
        "subscriptions": {
            "intent_profiles": [
                {"keywords": [{"keyword": "fallback keyword"}]},
            ],
        },
    }

    context = resolve_research_directions(config)

    assert context["source"] == "configured"
    assert context["directions"] == ["causal discovery", "symbolic regression"]


def test_fallback_research_directions_uses_enabled_subscription_keywords():
    config = {
        "reader_profile": {"research_directions": []},
        "subscriptions": {
            "intent_profiles": [
                {
                    "enabled": True,
                    "keywords": [
                        {"keyword": "symbolic regression"},
                        {"keyword": "equation discovery"},
                    ],
                },
                {
                    "paused": True,
                    "keywords": [{"keyword": "paused keyword"}],
                },
                {
                    "enabled": False,
                    "keywords": [{"keyword": "disabled keyword"}],
                },
            ],
        },
    }

    assert fallback_research_directions_from_subscriptions(config) == [
        "symbolic regression",
        "equation discovery",
    ]
    assert resolve_research_directions(config)["source"] == "fallback"
