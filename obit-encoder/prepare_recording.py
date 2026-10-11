"""Build a reusable branded recording entirely from checked-in assets."""
import array
import math
import wave
import base64
import json
from pathlib import Path
import subprocess
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
LINES = [
    (0, 'DAILY PROSPERITY AFFIRMATIONS', 'Take a steady breath. Repeat each affirmation aloud during the pause.'),
    (13.094, '01 / VALUE', 'I create value through my skills and service.'),
    (22.867, '02 / OPPORTUNITY', 'I recognise opportunities and take thoughtful action.'),
    (34.899, '03 / DISCIPLINE', 'I manage my money with care, patience, and discipline.'),
    (47.38, '04 / GROWTH', 'I learn every day and improve my abilities.'),
    (56.60, '05 / COMMUNITY', 'I build honest relationships and support my community.'),
    (73.97, '06 / COURAGE', 'I have the courage to begin and the discipline to keep going.'),
    (86.11, '07 / GRATITUDE', 'I am grateful for my progress and ready for the work ahead.'),
    (99.188, 'TODAY\u2019S COMMITMENT', 'Choose one useful action for today. Share your commitment in the live chat.'),
]

def font(size, bold=False):
    return ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans' + ('-Bold' if bold else '') + '.ttf', size)

def wrap(draw, text, face, width):
    lines = []; line = ''
    for word in text.split():
        candidate = (line + ' ' + word).strip()
        if line and draw.textlength(candidate, font=face) > width:
            lines.append(line); line = word
        else:
            line = candidate
    return lines + [line]

def build():
    media = ROOT / 'media'; media.mkdir(exist_ok=True)
    for name in ('logo.jpg', 'voice.opus'):
        (media / name).write_bytes(base64.b64decode((ROOT / 'assets' / (name + '.b64')).read_text(), validate=False))
    logo = Image.open(media / 'logo.jpg').convert('RGB').resize((280, 280))
    duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', str(media / 'voice.opus')]))
    # Original instrumental bed. Keep the voice track silent during response pauses.
    sample_rate = 24000
    chords = [(130.81,164.81,196),(110,130.81,164.81),(87.31,110,130.81),(98,123.47,146.83)]
    samples = array.array('h')
    for sample in range(int(sample_rate * duration)):
        t = sample / sample_rate
        local = t % 8
        envelope = max(0, min(local/1.5, 1, (8-local)/1.5, t/3, (duration-t)/4))
        tone = sum(math.sin(2*math.pi*f*t) + 0.2*math.sin(4*math.pi*f*t) for f in chords[int(t/8)%4])/3
        samples.append(int(32767 * 0.1125 * envelope * tone))
    with wave.open(str(media/'music.wav'), 'wb') as music:
        music.setnchannels(1); music.setsampwidth(2); music.setframerate(sample_rate)
        music.writeframes(samples.tobytes())
    pauses = [(10.4,13.45),(16.65,22),(28.2,34.85),(40.6,47.2),(53.85,56.45),(68.35,74.5),(81.55,87.85),(92.7,99.25),(110.35,duration)]
    mute = '+'.join(f'between(t,{a},{b})' for a,b in pauses)
    audio_filter = f"[1:a]highpass=f=160,afftdn=nf=-22:tn=1,volume='if({mute},0,1)':eval=frame[voice];[voice][2:a]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]"
    concat = []
    for i, (start, label, text) in enumerate(LINES):
        im = Image.new('RGB', (1280,720), '#071f17'); d = ImageDraw.Draw(im)
        d.rounded_rectangle((40,170,360,510), radius=24, fill='white')
        im.paste(logo, (60,190))
        d.text((420,66), 'OBIT BILLIONAIRES', font=font(29,True), fill='#e7be55')
        d.text((420,110), 'AFFIRMATIONS', font=font(18), fill='#b0c6bb')
        d.line((420,168,1200,168), fill='#527a5c', width=2)
        d.text((420,212), label, font=font(18,True), fill='#e7be55')
        face=font(46,True)
        for j,line in enumerate(wrap(d,text,face,780)):
            d.text((420,268+j*66), line, font=face, fill='#f6f8f3')
        d.text((420,588), 'BREATHE. SPEAK. TAKE ACTION.', font=font(19,True), fill='#e7be55')
        d.text((420,630), 'Recorded guide \u00b7 Participate aloud and in live chat', font=font(17), fill='#b0c6bb')
        d.rectangle((40,688,1240,693),fill='#294738')
        d.rectangle((40,688,40+int(1200*(i+1)/len(LINES)),693),fill='#e7be55')
        path=media / f'card-{i}.png'; im.save(path)
        end=LINES[i+1][0] if i+1<len(LINES) else duration
        concat += [f"file '{path}'", f'duration {end-start:.6f}']
    concat.append(f"file '{path}'")
    (media/'cards.txt').write_text('\n'.join(concat)+'\n')
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',str(media/'cards.txt'),'-i',str(media/'voice.opus'),'-i',str(media/'music.wav'),'-filter_complex',audio_filter,'-map','0:v','-map','[a]','-vf','fps=25','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-g','50','-c:a','aac','-b:a','96k','-ar','48000','-t',str(duration),'-movflags','+faststart',str(media/'affirmations.mp4')],check=True)
    (media/'metadata.json').write_text(json.dumps({'duration':duration,'voice':'Amy - Voice 1','provider':'HeyGen','request_id':'025a5030157642d2a627db9feab85a1e'}))
    print('Reusable recording built:',round(duration,2),'seconds',flush=True)

if __name__ == '__main__':
    build()
