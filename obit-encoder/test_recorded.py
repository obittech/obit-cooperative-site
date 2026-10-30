import datetime as dt
import io
import os
import subprocess
import unittest
from unittest.mock import Mock, patch
import httpx
from recorded import YouTube, YouTubeError, CHANNEL, session_at, wait_for_recording

class DailyEventTests(unittest.TestCase):
    def fixture(self, channel=CHANNEL, broadcasts=None):
        self.posts=[]
        state={'id':'new-event','status':{'privacyStatus':'unlisted','lifeCycleStatus':'ready'},'contentDetails':{'boundStreamId':'saved-stream','enableAutoStart':True,'enableAutoStop':True}}
        def handle(request):
            if request.url.host=='oauth2.googleapis.com':
                return httpx.Response(200,json={'access_token':'test-token'})
            path=request.url.path.split('/v3/')[-1]
            if path=='channels': data={'items':[{'id':channel}]}
            elif path=='liveStreams': data={'items':[{'id':'saved-stream','cdn':{'ingestionInfo':{'streamName':'test-key'}}}]}
            elif path=='liveBroadcasts' and request.method=='GET':
                data={'items':[state] if 'id' in request.url.params else broadcasts or []}
            elif request.method=='POST':
                self.posts.append(path); data=state
            else: raise AssertionError(path)
            return httpx.Response(200,json=data)
        return httpx.Client(transport=httpx.MockTransport(handle))

    def prepare(self,client):
        with patch.dict(os.environ,{'YOUTUBE_CLIENT_ID':'test','YOUTUBE_CLIENT_SECRET':'test','YOUTUBE_REFRESH_TOKEN':'test'}):
            return YouTube(client).prepare('test-key','unlisted',dt.datetime(2026,10,8,6,tzinfo=dt.timezone.utc))

    def test_creates_and_binds_one_event(self):
        with self.fixture() as client: self.assertEqual(self.prepare(client),'new-event')
        self.assertEqual(self.posts,['liveBroadcasts','liveBroadcasts/bind'])

    def test_wrong_channel_cannot_write(self):
        with self.fixture(channel='other-channel') as client:
            with self.assertRaisesRegex(YouTubeError,'different channel'): self.prepare(client)
        self.assertEqual(self.posts,[])

    def test_active_event_cannot_be_interrupted(self):
        with self.fixture(broadcasts=[{'id':'active','snippet':{'title':'other'},'status':{'lifeCycleStatus':'live'}}]) as client:
            with self.assertRaisesRegex(YouTubeError,'existing broadcast'): self.prepare(client)
        self.assertEqual(self.posts,[])

    def test_completed_daily_event_cannot_repeat(self):
        with self.fixture(broadcasts=[{'id':'done','snippet':{'title':'Obit Billionaires | Morning Affirmations | 2026-10-08'},'status':{'lifeCycleStatus':'complete'}}]) as client:
            with self.assertRaisesRegex(YouTubeError,'already completed'): self.prepare(client)
        self.assertEqual(self.posts,[])

class SessionTests(unittest.TestCase):
    def test_lagos_slots(self):
        for hour, expected in [(6,'morning'),(13,'work'),(21,'bedtime')]:
            now=dt.datetime(2026,10,12,hour,tzinfo=dt.timezone.utc)
            self.assertEqual(session_at(now),expected)

class BroadcastReadTests(unittest.TestCase):
    def test_empty_read_recovers_without_creating_another_event(self):
        requests=[]
        def handle(request):
            requests.append(request)
            return httpx.Response(200,json={'items':[] if len(requests)<3 else [{'id':'event','status':{}}]})
        with httpx.Client(transport=httpx.MockTransport(handle)) as client, patch('recorded.time.sleep'):
            youtube=YouTube(client)
            youtube.token='test-token'
            self.assertEqual(youtube.broadcast_details('event','id,status')['id'],'event')
        self.assertEqual([r.method for r in requests],['GET']*3)

    def test_persistent_empty_read_fails_clearly_without_writes(self):
        with httpx.Client(trust_env=False) as client, patch('recorded.time.sleep'), patch.object(YouTube,'request',return_value={'items':[]}) as request:
            with self.assertRaisesRegex(YouTubeError,'after four reads'):
                YouTube(client).broadcast_details('event','id,status')
        self.assertEqual(request.call_count,4)
        self.assertTrue(all(c.args[0]=='GET' for c in request.call_args_list))

    def test_wrong_event_is_rejected(self):
        with httpx.Client(trust_env=False) as client, patch.object(YouTube,'request',return_value={'items':[{'id':'other'}]}):
            with self.assertRaisesRegex(YouTubeError,'unexpected broadcast'):
                YouTube(client).broadcast_details('event','id,status')

class PlaybackObservationTests(unittest.TestCase):
    def test_observation_reads_bound_resources_and_redacts_payload_text(self):
        requests=[]
        def handle(request):
            requests.append(request)
            row=({'id':'event','status':{'lifeCycleStatus':'ready'}} if request.url.path.endswith('liveBroadcasts') else
                 {'id':'stream','status':{'streamStatus':'active','healthStatus':{'status':'bad',
                    'configurationIssues':[{'description':'PRIVATE-DETAIL'}]}},'cdn':{'streamName':'SECRET-KEY'}})
            return httpx.Response(200,json={'items':[row]})
        with httpx.Client(transport=httpx.MockTransport(handle)) as client, patch('sys.stdout',new_callable=io.StringIO) as output:
            youtube=YouTube(client); youtube.token='SECRET-TOKEN'; youtube.stream_id='stream'
            youtube.observe_playback('event')
        self.assertIn('broadcast=ready ingest=active health=bad configuration_issues=1',output.getvalue())
        self.assertNotIn('SECRET',output.getvalue()); self.assertNotIn('PRIVATE',output.getvalue())
        self.assertEqual([r.method for r in requests],['GET','GET'])
        self.assertEqual([r.url.params['id'] for r in requests],['event','stream'])
        self.assertTrue(all(r.url.params['part']=='id,status' for r in requests))

    def test_diagnostic_failure_does_not_interrupt_or_log_error_body(self):
        with httpx.Client(trust_env=False) as client, patch.object(YouTube,'request',side_effect=RuntimeError('SECRET')), patch('sys.stdout',new_callable=io.StringIO) as output:
            YouTube(client).observe_playback('event')
        self.assertIn('encoder continues',output.getvalue()); self.assertNotIn('SECRET',output.getvalue())

    def test_poll_during_encoding_then_return_complete_stderr(self):
        process=Mock(); process.communicate.side_effect=[subprocess.TimeoutExpired('ffmpeg',15),(None,b'complete stderr')]
        youtube=Mock()
        self.assertEqual(wait_for_recording(process,360,youtube,'event'),b'complete stderr')
        youtube.observe_playback.assert_called_once_with('event')
        process.kill.assert_not_called()

    def test_deadline_stops_hung_encoder_without_replaying(self):
        process=Mock(); youtube=Mock()
        with patch('recorded.time.monotonic',side_effect=[0,451]):
            with self.assertRaisesRegex(RuntimeError,'bounded runtime'):
                wait_for_recording(process,360,youtube,'event')
        process.kill.assert_called_once(); process.communicate.assert_called_once_with()
        youtube.observe_playback.assert_not_called()

if __name__=='__main__' : unittest.main()
