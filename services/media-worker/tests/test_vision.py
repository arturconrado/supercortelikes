from media_worker.vision import crop_dimensions, even, output_dimensions, smart_crop_geometry


def test_crop_dimensions_preserve_requested_ratio_inside_source():
    assert crop_dimensions(1920, 1080, 9, 16) == (606, 1080)
    assert crop_dimensions(1080, 1920, 1, 1) == (1080, 1080)
    width, height = output_dimensions(4, 5)
    assert width == 720
    assert height == 900
    assert width % 2 == 0 and height % 2 == 0


def test_even_never_returns_odd_or_zero():
    assert even(0) == 2
    assert even(607) == 606


def test_smart_crop_geometry_targets_only_the_requested_output_ratio():
    geometry = smart_crop_geometry(
        {"width": 1920, "height": 1080, "focus": {"x": 1500, "y": 540}},
        "9:16",
        720,
    )
    assert geometry == {
        "x": 1196,
        "y": 0,
        "width": 606,
        "height": 1080,
        "targetWidth": 720,
        "targetHeight": 1280,
    }
