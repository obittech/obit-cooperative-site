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

class ProviderErrorTests(unittest.TestCase):
    def test_documents_machine_reason_without_disclosing_provider_text(self):
        payload={'error':{'message':'SECRET TOKEN','errors':[{'reason':'insufficientLivePermissions','message':'PRIVATE URL'}, {'reason':'SECRET VALUE'}]}}
        with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(403,json=payload))) as client:
            youtube=YouTube(client); youtube.token='TOKEN'
            with self.assertRaises(YouTubeError) as caught: youtube.request('POST','liveBroadcasts/transition')
        message=str(caught.exception)
        self.assertIn('reason=insufficientLivePermissions',message)
        self.assertNotIn('SECRET',message); self.assertNotIn('PRIVATE',message); self.assertNotIn('TOKEN',message)

    def test_non_json_response_remains_safe(self):
        with httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(403,text='PRIVATE'))) as client:
            youtube=YouTube(client); youtube.token='TOKEN'
            with self.assertRaisesRegex(YouTubeError,'reason=unclassified'): youtube.request('GET','channels')

class LiveStartTests(unittest.TestCase):
    def test_waits_for_three_consecutive_ready_active_observations(self):
        youtube=YouTube(Mock()); youtube.stream_id='stream'; youtube.start_prepared_event=Mock()
        youtube.request=Mock(side_effect=lambda method,path,**kwargs: {'items':[
            {'id':'event','status':{'lifeCycleStatus':'ready'}} if path=='liveBroadcasts' else
            {'id':'stream','status':{'streamStatus':'active','healthStatus':{'status':'good'}}}]})
        with patch('sys.stdout',new_callable=io.StringIO):
            youtube.observe_playback('event'); youtube.observe_playback('event')
            youtube.start_prepared_event.assert_not_called()
            youtube.observe_playback('event')
        youtube.start_prepared_event.assert_called_once_with('event')

    def fixture(self, lifecycle='ready', active=True, channel=CHANNEL, bound='stream', visibility='public'):
        youtube=YouTube(Mock()); youtube.prepared_id='event'; youtube.stream_id='stream'; youtube.visibility='public'
        youtube.authorize=Mock()
        youtube.broadcast_details=Mock(return_value={'id':'event','snippet':{'channelId':channel},
            'status':{'lifeCycleStatus':lifecycle,'privacyStatus':visibility},'contentDetails':{'boundStreamId':bound,'monitorStream':{'enableMonitorStream':False}}})
        youtube.request=Mock(side_effect=[{'items':[{'id':'stream','status':{'streamStatus':'active' if active else 'inactive'}}]},
            {'id':'event','status':{'lifeCycleStatus':'liveStarting'}}])
        return youtube

    def test_starts_same_event_once_after_identity_and_active_stream_checks(self):
        youtube=self.fixture(); youtube.start_prepared_event('event'); youtube.start_prepared_event('event')
        youtube.authorize.assert_called_once()
        self.assertEqual([c.args[0] for c in youtube.request.call_args_list],['GET','POST'])
        call=youtube.request.call_args_list[-1]
        self.assertEqual(call.args[1],'liveBroadcasts/transition')
        self.assertEqual(call.kwargs['params']['id'],'event')
        self.assertEqual(call.kwargs['params']['broadcastStatus'],'live')

    def test_auto_start_race_does_not_write(self):
        youtube=self.fixture(lifecycle='liveStarting'); youtube.start_prepared_event('event')
        youtube.request.assert_not_called()

    def test_enabled_monitor_tests_then_starts_same_event(self):
        youtube=self.fixture()
        details=youtube.broadcast_details.return_value
        details['contentDetails']['monitorStream']['enableMonitorStream']=True
        youtube.request.side_effect=[{'items':[{'id':'stream','status':{'streamStatus':'active'}}]},
            {'id':'event','status':{'lifeCycleStatus':'testStarting'}}]
        youtube.start_prepared_event('event')
        self.assertEqual(youtube.request.call_args.kwargs['params']['broadcastStatus'],'testing')
        youtube.start_prepared_event('event')
        self.assertEqual(youtube.request.call_count,2)
        details['status']['lifeCycleStatus']='testing'
        youtube.request.side_effect=[{'items':[{'id':'stream','status':{'streamStatus':'active'}}]},
            {'id':'event','status':{'lifeCycleStatus':'liveStarting'}}]
        youtube.start_prepared_event('event')
        self.assertEqual(youtube.request.call_args.kwargs['params']['broadcastStatus'],'live')
        self.assertTrue(youtube.live_transition_attempted)

    def test_unknown_monitor_setting_cannot_transition(self):
        youtube=self.fixture(); del youtube.broadcast_details.return_value['contentDetails']['monitorStream']
        with self.assertRaisesRegex(YouTubeError,'setting unavailable'): youtube.start_prepared_event('event')
        youtube.request.assert_not_called()

    def test_testing_only_is_not_successful_public_playback(self):
        youtube=self.fixture(lifecycle='testing')
        with self.assertRaisesRegex(YouTubeError,'never entered live'): youtube.finish('event')
        youtube.request.assert_not_called()

    def test_completed_event_requires_actual_start_evidence(self):
        youtube=self.fixture(lifecycle='complete')
        with self.assertRaisesRegex(YouTubeError,'no actual live start'): youtube.finish('event')
        youtube.broadcast_details.return_value['snippet']['actualStartTime']='2026-10-31T13:00:00Z'
        youtube.finish('event')
        youtube.request.assert_not_called()

    def test_changed_identity_binding_or_visibility_cannot_write(self):
        for values in [{'channel':'other'},{'bound':'other'},{'visibility':'unlisted'}]:
            youtube=self.fixture(**values)
            with self.assertRaisesRegex(YouTubeError,'changed'): youtube.start_prepared_event('event')
            youtube.request.assert_not_called()

    def test_inactive_stream_cannot_write(self):
        youtube=self.fixture(active=False)
        with self.assertRaisesRegex(YouTubeError,'no longer active'): youtube.start_prepared_event('event')
        self.assertEqual([c.args[0] for c in youtube.request.call_args_list],['GET'])

    def test_wrong_channel_authorization_and_unprepared_event_cannot_write(self):
        youtube=self.fixture(); youtube.start_prepared_event('other')
        youtube.authorize.assert_not_called()
        youtube.authorize.side_effect=YouTubeError('different channel')
        with self.assertRaisesRegex(YouTubeError,'different channel'): youtube.start_prepared_event('event')
        youtube.request.assert_not_called()

    def test_repeated_transition_error_is_not_retried(self):
        youtube=self.fixture(); youtube.request.side_effect=[{'items':[{'id':'stream','status':{'streamStatus':'active'}}]},YouTubeError('HTTP 403')]
        with self.assertRaises(YouTubeError): youtube.start_prepared_event('event')
        youtube.start_prepared_event('event')
        self.assertEqual(youtube.request.call_count,2)


