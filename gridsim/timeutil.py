from datetime import datetime
from zoneinfo import ZoneInfo

from gridsim.config import CHICAGO

CENTRAL = ZoneInfo(CHICAGO)


def parse_ercot_ts(value: str) -> datetime:
    text = value.strip().replace(" ", "T")
    if len(text) >= 5 and text[-5] in "+-" and text[-3] != ":":
        text = text[:-2] + ":" + text[-2:]
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=CENTRAL)
    return parsed.astimezone(CENTRAL)


def now_central() -> datetime:
    return datetime.now(CENTRAL)


def iso(value: datetime) -> str:
    return value.astimezone(CENTRAL).isoformat(timespec="seconds")
