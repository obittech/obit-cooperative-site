"""Date-bound prayer plans and verified recordings. No speech/provider calls.

Activation is separate from deployment. Never use an old recording as a fresh
session, or synthesize speech without the approved voice/budget connection.
"""
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import subprocess

INTROS = {
    'morning': 'Dear Obit Billionaires, join us in this morning prayer. Repeat after me.',
    'work': 'Dear Obit Billionaires, join us in this work hour prayer. Repeat after me.',
    'bedtime': 'Dear Obit Billionaires, join us in this bedtime prayer. Repeat after me.',
}


def fingerprint(lines):
    # Ignore ordering and punctuation: shuffling yesterday's statements is not
    # fresh content. The approved recurring introduction is excluded.
    normalized = sorted(re.sub(r'\W+', ' ', line.casefold()).strip() for line in lines)
    return hashlib.sha256('\n'.join(normalized).encode()).hexdigest()


def validate_catalog(plans):
    keys, bodies = set(), set()
    for plan in plans:
        day, slot = plan['date'], plan['slot']
        if dt.date.fromisoformat(day).isoformat() != day or slot not in INTROS:
            raise ValueError('Invalid prayer date or slot')
        if plan['intro'] != INTROS[slot]:
            raise ValueError('Prayer introduction differs from approved wording')
        lines = plan['lines']
        if not isinstance(lines, list) or not 30 <= len(lines) <= 48:
            raise ValueError('Prayer requires 30–48 statements')
        if any(not isinstance(line, str) or not line.strip() or len(line) > 250 for line in lines):
            raise ValueError('Invalid prayer statement')
        normalized = [re.sub(r'\W+', ' ', line.casefold()).strip() for line in lines]
        if len(set(normalized)) != len(lines):
            raise ValueError('Repeated statement within prayer')
        key = (day, slot)
        body = fingerprint(lines)
        if key in keys or body in bodies:
            raise ValueError('Duplicate prayer slot or repeated prayer content')
        keys.add(key)
        bodies.add(body)
    return plans


def probe_duration(path):
    return float(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=nw=1:nk=1', str(path)], text=True))


def recording(root, day, slot, probe=probe_duration):
    """Fail before YouTube event creation if the exact fresh media is absent.

    A manifest is written only after listening/visual QA establishes the
    recording speaks the plan, includes response pauses and the official logo.
    A hash alone does not establish that semantic review.
    """
    root = Path(root)
    catalog = validate_catalog(json.loads((root/'assets/prayer_plans.json').read_text()))
    plans = [p for p in catalog if p['date'] == day and p['slot'] == slot]
    if len(plans) != 1:
        raise ValueError('No unique fresh prayer plan for this date and slot')
    directory = root/'media'/day/slot
    manifest = json.loads((directory/'verified.json').read_text())
    plan = plans[0]
    if (manifest.get('date'), manifest.get('slot'), manifest.get('script_sha256')) != (
            day, slot, fingerprint(plan['lines'])):
        raise ValueError('Fresh recording does not match this prayer plan')
    if manifest.get('reviewed_audio_visual') is not True:
        raise ValueError('Fresh recording has not passed audio and visual review')
    path = directory/'full.mp4'
    if hashlib.sha256(path.read_bytes()).hexdigest() != manifest.get('video_sha256'):
        raise ValueError('Fresh recording checksum mismatch')
    duration = probe(path)
    if not 300 <= duration <= 420:
        raise ValueError('Full prayer must be five to seven minutes')
    return path, duration
