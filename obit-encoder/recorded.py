"""Recorded broadcasting; daily event creation requires YouTube OAuth."""
import datetime as dt
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import httpx
from encoder import destination, encoder_failure, ConfigurationError

ROOT = Path(__file__).resolve().parent
CHANNEL = 'UC2cjo3492WY8JtfB1tq7dwA'
DESCRIPTION = ('Join Obit Billionaires Affirmations for a daily practice of confidence, discipline, gratitude and purposeful action. '
               'This broadcast uses a recorded guide. Repeat each statement aloud during the pauses and share your commitment in live chat. '
               'Affirmations encourage reflection and action; they do not guarantee financial outcomes.')

class YouTubeError(RuntimeError):
    pass

def required(name):
    value=os.environ.get(name,'').strip()
    if not value:
        raise ConfigurationError(name+' is required')
    return value

class YouTube:
    def __init__(self, client):
        self.client=client
        self.token=None

    def request(self, method, path, **kwargs):
        response=self.client.request(method,'https://www.googleapis.com/youtube/v3/'+path,
                                     headers={'Authorization':'Bearer '+self.token},**kwargs)
        if not response.is_success:
            raise YouTubeError('YouTube '+path+' request failed (HTTP '+str(response.status_code)+')')
        return response.json()

    def authorize(self):
        response=self.client.post('https://oauth2.googleapis.com/token',data={
            'client_id':required('YOUTUBE_CLIENT_ID'), 'client_secret':required('YOUTUBE_CLIENT_SECRET'),
            'refresh_token':required('YOUTUBE_REFRESH_TOKEN'), 'grant_type':'refresh_token'})
        if not response.is_success:
            raise YouTubeError('YouTube authorization failed (HTTP '+str(response.status_code)+')')
        self.token=response.json()['access_token']
        channels=self.request('GET','channels',params={'part':'id','mine':'true'})['items']
        if not any(c['id']==CHANNEL for c in channels):
            raise YouTubeError('YouTube authorization belongs to a different channel')

    def items(self, path, params):
        result=[]
        for _ in range(5):
            data=self.request('GET',path,params=params)
            result.extend(data.get('items',[]))
            if not data.get('nextPageToken'):
                return result
            params={**params,'pageToken':data['nextPageToken']}
        raise YouTubeError('YouTube pagination limit reached; no broadcast created')

    def prepare(self, stream_key, visibility, now=None):
        self.authorize()
        now=now or dt.datetime.now(dt.timezone.utc)
        lagos=now.astimezone(dt.timezone(dt.timedelta(hours=1)))
        title='Obit Billionaires | Daily Prosperity Affirmations | '+lagos.date().isoformat()
        streams=self.items('liveStreams',{'part':'id,cdn','mine':'true','maxResults':50})
        key=destination(stream_key).rsplit('/',1)[1]
        matches=[s for s in streams if s.get('cdn',{}).get('ingestionInfo',{}).get('streamName')==key]
        if len(matches)!=1:
            raise YouTubeError('Saved stream key does not match one authorized YouTube stream')
        broadcasts=self.items('liveBroadcasts',{'part':'id,snippet,status,contentDetails','mine':'true','maxResults':50,'broadcastType':'all'})
        if any(b.get('status',{}).get('lifeCycleStatus') in ('live','liveStarting','testing','testStarting') for b in broadcasts):
            raise YouTubeError('An existing broadcast is active; no second broadcast started')
        today=[b for b in broadcasts if b['snippet']['title']==title]
        if len(today)>1:
            raise YouTubeError('Multiple events exist for today; no broadcast started')
        if today:
            broadcast=today[0]
            if broadcast['status']['lifeCycleStatus']=='complete':
                raise YouTubeError('Today\u2019s broadcast already completed; no repeat started')
            if broadcast['status'].get('privacyStatus')!=visibility:
                raise YouTubeError('Existing event visibility differs from configured visibility')
            if broadcast.get('contentDetails',{}).get('boundStreamId') not in (None,'',matches[0]['id']):
                raise YouTubeError('Existing event is bound to a different stream')
        else:
            broadcast=self.request('POST','liveBroadcasts',params={'part':'snippet,status,contentDetails'},json={
                'snippet':{'title':title,'description':DESCRIPTION,'scheduledStartTime':(now+dt.timedelta(seconds=30)).isoformat()},
                'status':{'privacyStatus':visibility,'selfDeclaredMadeForKids':False},
                'contentDetails':{'enableAutoStart':True,'enableAutoStop':True,'enableDvr':True,
                                 'monitorStream':{'enableMonitorStream':False},'recordFromStart':True}})
        bound=self.request('POST','liveBroadcasts/bind',params={'part':'id,status,contentDetails','id':broadcast['id'],'streamId':matches[0]['id']})
        if bound.get('contentDetails',{}).get('boundStreamId')!=matches[0]['id']:
            raise YouTubeError('YouTube stream binding was not confirmed')
        details=self.request('GET','liveBroadcasts',params={'part':'id,status,contentDetails','id':broadcast['id']})['items'][0]
        if details['status'].get('privacyStatus')!=visibility or not details['contentDetails'].get('enableAutoStart') or not details['contentDetails'].get('enableAutoStop'):
            raise YouTubeError('YouTube visibility or automatic start/stop was not confirmed')
        print('Daily YouTube event prepared: '+broadcast['id'],flush=True)
        return broadcast['id']

    def finish(self, broadcast_id):
        details=self.request('GET','liveBroadcasts',params={'part':'status','id':broadcast_id})['items'][0]
        status=details['status']['lifeCycleStatus']
        if status=='complete':
            return
        if status in ('live','testing'):
            self.request('POST','liveBroadcasts/transition',params={'part':'status','id':broadcast_id,'broadcastStatus':'complete'})
        else:
            raise YouTubeError('YouTube never entered live playback; event remains pending')

