from radio.brain import clean_line, split_lines, system_prompt


def test_clean_line_strips_directions_labels_and_markup():
    assert clean_line("MARTA: (laughs) Morning, flyers!") == "Morning, flyers!"
    assert clean_line("- *static* You're on the Belfry, love.") == "You're on the Belfry, love."
    assert clean_line('"Correction: the earlier correction was correct."') == "Correction: the earlier correction was correct."
    assert clean_line("1. Grey, with grey.") == "Grey, with grey."
    assert clean_line("[SFX: bell]") == ""


def test_split_lines_drops_empties():
    assert split_lines("Hello.\n\n(pause)\nKESTREL-7, you're on the air.\n") == ["Hello.", "KESTREL-7, you're on the air."]


def test_system_prompt_carries_the_bible():
    bible = {
        "dial": 983,
        "name": "Port Ardent Rebuild News",
        "slogan": "News you can stand on.",
        "format": "news",
        "host": {"name": "Juno Brack", "persona": "Earnest.", "quirks": ["says grey with grey"], "voice": "british_female"},
        "topics": ["bridges"],
        "recurringBits": ["Weather: Grey"],
        "bannedTopics": [],
        "worldFeed": True,
    }
    p = system_prompt(bible)
    assert "Juno Brack" in p and "FM 98.3" in p and "Weather: Grey" in p
    assert "text-to-speech" in p
