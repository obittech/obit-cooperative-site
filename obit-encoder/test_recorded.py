import datetime as dt
import os
import unittest
from unittest.mock import patch
import httpx
from recorded import YouTube, YouTubeError, CHANNEL, session_at

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

if __name__=='__main__' : unittest.main()
