from pathlib import Path

from media_worker.composition import (
    COMPOSITION_VERSION,
    _combine_ai_speaker_activity,
    _combine_voice_activity,
    _fill_is_safe,
    _scenes,
    _subject_focus,
    _usable_subject_box,
    _windowed_usable_rates,
    composition_plan,
    detect_cross_talk,
    enforce_safe_layouts,
    fallback_plan,
    stabilize_layouts,
    stabilize_active_tracks,
    smooth_keyframes,
)
from media_worker.rendering import (
    _composition_filter_graph,
    _crop_keyframes,
    _framing_target,
)


def _box(x: int, activity: float):
    return {
        "x": x,
        "y": 180,
        "width": 280,
        "height": 420,
        "confidence": 0.95,
        "activity": activity,
    }


def test_composition_uses_fill_split_and_safe_fallbacks():
    clip = {"id": "clip-001", "start": 0, "end": 3}
    analysis = {
        "width": 1920,
        "height": 1080,
        "detectionRate": 1,
        "samples": [
            {"time": 0, "boxes": [_box(200, 1)], "activeSpeakerConfidence": 1},
            {"time": 0.75, "boxes": [_box(240, 1)], "activeSpeakerConfidence": 1},
            {"time": 1.5, "boxes": [_box(200, 0.1), _box(1200, 0.12)], "activeSpeakerConfidence": 0.12},
            {"time": 2.25, "boxes": [_box(220, 0.1), _box(1180, 0.12)], "activeSpeakerConfidence": 0.12},
        ],
    }
    plan = composition_plan(clip, analysis, aspect="9:16")
    assert [scene["layout"] for scene in plan["scenes"]] == ["fill", "split"]
    assert plan["diagnostics"]["status"] == "ready"
    assert all(scene["captionSafeZone"] == "bottom" for scene in plan["scenes"])

    low_confidence = {
        **analysis,
        "detectionRate": 0.2,
        "samples": [
            {"time": sample["time"], "boxes": [], "activeSpeakerConfidence": 0}
            for sample in analysis["samples"]
        ],
    }
    assert composition_plan(clip, low_confidence, aspect="9:16")["scenes"][0]["layout"] == "fit"
    assert fallback_plan(clip, "9:16", "budget-exceeded")["diagnostics"]["reason"] == "budget-exceeded"


def test_voice_activity_gates_lip_motion_and_keyframes_never_jump_over_eight_percent():
    analysis = {
        "samples": [
            {"time": 0.05, "activeSpeakerConfidence": 1, "boxes": [{"activity": 1}]},
            {"time": 0.5, "activeSpeakerConfidence": 1, "boxes": [{"activity": 1}]},
        ]
    }
    _combine_voice_activity(analysis, [{"start": 0, "end": 0.1}])
    assert analysis["samples"][0]["voiceActive"] is True
    assert analysis["samples"][1]["activeSpeakerConfidence"] == 0.2

    word_analysis = {
        "samples": [
            {"time": 0.13, "activeSpeakerConfidence": 1, "boxes": [{"activity": 1}]},
            {"time": 0.16, "activeSpeakerConfidence": 1, "boxes": [{"activity": 1}]},
        ]
    }
    _combine_voice_activity(
        word_analysis,
        [{"start": 0, "end": 0.1, "speaker": "SPEAKER_00", "kind": "word"}],
    )
    assert word_analysis["samples"][0]["voiceActive"] is True
    assert word_analysis["samples"][1]["voiceActive"] is False

    keyframes = smooth_keyframes(
        [
            {"time": 0, "focusX": 0, "focusY": 0, "confidence": 1},
            {"time": 0.25, "focusX": 1920, "focusY": 1080, "confidence": 1},
        ],
        1920,
        1080,
    )
    assert abs(keyframes[1]["x"] - keyframes[0]["x"]) <= 1920 * 0.08 + 0.01
    assert abs(keyframes[1]["y"] - keyframes[0]["y"]) <= 1080 * 0.08 + 0.01