class RejectedTransitionTests(unittest.TestCase):
    fixture=LiveStartTests.fixture
    def test_rejection_reads_state_once_and_never_retries_live(self):
        youtube=self.fixture()
        youtube.request.side_effect=[{'items':[{'id':'stream','status':{'streamStatus':'active'}}]},YouTubeError('HTTP 403')]
        youtube.broadcast_details.return_value['contentDetails'].update(enableAutoStart=True,enableAutoStop=True)
        with patch('sys.stdout',new_callable=io.StringIO) as output:
            with self.assertRaisesRegex(YouTubeError,'HTTP 403'):
                youtube.start_prepared_event('event')
            youtube.start_prepared_event('event')
        self.assertEqual(youtube.broadcast_details.call_count,2)
        self.assertEqual([c.args[0] for c in youtube.request.call_args_list],['GET','POST'])
        self.assertIn('broadcast=ready monitor=disabled auto_start=enabled auto_stop=enabled binding=same',output.getvalue())

    def test_rejected_testing_stage_never_repeats_post(self):
        youtube=self.fixture()
        youtube.broadcast_details.return_value['contentDetails']['monitorStream']['enableMonitorStream']=True
        youtube.request.side_effect=[{'items':[{'id':'stream','status':{'streamStatus':'active'}}]},YouTubeError('HTTP 403')]
        with self.assertRaises(YouTubeError): youtube.start_prepared_event('event')
        youtube.start_prepared_event('event')
        self.assertEqual(youtube.request.call_count,2)
        self.assertEqual(youtube.request.call_args.kwargs['params']['broadcastStatus'],'testing')

    def test_unavailable_diagnostics_preserve_original_error(self):
        youtube=self.fixture()
        details=youtube.broadcast_details.return_value
        youtube.broadcast_details.side_effect=[details,YouTubeError('PRIVATE')]
        youtube.request.side_effect=[{'items':[{'id':'stream','status':{'streamStatus':'active'}}]},YouTubeError('HTTP 403')]
        with patch('sys.stdout',new_callable=io.StringIO) as output:
            with self.assertRaisesRegex(YouTubeError,'HTTP 403'): youtube.start_prepared_event('event')
        self.assertNotIn('PRIVATE',output.getvalue())
        self.assertIn('unavailable',output.getvalue())

    def test_diagnostics_redact_unknown_values_and_payload_fields(self):
        youtube=self.fixture()
        youtube.broadcast_details.return_value={'status':{'lifeCycleStatus':'SECRET'},'contentDetails':{
            'enableAutoStart':'SECRET','enableAutoStop':'SECRET','boundStreamId':'SECRET',
            'monitorStream':{'enableMonitorStream':'SECRET','embedHtml':'SECRET'}}}
        with patch('sys.stdout',new_callable=io.StringIO) as output:
            youtube.observe_rejected_transition('event')
        self.assertNotIn('SECRET',output.getvalue())
        self.assertIn('broadcast=unknown monitor=unknown auto_start=unknown auto_stop=unknown binding=changed',output.getvalue())
        youtube.request.assert_not_called()

if __name__=='__main__' : unittest.main()

