import datetime as dt
import os
import unittest
from unittest.mock import patch
import httpx
from recorded import YouTube, YouTubeError, CHANNEL

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
        with self.fixture(broadcasts=[{'id':'done','snippet':{'title':'Obit Billionaires | Daily Prosperity Affirmations | 2026-10-08'},'status':{'lifeCycleStatus':'complete'}}]) as client:
            with self.assertRaisesRegex(YouTubeError,'already completed'): self.prepare(client)
        self.assertEqual(self.posts,[])

if __name__=='__main__': unittest.main()
