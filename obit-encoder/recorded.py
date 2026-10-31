"""Recorded broadcasting; daily event creation requires YouTube OAuth."""
import datetime as dt
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import httpx
from encoder import destination, encoder_failure, ConfigurationError

ROOT = Path(__file__).resolve().parent
CHANNEL = 'UC2cjo3492WY8JtfB1tq7dwA'
DESCRIPTION = ('Join Obit Billionaires Affirmations for a daily practice of confidence, discipline, gratitude and purposeful action. '
               'This broadcast uses a recorded guide. Repeat each statement aloud during the pauses and share your commitment in live chat. '
               'Affirmations encourage reflection and action; they do not guarantee financial outcomes.')

def session_at(now):
    hour = now.astimezone(dt.timezone(dt.timedelta(hours=1))).hour
    return 'morning' if hour < 12 else ('work' if hour < 18 else 'bedtime')

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
        self.stream_id=None
        self.prepared_id=None
        self.visibility=None
        self.ready_observations=0
        self.live_transition_attempted=False
        self.testing_transition_attempted=False

    def request(self, method, path, **kwargs):
        response=self.client.request(method,'https://www.googleapis.com/youtube/v3/'+path,
                                     headers={'Authorization':'Bearer '+self.token},**kwargs)
        if not response.is_success:
            # Log only documented machine codes, never messages, tokens or bodies.
            allowed={'errorExecutingTransition','errorStreamInactive','invalidTransition','redundantTransition',
                     'insufficientLivePermissions','livePermissionBlocked','liveStreamingNotEnabled',
                     'liveBroadcastNotFound','userRequestsExceedRateLimit','concurrentBroadcastsExceedLimit',
                     'sharedIngestionBroadcastsExceedLimit','idRequired','statusRequired',
                     'insufficientPermissions','quotaExceeded','dailyLimitExceeded','forbidden'}
            reasons=[]
            try:
                reasons=sorted({entry.get('reason') for entry in response.json().get('error',{}).get('errors',[])
                                if isinstance(entry,dict) and entry.get('reason') in allowed})
            except (ValueError,TypeError,AttributeError):
                pass
            detail='; reason='+','.join(reasons) if reasons else '; reason=unclassified'
            raise YouTubeError('YouTube '+path+' request failed (HTTP '+str(response.status_code)+detail+')')
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
        slot=session_at(now)
        title='Obit Billionaires | '+slot.title()+' Affirmations | '+lagos.date().isoformat()
        streams=self.items('liveStreams',{'part':'id,cdn','mine':'true','maxResults':50})
        key=destination(stream_key).rsplit('/',1)[1]
        matches=[s for s in streams if s.get('cdn',{}).get('ingestionInfo',{}).get('streamName')==key]
        if len(matches)!=1:
            raise YouTubeError('Saved stream key does not match one authorized YouTube stream')
        self.stream_id=matches[0]['id']
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
        details=self.broadcast_details(broadcast['id'],'id,status,contentDetails')
        if details['status'].get('privacyStatus')!=visibility or not details['contentDetails'].get('enableAutoStart') or not details['contentDetails'].get('enableAutoStop'):
            raise YouTubeError('YouTube visibility or automatic start/stop was not confirmed')
        print('Daily YouTube event prepared: '+broadcast['id'],flush=True)
        self.prepared_id=broadcast['id']
        self.visibility=visibility
        return broadcast['id']

    def broadcast_details(self, broadcast_id, part):
        # A newly bound event can briefly be absent from the read response.
        # Retry reads only: replaying event creation could create duplicates.
        for attempt in range(4):
            rows=self.request('GET','liveBroadcasts',params={'part':part,'id':broadcast_id}).get('items',[])
            matches=[row for row in rows if row.get('id')==broadcast_id]
            if len(matches)==1:
                return matches[0]
            if rows:
                raise YouTubeError('YouTube returned unexpected broadcast details; playback not confirmed')
            if attempt<3:
                time.sleep(2 ** attempt)
        raise YouTubeError('YouTube broadcast details unavailable after four reads; no replacement event created')

    def observe_playback(self, broadcast_id):
        # Read only, while the encoder is still running. Never log API payloads:
        # stream resources can contain ingestion credentials and private text.
        def state(value, allowed):
            return value if value in allowed else 'unknown'
        try:
            broadcasts=self.request('GET','liveBroadcasts',params={'part':'id,status','id':broadcast_id}).get('items',[])
            streams=self.request('GET','liveStreams',params={'part':'id,status','id':self.stream_id}).get('items',[])
            broadcast=next((b for b in broadcasts if b.get('id')==broadcast_id),{})
            stream=next((s for s in streams if s.get('id')==self.stream_id),{})
            lifecycle=state(broadcast.get('status',{}).get('lifeCycleStatus'),
                            ('created','ready','testing','live','complete','revoked','testStarting','liveStarting'))
            status=stream.get('status',{})
            ingest=state(status.get('streamStatus'),('created','ready','active','inactive','error'))
            health=status.get('healthStatus',{})
            quality=state(health.get('status'),('good','ok','bad','noData'))
            issues=health.get('configurationIssues',[])
            count=len(issues) if isinstance(issues,list) else 0
            print('YouTube playback observation: broadcast='+lifecycle+' ingest='+ingest+
                  ' health='+quality+' configuration_issues='+str(count),flush=True)
            self.ready_observations=self.ready_observations+1 if lifecycle=='ready' and ingest=='active' else 0
            if self.ready_observations>=3 or (lifecycle=='testing' and ingest=='active'):
                self.start_prepared_event(broadcast_id)
        except YouTubeError as error:
            print('YouTube playback check failed: '+str(error),flush=True)
        except Exception:
            # A diagnostics read must not interrupt the encoder or expose secrets.
            print('YouTube playback observation unavailable; encoder continues.',flush=True)

    def start_prepared_event(self, broadcast_id):
        # At most one attempt per required stage on the same prepared event.
        if self.live_transition_attempted or broadcast_id!=self.prepared_id:
            return
        self.authorize()  # Confirm the owned channel again immediately before a write.
        details=self.broadcast_details(broadcast_id,'id,snippet,status,contentDetails')
        status=details.get('status',{})
        content=details.get('contentDetails',{})
        if status.get('lifeCycleStatus') in ('live','liveStarting'):
            return  # Automatic start won the race; do not repeat its transition.
        if (status.get('lifeCycleStatus') not in ('ready','testing') or
            status.get('privacyStatus')!=self.visibility or
            details.get('snippet',{}).get('channelId')!=CHANNEL or
            content.get('boundStreamId')!=self.stream_id):
            raise YouTubeError('Prepared event identity, binding or visibility changed; live transition skipped')
        monitor=content.get('monitorStream',{}).get('enableMonitorStream')
        if not isinstance(monitor,bool):
            raise YouTubeError('Monitor stream setting unavailable; transition skipped')
        target='testing' if status['lifeCycleStatus']=='ready' and monitor else 'live'
        if target=='testing' and self.testing_transition_attempted:
            return
        print('YouTube start sequence: monitor='+('enabled' if monitor else 'disabled')+' target='+target,flush=True)
        streams=self.request('GET','liveStreams',params={'part':'id,status','id':self.stream_id}).get('items',[])
        if not any(s.get('id')==self.stream_id and s.get('status',{}).get('streamStatus')=='active' for s in streams):
            raise YouTubeError('Bound stream is no longer active; live transition skipped')
        if target=='testing':
            self.testing_transition_attempted=True
        else:
            self.live_transition_attempted=True
        result=self.request('POST','liveBroadcasts/transition',params={
            'part':'id,status','id':broadcast_id,'broadcastStatus':target})
        accepted=('testing','testStarting') if target=='testing' else ('live','liveStarting')
        if result.get('id')!=broadcast_id or result.get('status',{}).get('lifeCycleStatus') not in accepted:
            raise YouTubeError('Live transition response did not confirm the prepared event')
        print('Prepared YouTube event '+target+' transition accepted: '+broadcast_id,flush=True)

    def finish(self, broadcast_id):
        details=self.broadcast_details(broadcast_id,'id,status,snippet')
        status=details['status']['lifeCycleStatus']
        if status=='complete':
            if details.get('snippet',{}).get('actualStartTime'):
                return
            raise YouTubeError('Completed event has no actual live start time; public playback not confirmed')
        if status=='live':
            self.request('POST','liveBroadcasts/transition',params={'part':'status','id':broadcast_id,'broadcastStatus':'complete'})
        else:
            raise YouTubeError('YouTube never entered live playback; event remains pending')

