from media_worker.clips import find_clips, overlap_ratio


def _segments():
    return [
        {
            "id": index,
            "start": index * 20.0,
            "end": (index + 1) * 20.0,
            "text": "Assunto %d com uma explicação completa." % index,
        }
        for index in range(8)
    ]


def test_clip_finder_ranks_and_limits_overlap():
    segments = _segments()
    scores = [{"segmentId": index, "score": 90 - index * 3} for index in range(8)]
    clips = find_clips(
        segments, scores, requested_count=5, minimum_duration=15, maximum_duration=45
    )
    assert 1 <= len(clips) <= 5
    assert clips[0]["score"] >= clips[-1]["score"]
    assert clips[0]["hook"]
    assert clips[0]["genre"]
    assert all(15 <= clip["durationSeconds"] <= 45 for clip in clips)
    for left_index, left in enumerate(clips):
        for right in clips[left_index + 1 :]:
            assert (
                overlap_ratio(left["start"], left["end"], right["start"], right["end"])
                <= 0.55
            )


def test_single_short_segment_still_yields_valid_candidate():
    clips = find_clips(
        [{"id": 1, "start": 0, "end": 8, "text": "Resumo curto"}],
        [{"segmentId": 1, "score": 50}],
    )
    assert clips[0]["start"] == 0
    assert clips[0]["end"] == 8
