import json
import os
import re
from typing import List, Optional


# Amateur radio callsign pattern — covers US and international allocations.
# US:   [AKNW][A-Z]?\d[A-Z]{1,3}       e.g. W1AW, KA2ABC, N3X
# Intl: [A-Z]{1,2}\d[A-Z]{1,4}         e.g. VE3ABC, G4XYZ, JA1ABC, DL1XYZ
# Intl: \d[A-Z]{1,2}\d[A-Z]{1,4}       e.g. 3D2ABC, 9A1XYZ, 4X1ABC
# All branches require the total match to be >= 4 characters (enforced in
# is_valid_callsign) to reject noise like "A1B".
CALLSIGN_PATTERN = re.compile(
    r"\b(?:"
    r"[AKNW][A-Z]?\d[A-Z]{1,3}"         # US
    r"|[A-Z]{1,2}\d[A-Z]{1,4}"           # international 1-2 letter prefix
    r"|\d[A-Z]{1,2}\d[A-Z]{1,4}"         # international digit-led prefix
    r")\b",
    re.IGNORECASE,
)

# Words / tokens that accidentally match callsign regex patterns but are not
# real callsigns.  All entries MUST be uppercase.
_CALLSIGN_BLACKLIST: set[str] = {
    # Common English words / abbreviations that match [A-Z]{1,2}\d[A-Z]{1,4}
    "AM1", "AM2", "AN1", "AN2", "AS1", "AT1", "AT2",
    "BE1", "BE2", "BY1", "BY2",
    "DO1", "DO2",
    "GO1", "GO2",
    "HA1", "HA2", "HE1", "HE2", "HI1", "HI2",
    "IF1", "IF2",
    "IS1", "IS2", "IT1", "IT2",
    "LA1", "LA2",
    "ME1", "ME2", "MY1", "MY2",
    "NO1", "NO2",
    "OF1", "OF2", "OK1", "OK2", "ON1", "ON2", "OR1", "OR2",
    "SO1", "SO2",
    "TO1", "TO2",
    "UP1", "UP2", "US1", "US2",
    "WE1", "WE2",
    # Ollama hallucination patterns — repeated/sequential characters
    "AA1AAA", "BB2BBB", "CC3CCC", "ZZ9ZZZ",
    "AB1CDE", "QQ1QQQ", "XX1XXX",
    # Other common false positives from LLM output
    "FM1", "FM2", "AM1FM", "FM1AM",
    "HF1", "HF2", "VHF1", "UHF1",
    "RF1", "RF2", "DB1", "DB2",
    "ID1", "ID2", "QC1", "QC2",
}


# Anchored version of CALLSIGN_PATTERN for standalone validation (no \b needed)
_CALLSIGN_FULL = re.compile(
    r"^(?:"
    r"[AKNW][A-Z]?\d[A-Z]{1,3}"
    r"|[A-Z]{1,2}\d[A-Z]{1,4}"
    r"|\d[A-Z]{1,2}\d[A-Z]{1,4}"
    r")$",
    re.IGNORECASE,
)


def is_valid_callsign(cs: str) -> bool:
    """Validate that a string looks like a real amateur radio callsign.

    Rules:
    - Must be 4+ characters (rejects ultra-short noise like A1B)
    - Must match the callsign structural pattern
    - Must not be in the blacklist
    - Must contain at least one digit (sanity check)
    - Must not have all-same-letter suffix (e.g. Q9QQQ → reject)
    """
    upper = cs.strip().upper()
    if len(upper) < 4:
        return False
    if upper in _CALLSIGN_BLACKLIST:
        return False
    if not _CALLSIGN_FULL.match(upper):
        return False
    # Must contain at least one digit
    if not any(c.isdigit() for c in upper):
        return False
    # Reject if suffix (letters after the digit) are all the same character
    # e.g. Q9QQQ → suffix = QQQ → suspicious
    m = re.search(r"\d([A-Z]+)$", upper)
    if m:
        suffix = m.group(1)
        if len(suffix) >= 3 and len(set(suffix)) == 1:
            return False
    return True