def wait_for_recording(process, duration, youtube, broadcast):
    deadline=time.monotonic()+duration+90
    while True:
        remaining=deadline-time.monotonic()
        if remaining<=0:
            process.kill(); process.communicate()
            raise RuntimeError('Recorded encoder exceeded its bounded runtime')
        try:
            return process.communicate(timeout=min(15,remaining))[1]
        except subprocess.TimeoutExpired:
            if broadcast:
                youtube.observe_playback(broadcast)

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
    slot=session_at(dt.datetime.now(dt.timezone.utc)) if mode=='daily' else 'morning'
    print('Selected session: '+slot,flush=True)
    metadata=json.loads((ROOT/'media'/(slot+'-metadata.json')).read_text())
    repeats=1
    duration=metadata['duration']*repeats
    with httpx.Client(timeout=30) as client:
        youtube=YouTube(client); broadcast=None
        if mode=='daily':
            broadcast=youtube.prepare(required('YOUTUBE_STREAM_KEY'),visibility)
        print('Recorded playback started: '+str(round(duration))+' seconds; no LiveAvatar session.',flush=True)
        cmd=['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-re','-stream_loop',str(repeats-1),'-i',str(ROOT/'media'/(slot+'.mp4')),
             '-t',str(duration),'-c:v','copy','-c:a','copy','-f','flv',output]
        process=subprocess.Popen(cmd,stderr=subprocess.PIPE,stdout=subprocess.DEVNULL)
        def stop(signum,frame):
            process.terminate()
        prior={s:signal.signal(s,stop) for s in (signal.SIGTERM,signal.SIGINT)}
        try:
            stderr=wait_for_recording(process,duration,youtube,broadcast)
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
