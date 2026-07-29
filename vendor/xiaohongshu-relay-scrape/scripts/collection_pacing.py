import math
from random import SystemRandom


DEFAULT_SPEED_MODE = "random"
DEFAULT_NOTE_DELAY_SECONDS = 1.2
DEFAULT_RANDOM_DELAY_MIN_SECONDS = 0.8
DEFAULT_RANDOM_DELAY_MAX_SECONDS = 2.4
MAX_DELAY_SECONDS = 60.0

_RANDOM = SystemRandom()


def validate_collection_pacing(
    speed_mode: str,
    note_delay_seconds: float,
    random_delay_min_seconds: float,
    random_delay_max_seconds: float,
) -> None:
    if speed_mode not in {"steady", "random"}:
        raise ValueError("--speed-mode must be steady or random")
    for option, value in (
        ("--note-delay-seconds", note_delay_seconds),
        ("--random-delay-min-seconds", random_delay_min_seconds),
        ("--random-delay-max-seconds", random_delay_max_seconds),
    ):
        if not math.isfinite(value) or value < 0 or value > MAX_DELAY_SECONDS:
            raise ValueError(f"{option} must be between 0 and {MAX_DELAY_SECONDS:g} seconds")
    if random_delay_min_seconds > random_delay_max_seconds:
        raise ValueError("--random-delay-min-seconds must be less than or equal to --random-delay-max-seconds")


def next_collection_delay(
    speed_mode: str,
    note_delay_seconds: float,
    random_delay_min_seconds: float,
    random_delay_max_seconds: float,
) -> float:
    validate_collection_pacing(
        speed_mode,
        note_delay_seconds,
        random_delay_min_seconds,
        random_delay_max_seconds,
    )
    if speed_mode == "steady":
        return note_delay_seconds
    return _RANDOM.uniform(random_delay_min_seconds, random_delay_max_seconds)