def test_diarization_speaker_ids_are_associated_with_stable_visual_tracks():
    analysis = {
        "samples": [
            {
                "time": 0.1,
                "activeSpeakerConfidence": 0.9,
                "boxes": [_box(100, 0.9), _box(1100, 0.1)],
            },
            {
                "time": 0.6,
                "activeSpeakerConfidence": 0.8,
                "boxes": [_box(110, 0.8), _box(1090, 0.1)],
            },
            {
                "time": 1.1,
                "activeSpeakerConfidence": 0.9,
                "boxes": [_box(120, 0.1), _box(1080, 0.9)],
            },
        ]
    }
    _combine_voice_activity(
        analysis,
        [
            {"start": 0, "end": 0.8, "speaker": "SPEAKER_00"},
            {"start": 0.9, "end": 1.4, "speaker": "SPEAKER_01"},
        ],
    )

    assert analysis["speakerTrackMap"] == {"SPEAKER_00": 1, "SPEAKER_01": 2}
    assert analysis["samples"][0]["boxes"][0]["activity"] >= 0.85
    assert analysis["samples"][2]["boxes"][1]["activity"] >= 0.85


def test_composition_v2_holds_a_new_track_for_250ms_and_uses_split_during_transition():
    samples = [
        {
            "time": 0.0,
            "layout": "fill",
            "activeTrackId": 1,
            "focusX": 200,
            "focusY": 200,
            "boxes": [{**_box(60, 1), "trackId": 1}, {**_box(1100, 0.1), "trackId": 2}],
        },
        {
            "time": 0.1,
            "layout": "fill",
            "activeTrackId": 2,
            "focusX": 1240,
            "focusY": 200,
            "boxes": [{**_box(60, 0.1), "trackId": 1}, {**_box(1100, 1), "trackId": 2}],
        },
        {
            "time": 0.35,
            "layout": "fill",
            "activeTrackId": 2,
            "focusX": 1240,
            "focusY": 200,
            "boxes": [{**_box(60, 0.1), "trackId": 1}, {**_box(1100, 1), "trackId": 2}],
        },
    ]

    stabilized = stabilize_active_tracks(samples, focus_switch_delay_seconds=0.25)

    assert COMPOSITION_VERSION == "composition-v2"
    assert stabilized[1]["activeTrackId"] == 1
    assert stabilized[1]["layout"] == "split"
    assert stabilized[2]["activeTrackId"] == 2


def test_composition_v2_persists_active_speaker_switches_as_scene_boundaries():
    clip = {"id": "clip-001", "start": 0, "end": 1}
    left = {**_box(100, 1), "trackId": 1}
    right = {**_box(1100, 0.1), "trackId": 2}
    analysis = {
        "width": 1920,
        "height": 1080,
        "detectionRate": 1,
        "samples": [
            {"time": 0.0, "boxes": [left, right], "activeSpeakerConfidence": 1},
            {
                "time": 0.25,
                "boxes": [{**left, "activity": 0.1}, {**right, "activity": 1}],
                "activeSpeakerConfidence": 1,
            },
            {
                "time": 0.5,
                "boxes": [{**left, "activity": 0.1}, {**right, "activity": 1}],
                "activeSpeakerConfidence": 1,
            },
        ],
    }

    plan = composition_plan(
        clip,
        analysis,
        aspect="9:16",
        focus_switch_delay_seconds=0.25,
    )

    assert [scene["activeTrackId"] for scene in plan["scenes"]] == [1, 1, 2]
    assert [scene["layout"] for scene in plan["scenes"]] == ["fill", "split", "fill"]
    assert plan["diagnostics"]["focusSwitches"] == 1


def test_opus_like_framing_centers_safe_faces_and_falls_back_at_source_edges():
    centered = _box(820, 1)
    edge = {**_box(0, 1), "width": 120}

    assert _fill_is_safe(centered, 1920, 1080, "9:16") is True
    assert _fill_is_safe(edge, 1920, 1080, "9:16") is False

    plan = composition_plan(
        {"id": "clip-001", "start": 0, "end": 1},
        {
            "width": 1920,
            "height": 1080,
            "detectionRate": 1,
            "samples": [
                {
                    "time": 0,
                    "boxes": [edge],
                    "activeSpeakerConfidence": 1,
                },
                {
                    "time": 0.75,
                    "boxes": [edge],
                    "activeSpeakerConfidence": 1,
                },
            ],
        },
        aspect="9:16",
    )

    assert plan["framing"]["name"] == "social-center-v1"
    assert plan["scenes"][0]["layout"] == "fit"
    assert plan["scenes"][0]["framingFallback"] is True
    assert plan["diagnostics"]["framingFallbackSamples"] == 2


