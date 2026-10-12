"""Build clean six-minute narration without a cloud speech subscription."""
import base64
import io
import json
import subprocess
import urllib.request
import wave
from pathlib import Path
import numpy as np
from piper import PiperVoice, SynthesisConfig

ROOT = Path(__file__).resolve().parent

def generate():
    model = ROOT / 'assets' / 'amy.onnx'
    base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/low/en_US-amy-low.onnx'
    for suffix in ('', '.json'):
        dest = Path(str(model) + suffix)
        if not dest.exists():
            urllib.request.urlretrieve(base + suffix, dest)
    voice = PiperVoice.load(model)
    scripts = json.loads((ROOT / 'assets' / 'full_scripts.json').read_text())
    sessions = {}
    for name, lines in scripts.items():
        chunks = []
        for line in lines:
            buf = io.BytesIO()
            with wave.open(buf, 'wb') as wav:
                voice.synthesize_wav(line, wav, SynthesisConfig(length_scale=1.1 if name == 'bedtime' else 1.02, noise_scale=.5, noise_w_scale=.6))
            buf.seek(0)
            with wave.open(buf, 'rb') as wav:
                rate = wav.getframerate()
                chunks.append(np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).copy())
        speech = sum(len(c) for c in chunks) / rate
        target = max(360, speech + 3 * len(lines))
        if target > 420:
            raise ValueError(f'{name} narration exceeds seven minutes')
        pause = np.zeros(round((target - speech) / len(lines) * rate), dtype=np.int16)
        cards, parts, elapsed = [], [], 0.0
        for i, (line, chunk) in enumerate(zip(lines, chunks)):
            cards.append([elapsed, f'{name.upper()} / {i+1:02}', line])
            parts.extend([chunk, pause])
            elapsed += (len(chunk) + len(pause)) / rate
        wav_path = ROOT / 'assets' / f'{name}.wav'
        opus_path = ROOT / 'assets' / f'{name}.opus'
        with wave.open(str(wav_path), 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(rate)
            wav.writeframes(np.concatenate(parts).tobytes())
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(wav_path), '-c:a', 'libopus', '-b:a', '24k', str(opus_path)], check=True)
        (ROOT / 'assets' / f'{name}.opus.b64').write_text(base64.b64encode(opus_path.read_bytes()).decode())
        sessions[name] = {'cards': cards, 'duration': elapsed}
        wav_path.unlink(); opus_path.unlink()
    (ROOT / 'assets' / 'full_sessions.json').write_text(json.dumps(sessions))

if __name__ == '__main__':
    generate()
