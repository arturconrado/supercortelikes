from media_worker.captions import (
    ass_timestamp,
    group_words,
    render_ass,
    render_srt,
    srt_timestamp,
    TEMPLATES,
    caption_style,
    normalize_cues,
)


def test_timestamps_support_hour_long_media():
    assert srt_timestamp(3661.234) == "01:01:01,234"
    assert ass_timestamp(3661.23) == "1:01:01.23"


def test_caption_output_contains_word_timing_and_karaoke():
    words = [
        {"word": "Olá", "start": 10.0, "end": 10.4},
        {"word": "mundo", "start": 10.4, "end": 11.0},
    ]
    cues = group_words(words, clip_start=10, clip_end=12, words_per_cue=4)
    srt = render_srt(cues)
    ass = render_ass(cues, TEMPLATES["podcast"], "podcast")
    assert "00:00:00,000 --> 00:00:01,000" in srt
    assert "Olá mundo" in srt
    assert "\\k40" in ass and "OLÁ" in ass
    assert "\\k60\\c&H0000D7FF" in ass and "MUNDO" in ass
    assert cues[0]["keywordIndex"] == 1


def test_caption_grouping_respects_punctuation_pauses_and_editor_vocabulary():
    words = [
        {"word": "Primeira", "start": 0.0, "end": 0.25},
        {"word": "frase.", "start": 0.25, "end": 0.6},
        {"word": "Outra", "start": 1.1, "end": 1.4},
        {"word": "ideia", "start": 1.4, "end": 1.8},
    ]
    cues = group_words(words, clip_start=0, clip_end=2, words_per_cue=6)
    assert len(cues) == 2
    style = caption_style("podcast", {
        "activeColor": "#00ff00",
        "keywordColor": "#ffcc00",
        "animation": "none",
        "case": "preserve",
        "position": "auto",
    })
    ass = render_ass(cues, style, "podcast")
    assert "&H0000FF00" in ass
    assert "Primeira" in ass


def test_caption_templates_use_five_distinct_bundled_font_families():
    assert {name: template["font"] for name, template in TEMPLATES.items()} == {
        "podcast": "Montserrat ExtraBold",
        "business": "Liberation Sans",
        "finance": "Nimbus Mono PS",
        "marketing": "Nimbus Sans Narrow",
        "motivational": "URW Bookman",
    }
    assert len({template["font"] for template in TEMPLATES.values()}) == 5


def test_editor_style_and_text_cues_are_applied_to_ass_output():
    cues = normalize_cues([{"start": 0.2, "end": 1.2, "text": "Texto editado"}], 2.0)
    style = caption_style("marketing", {
        "primaryColor": "#ff3366",
        "highlightColor": "#33ff99",
        "fontSize": 44,
        "position": "middle",
        "background": True,
    })
    ass = render_ass(cues, style, "marketing")
    assert "&H006633FF" in ass
    assert "&H0099FF33" in ass
    assert "Nimbus Sans Narrow,44" in ass
    assert ",3,0,0,5,70,70,0,1" in ass
    assert "TEXTO" in ass and "EDITADO" in ass

    shifted = normalize_cues([{"start": 0, "end": 1, "text": "Ajustado"}], 2.0, -0.2)
    assert shifted[0]["start"] == 0
    assert shifted[0]["end"] == 0.8