def test_yolo_person_boxes_target_the_head_instead_of_rejecting_the_full_body():
    person = {
        "x": 520,
        "y": 50,
        "width": 240,
        "height": 620,
        "confidence": 0.95,
        "activity": 1,
        "subjectKind": "person",
        "trackId": 1,
    }

    assert _subject_focus(person) == (640, 174)
    assert _fill_is_safe(person, 1280, 720, "9:16") is True

    plan = composition_plan(
        {"id": "clip-person", "start": 0, "end": 1},
        {
            "width": 1280,
            "height": 720,
            "detectionRate": 1,
            "samples": [
                {"time": 0, "boxes": [person], "activeSpeakerConfidence": 1},
                {"time": 0.75, "boxes": [person], "activeSpeakerConfidence": 1},
            ],
        },
        aspect="9:16",
    )

    assert plan["scenes"][0]["layout"] == "fill"
    assert plan["scenes"][0]["subjects"][0]["subjectKind"] == "person"
    assert plan["scenes"][0]["subjects"][0]["y"] == 0.24167


def test_distant_background_people_do_not_drive_the_social_crop():
    distant_person = {
        "x": 1100,
        "y": 205,
        "width": 30,
        "height": 61,
        "confidence": 0.9,
        "activity": 1,
        "subjectKind": "person",
    }

    assert _usable_subject_box(distant_person, 1280, 720) is False
    plan = composition_plan(
        {"id": "background-person", "start": 0, "end": 1},
        {
            "width": 1280,
            "height": 720,
            "detectionRate": 1,
            "samples": [
                {"time": 0, "boxes": [distant_person], "activeSpeakerConfidence": 1},
                {"time": 0.75, "boxes": [distant_person], "activeSpeakerConfidence": 1},
            ],
        },
        aspect="9:16",
    )

    assert plan["scenes"][0]["layout"] == "fit"
    assert plan["diagnostics"]["reason"] == "detection-rate"
    assert plan["diagnostics"]["rawDetectionRate"] == 1
    assert plan["diagnostics"]["detectionRate"] == 0


def test_layout_stabilization_cannot_restore_an_unsafe_fill():
    samples = [
        {
            "time": 0,
            "layout": "fit",
            "boxes": [],
            "fillSafe": False,
            "framingSafe": True,
            "framingFallback": False,
        },
        {
            "time": 0.25,
            "layout": "fill",
            "boxes": [_box(820, 1)],
            "fillSafe": True,
            "framingSafe": True,
            "framingFallback": False,
        },
        {
            "time": 1,
            "layout": "fill",
            "boxes": [_box(820, 1)],
            "fillSafe": True,
            "framingSafe": True,
            "framingFallback": False,
        },
    ]

    stabilized = stabilize_layouts(samples, minimum_seconds=0.6)
    assert stabilized[0]["layout"] == "fill"

    safe = enforce_safe_layouts(stabilized)
    assert safe[0]["layout"] == "fit"
    assert safe[0]["framingFallback"] is True
    assert all(value["layout"] != "fill" or value["fillSafe"] for value in safe)


def test_short_detection_dropout_holds_the_same_safe_speaker_crop():
    tracked = {**_box(820, 1), "trackId": 1}
    plan = composition_plan(
        {"id": "dropout", "start": 0, "end": 1},
        {
            "width": 1920,
            "height": 1080,
            "detectionRate": 0.75,
            "samples": [
                {"time": 0, "boxes": [tracked], "activeSpeakerConfidence": 1},
                {"time": 0.25, "boxes": [], "activeSpeakerConfidence": 0},
                {"time": 0.5, "boxes": [tracked], "activeSpeakerConfidence": 1},
                {"time": 0.75, "boxes": [tracked], "activeSpeakerConfidence": 1},
            ],
        },
        aspect="9:16",
    )

    assert [scene["layout"] for scene in plan["scenes"]] == ["fill"]
    assert plan["diagnostics"]["heldDetectionGapSamples"] == 1
    assert plan["diagnostics"]["framingFallbackSamples"] == 0