def run():
    if os.environ.get('ENABLE_RECORDED')!='true':
        print('Recorded broadcast disabled. No provider session or stream started.',flush=True)
        return
    mode=os.environ.get('BROADCAST_MODE','rehearsal')
    if mode not in ('rehearsal','daily'):
        raise ConfigurationError('BROADCAST_MODE must be rehearsal or daily')
    visibility=os.environ.get('DESTINATION_VISIBILITY','unlisted')
    if visibility not in ('unlisted','public') or (mode=='rehearsal' and visibility!='unlisted'):
        raise ConfigurationError('Rehearsal destination must be unlisted')
    output=destination(required('YOUTUBE_STREAM_KEY'))
    metadata=json.loads((ROOT/'media/metadata.json').read_text())
    repeats=1 if mode=='rehearsal' else 3
    duration=metadata['duration']*repeats
    with httpx.Client(timeout=30) as client:
        youtube=YouTube(client); broadcast=None
        if mode=='daily':
            broadcast=youtube.prepare(required('YOUTUBE_STREAM_KEY'),visibility)
        print('Recorded playback started: '+str(round(duration))+' seconds; no LiveAvatar session.',flush=True)
        cmd=['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-re','-stream_loop',str(repeats-1),'-i',str(ROOT/'media/affirmations.mp4'),
             '-t',str(duration),'-c:v','copy','-c:a','copy','-f','flv',output]
        process=subprocess.Popen(cmd,stderr=subprocess.PIPE,stdout=subprocess.DEVNULL)
        def stop(signum,frame):
            process.terminate()
        prior={s:signal.signal(s,stop) for s in (signal.SIGTERM,signal.SIGINT)}
        try:
            try:
                _,stderr=process.communicate(timeout=duration+90)
            except subprocess.TimeoutExpired:
                process.kill(); process.communicate()
                raise RuntimeError('Recorded encoder exceeded its bounded runtime') from None
            if process.returncode!=0:
                raise RuntimeError(encoder_failure(stderr))
            if broadcast:
                youtube.finish(broadcast)
            print('Recorded playback completed successfully.',flush=True)
        finally:
            if process.poll() is None:
                process.kill(); process.wait()
            for s,handler in prior.items():
                signal.signal(s,handler)

if __name__=='__main__':
    try:
        run()
    except (ConfigurationError,YouTubeError,RuntimeError) as error:
        print('Recorded broadcast failed: '+str(error),flush=True)
        sys.exit(1)
    except Exception as error:
        print('Recorded broadcast failed: '+type(error).__name__,flush=True)
        sys.exit(1)
