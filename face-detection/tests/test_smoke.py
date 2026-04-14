from face_clipper.cli import build_parser


def test_parser_defaults() -> None:
    parser = build_parser()
    args = parser.parse_args([])
    assert args.width == 1920
    assert args.height == 1080