def test_rendering_uses_the_persisted_center_and_headroom_target():
    assert _framing_target(
        {"framing": {"targetX": 0.5, "targetFaceY": 0.38}}
    ) == (0.5, 0.38)
    xs, ys = _crop_keyframes(
        [{"time": 0, "x": 960, "y": 410}],
        0,
        1920,
        1080,
        606,
        1080,
        0.5,
        0.38,
    )

    assert xs == [(0.0, 656.0)]
    assert ys == [(0.0, 0.0)]


def test_ffmpeg_composition_has_dynamic_crop_transition_captions_brand_and_social_resolution(tmp_path: Path):
    plan = {
        "aspectRatio": "9:16",
        "source": {"width": 1920, "height": 1080},
        "scenes": [
            {
                "start": 0,
                "end": 1,
                "layout": "fill",
                "keyframes": [
                    {"time": 0, "x": 500, "y": 400},
                    {"time": 0.5, "x": 700, "y": 420},
                ],
                "subjects": [],
            },
            {"start": 1, "end": 2, "layout": "fit", "keyframes": [], "subjects": []},
        ],
    }
    graph, label = _composition_filter_graph(
        plan,
        {"id": "clip-001", "start": 0, "end": 2},
        {"ass": str(tmp_path / "caption.ass")},
        {"maxSourceShortSide": 1080, "watermarkText": "PicaShorts"},
        watermark=False,
    )
    assert "crop=606:1080:x='if(" in graph
    assert "scale=1080:1920" in graph
    assert "xfade=transition=fade:duration=0.180" in graph
    assert graph.count("fps=30,settb=AVTB,format=yuv420p") == 2
    assert "ass='" in graph and "drawtext=text='PicaShorts'" in graph
    assert label == "branded"


def test_composition_windowed_detection_rate_only_falls_back_for_the_low_detection_scene():
    clip = {"id": "clip-001", "start": 0, "end": 7}
    times = [0, 1, 2, 3, 4, 5, 6, 7]
    # A 2s stretch around t=3-4 has no usable boxes; the rest of the clip does.
    # A low aggregate `detectionRate` (as vision.py reports over every decoded
    # frame, not just these coarse samples) alone must not blur the whole clip.
    samples = [
        {
            "time": time,
            "boxes": [] if time in (3, 4) else [_box(200, 1)],
            "activeSpeakerConfidence": 0 if time in (3, 4) else 1,
        }
        for time in times
    ]
    analysis = {
        "width": 1920,
        "height": 1080,
        "detectionRate": 0.2,
        "samples": samples,
    }

    plan = composition_plan(clip, analysis, aspect="9:16")

    assert plan["diagnostics"]["status"] == "ready"
    bad_scenes = [scene for scene in plan["scenes"] if 3 <= scene["start"] < 5]
    good_scenes = [scene for scene in plan["scenes"] if scene["start"] < 2 or scene["start"] >= 6]
    assert bad_scenes and all(scene["layout"] == "fit" for scene in bad_scenes)
    assert good_scenes and all(scene["layout"] == "fill" for scene in good_scenes)
    assert plan["diagnostics"]["lowDetectionWindowSamples"] == 2


def test_windowed_usable_rates_only_dips_around_the_bad_window():
    times = [0, 1, 2, 3, 4, 5, 6]
    usable = [True, True, True, False, False, True, True]

    rates = _windowed_usable_rates(times, usable, window_seconds=2.0)

    assert rates[0] == 1.0
    assert rates[3] < 0.35
    assert rates[6] == 1.0


