from media_worker.captions import (
    ass_timestamp,
    group_words,
    render_ass,
    render_srt,
    srt_timestamp,
    TEMPLATES,
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
    assert "{\\k40}OLÁ" in ass
    assert "{\\k60}MUNDO" in ass