NO_SPEECH_PATTERN = re.compile(
    r"^\s*(?:"
    r"\[?\s*no speech detected\s*\]?"
    r"|\[?\s*recording too long for auto-transcribe\s*\]?"
    r"|[^\w\s]+"
    r"|thanks?\s+(?:you\s+)?(?:for\s+)?(?:watching|listening|joining|tuning\s+in|being\s+here)\.?"
    r"|(?:thank\s+you|bye|goodbye|see\s+you)(?:\s+for\s+(?:watching|listening|joining))?\.?"
    r"|you\.?"
    r"|\[(?:music|applause|laughter|silence|noise|inaudible)[^\]]*\]"
    r"|\[?\s*\[?(?:BLANK_AUDIO|blank\s*audio)\]?\s*\]?"
    r")\s*$",
    re.IGNORECASE,
)

PHONETIC_MAP = {
    "ALFA": "A", "ALPHA": "A", "BRAVO": "B", "CHARLIE": "C", "DELTA": "D",
    "ECHO": "E", "FOXTROT": "F", "GOLF": "G", "HOTEL": "H", "INDIA": "I",
    "JULIETT": "J", "JULIET": "J", "KILO": "K", "LIMA": "L", "MIKE": "M",
    "NOVEMBER": "N", "OSCAR": "O", "PAPA": "P", "QUEBEC": "Q", "ROMEO": "R",
    "SIERRA": "S", "TANGO": "T", "UNIFORM": "U", "VICTOR": "V", "WHISKEY": "W",
    "XRAY": "X", "X-RAY": "X", "YANKEE": "Y", "ZULU": "Z",
    "ZERO": "0", "OH": "0", "ONE": "1", "TWO": "2", "TOO": "2",
    "THREE": "3", "TREE": "3", "FOUR": "4", "FIVE": "5", "SIX": "6",
    "SEVEN": "7", "EIGHT": "8", "NINE": "9", "NINER": "9",
}


def normalize_callsign(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", value.upper())


def callsign_hints() -> List[str]:
    raw = os.getenv("CALLSIGN_HINTS", "N0CALL")
    hints: List[str] = []
    for token in raw.split(","):
        normalized = normalize_callsign(token.strip())
        if normalized:
            hints.append(normalized)
    return hints


def phonetic_compact(text: str) -> str:
    tokens = re.findall(r"[A-Z0-9-]+", text.upper())
    compact: List[str] = []
    for token in tokens:
        mapped = PHONETIC_MAP.get(token)
        if mapped:
            compact.append(mapped)
            continue
        if len(token) == 1 and token.isalnum():
            compact.append(token)
            continue
        if token.isdigit():
            compact.append(token)
    return "".join(compact)


def extract_callsign_tags(transcript: Optional[str]) -> List[str]:
    if not transcript:
        return []
    tags: List[str] = []
    seen = set()
    for match in CALLSIGN_PATTERN.finditer(transcript):
        tag = normalize_callsign(match.group(0))
        if tag and tag not in seen and is_valid_callsign(tag):
            seen.add(tag)
            tags.append(tag)
    normalized_text = normalize_callsign(transcript)
    phonetic_text = phonetic_compact(transcript)
    for hint in callsign_hints():
        if (hint in normalized_text or hint in phonetic_text) and hint not in seen:
            seen.add(hint)
            tags.append(hint)
    return tags


def is_no_speech_transcript(transcript: Optional[str]) -> bool:
    if not transcript:
        return False
    return NO_SPEECH_PATTERN.match(transcript) is not None


def parse_ai_tags(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    if isinstance(raw, list):
        value = raw
    elif isinstance(raw, tuple):
        value = list(raw)
    else:
        try:
            value = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return []
    if not isinstance(value, list):
        return []
    tags: List[str] = []
    seen = set()
    for item in value:
        if not isinstance(item, str):
            continue
        cleaned = item.strip()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            tags.append(cleaned)
    return tags


def dump_ai_tags(tags: List[str], allow_empty: bool = False) -> Optional[str]:
    cleaned: List[str] = []
    seen = set()
    for tag in tags:
        normalized = tag.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            cleaned.append(normalized)
    if not cleaned:
        return "[]" if allow_empty else None
    return json.dumps(cleaned)


def has_all_ai_tags(raw_tags, *required_tags: str) -> bool:
    required = {tag.strip() for tag in required_tags if tag and tag.strip()}
    if not required:
        return False
    if isinstance(raw_tags, list):
        present = {str(tag).strip() for tag in raw_tags if str(tag).strip()}
    else:
        present = set(parse_ai_tags(raw_tags))
    return required.issubset(present)
