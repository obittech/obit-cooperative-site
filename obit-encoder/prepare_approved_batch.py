"""Validate and package existing approved media. No speech generation or network."""
import json
from pathlib import Path
import subprocess
from fresh_prayer import recording
root=Path(__file__).resolve().parent
for plan in json.loads((root/'assets/prayer_plans.json').read_text()):
    video,duration=recording(root,plan['date'],plan['slot'])
    target=video.with_name('broadcast.mp4')
    subprocess.run(['ffmpeg','-v','error','-y','-i',str(video),
        '-filter_complex','[0:v]tpad=start_duration=60:start_mode=clone[v];[0:a]adelay=60000:all=1[a]',
        '-map','[v]','-map','[a]','-c:v','libx264','-preset','veryfast','-crf','24',
        '-c:a','aac','-b:a','96k','-movflags','+faststart',str(target)],check=True)
    print('Approved batch packaged: '+plan['date']+' '+plan['slot'],flush=True)