def test_cross_talk_forces_split_when_both_speakers_sustain_comparable_activity():
    samples = [
        {"time": 0.0, "layout": "fill", "boxes": [_box(100, 0.85), _box(1200, 0.05)]},
        {"time": 0.2, "layout": "fill", "boxes": [_box(100, 0.7), _box(1200, 0.6)]},
        {"time": 0.4, "layout": "fill", "boxes": [_box(100, 0.7), _box(1200, 0.6)]},
        {"time": 0.6, "layout": "fill", "boxes": [_box(100, 0.7), _box(1200, 0.6)]},
        {"time": 0.8, "layout": "fill", "boxes": [_box(100, 0.7), _box(1200, 0.6)]},
        {"time": 1.0, "layout": "fill", "boxes": [_box(100, 0.7), _box(1200, 0.6)]},
        {"time": 1.2, "layout": "fill", "boxes": [_box(100, 0.85), _box(1200, 0.05)]},
    ]

    result = detect_cross_talk(samples)

    assert [value["layout"] for value in result] == [
        "fill", "split", "split", "split", "split", "split", "fill",
    ]
    assert [bool(value.get("crossTalk")) for value in result] == [
        False, True, True, True, True, True, False,
    ]


def test_cross_talk_requires_sustained_activity_not_a_brief_blip():
    samples = [
        {"time": 0.0, "layout": "fill", "boxes": [_box(100, 0.85), _box(1200, 0.05)]},
        {"time": 0.2, "layout": "fill", "boxes": [_box(100, 0.7), _box(1200, 0.6)]},
        {"time": 0.4, "layout": "fill", "boxes": [_box(100, 0.7), _box(1200, 0.6)]},
        {"time": 0.6, "layout": "fill", "boxes": [_box(100, 0.85), _box(1200, 0.05)]},
    ]

    result = detect_cross_talk(samples)

    assert [value["layout"] for value in result] == ["fill", "fill", "fill", "fill"]
    assert not any(value.get("crossTalk") for value in result)


def test_ai_covered_samples_are_not_reprocessed_by_visual_cross_talk_fallback():
    samples = [
        {
            "time": time,
            "layout": "fill",
            "aiCovered": True,
            "boxes": [_box(100, 0.7), _box(1200, 0.6)],
        }
        for time in (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)
    ]

    result = detect_cross_talk(samples)

    # Activities here would clearly read as cross-talk to the visual
    # heuristic, but the AI signal already had an opinion for these samples --
    # the visual fallback must not override it.
    assert all(value["layout"] == "fill" for value in result)
    assert not any(value.get("crossTalk") for value in result)


def test_ai_cross_talk_overrides_visual_confidence_even_when_top_speaker_is_confident():
    clip = {"id": "clip-001", "start": 0, "end": 1}
    analysis = {
        "width": 1920,
        "height": 1080,
        "detectionRate": 1,
        "samples": [
            {
                "time": 0.0,
                "boxes": [_box(100, 0.9), _box(1200, 0.1)],
                "activeSpeakerConfidence": 0.9,
                "aiCrossTalk": True,
            },
        ],
    }

    plan = composition_plan(clip, analysis, aspect="9:16")

    assert plan["scenes"][0]["layout"] == "split"


def test_combine_ai_speaker_activity_matches_reported_position_to_nearest_track():
    analysis = {
        "width": 1920,
        "height": 1080,
        "samples": [
            {"time": 0.5, "boxes": [_box(100, 0.1), _box(1200, 0.1)]},
        ],
    }
    intervals = [
        {
            "start": 0.0,
            "end": 1.0,
            "speakers": [{"xRatio": 0.7, "yRatio": 0.3}],  # closer to the right box
            "crossTalk": False,
        }
    ]

    _combine_ai_speaker_activity(analysis, intervals)

    sample = analysis["samples"][0]
    assert sample["aiCovered"] is True
    left_box, right_box = sample["boxes"]
    assert right_box["activity"] >= 0.85
    assert left_box["activity"] < right_box["activity"]
    assert analysis["activeSpeakerMethod"] == "ai-video-plus-visual-track"


def test_combine_ai_speaker_activity_marks_cross_talk_when_two_speakers_reported():
    analysis = {
        "width": 1920,
        "height": 1080,
        "samples": [
            {"time": 0.5, "boxes": [_box(100, 0.5), _box(1200, 0.5)]},
        ],
    }
    intervals = [
        {
            "start": 0.0,
            "end": 1.0,
            "speakers": [{"xRatio": 0.1, "yRatio": 0.3}, {"xRatio": 0.9, "yRatio": 0.3}],
            "crossTalk": True,
        }
    ]

    _combine_ai_speaker_activity(analysis, intervals)

    sample = analysis["samples"][0]
    assert sample["aiCovered"] is True
    assert sample["aiCrossTalk"] is True


def test_split_scene_orders_subjects_by_stable_track_id_not_momentary_activity():
    low_id_low_activity = {**_box(100, 0.2), "trackId": 1}
    high_id_high_activity = {**_box(1200, 0.9), "trackId": 2}
    samples = [
        {
            "time": 0.0,
            "layout": "split",
            "activeTrackId": 2,
            "confidence": 0.5,
            "boxes": [high_id_high_activity, low_id_low_activity],
        }
    ]
    keyframes = [{"time": 0.0, "x": 960, "y": 540, "confidence": 0.5}]

    scenes = _scenes(samples, keyframes, 0.0, 1.0, 1920, 1080)

    assert [subject["trackId"] for subject in scenes[0]["subjects"]] == [1, 2]


def test_split_scenes_are_not_fragmented_by_active_track_id_changes():
    box1 = {**_box(100, 0.7), "trackId": 1}
    box2 = {**_box(1200, 0.6), "trackId": 2}
    samples = [
        {"time": 0.0, "layout": "split", "activeTrackId": 1, "confidence": 0.5, "boxes": [box1, box2]},
        {"time": 0.2, "layout": "split", "activeTrackId": 2, "confidence": 0.5, "boxes": [box2, box1]},
        {"time": 0.4, "layout": "split", "activeTrackId": 1, "confidence": 0.5, "boxes": [box1, box2]},
    ]
    keyframes = [
        {"time": 0.0, "x": 960, "y": 540, "confidence": 0.5},
        {"time": 0.2, "x": 960, "y": 540, "confidence": 0.5},
        {"time": 0.4, "x": 960, "y": 540, "confidence": 0.5},
    ]

    scenes = _scenes(samples, keyframes, 0.0, 0.6, 1920, 1080)

    assert len(scenes) == 1
    assert scenes[0]["layout"] == "split"


def test_ffmpeg_composition_vstack_filter_graph_shape():
    plan = {
        "aspectRatio": "9:16",
        "source": {"width": 1920, "height": 1080},
        "scenes": [
            {
                "start": 0,
                "end": 2,
                "layout": "split",
                "subjects": [
                    {"x": 0.3, "y": 0.4, "width": 0.2, "height": 0.5, "subjectKind": "face", "trackId": 1},
                    {"x": 0.3, "y": 0.4, "width": 0.2, "height": 0.5, "subjectKind": "face", "trackId": 2},
                ],
                "keyframes": [],
            }
        ],
    }
    graph, _label = _composition_filter_graph(
        plan,
        {"id": "clip-001", "start": 0, "end": 2},
        None,
        {"maxSourceShortSide": 1080},
        watermark=False,
    )
    # No `orientation` key on the scene -- must default to the existing vstack
    # behaviour so plans persisted before this change keep rendering unchanged.
    assert "vstack=inputs=2" in graph
    assert "hstack=inputs=2" not in graph
    assert graph.count("crop=") == 2


def test_ffmpeg_composition_hstack_filter_graph_shape():
    plan = {
        "aspectRatio": "9:16",
        "source": {"width": 1920, "height": 1080},
        "scenes": [
            {
                "start": 0,
                "end": 2,
                "layout": "split",
                "orientation": "hstack",
                "subjects": [
                    {"x": 0.2, "y": 0.4, "width": 0.2, "height": 0.5, "subjectKind": "face", "trackId": 1},
                    {"x": 0.8, "y": 0.4, "width": 0.2, "height": 0.5, "subjectKind": "face", "trackId": 2},
                ],
                "keyframes": [],
            }
        ],
    }
    graph, _label = _composition_filter_graph(
        plan,
        {"id": "clip-001", "start": 0, "end": 2},
        None,
        {"maxSourceShortSide": 1080},
        watermark=False,
    )
    assert "hstack=inputs=2" in graph
    assert "vstack=inputs=2" not in graph
    assert graph.count("crop=") == 2
