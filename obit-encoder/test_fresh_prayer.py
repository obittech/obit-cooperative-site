import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from fresh_prayer import INTROS, fingerprint, recording, validate_catalog


class FreshPrayerTests(unittest.TestCase):
    def setUp(self):
        self.plans = json.loads((Path(__file__).parent/'assets/prayer_plans.json').read_text())

    def test_approved_intros_and_distinct_dated_sessions(self):
        self.assertEqual(len(validate_catalog(self.plans)), 5)
        self.assertEqual({(p['date'], p['slot']) for p in self.plans}, {
            ('2026-11-07', 'morning'), ('2026-11-07', 'work'),
            ('2026-11-07', 'bedtime'), ('2026-11-08', 'work'),
            ('2026-11-08', 'bedtime'),
        })
        for p in self.plans:
            self.assertEqual(p['intro'], INTROS[p['slot']])

    def test_reordered_old_content_cannot_count_as_fresh(self):
        repeat = copy.deepcopy(self.plans[0])
        repeat['date'] = '2026-11-08'
        repeat['lines'].reverse()
        with self.assertRaisesRegex(ValueError, 'repeated prayer content'):
            validate_catalog(self.plans + [repeat])

    def test_duplicate_slot_and_wrong_intro_rejected(self):
        with self.assertRaises(ValueError):
            validate_catalog(self.plans + [self.plans[0]])
        self.plans[0]['intro'] += ' Welcome.'
        with self.assertRaises(ValueError):
            validate_catalog(self.plans)

    def test_missing_fresh_media_cannot_create_public_event(self):
        import os
        import recorded
        with patch.dict(os.environ, {'ENABLE_RECORDED':'true', 'BROADCAST_MODE':'daily',
                                     'DESTINATION_VISIBILITY':'public',
                                     'YOUTUBE_STREAM_KEY':'test-key',
                                     'FRESH_PRAYER_ENABLED':'true'}), \
                patch('fresh_prayer.recording', side_effect=ValueError('No fresh media')), \
                patch('recorded.YouTube.prepare') as prepare, \
                patch('recorded.subprocess.Popen') as encoder:
            with self.assertRaisesRegex(ValueError, 'No fresh media'):
                recorded.run()
            prepare.assert_not_called()
            encoder.assert_not_called()

    def test_encoder_receives_verified_dated_video_not_legacy_clip(self):
        import os
        import recorded
        process = Mock(returncode=0)
        process.poll.return_value = 0
        with patch.dict(os.environ, {'ENABLE_RECORDED':'true', 'BROADCAST_MODE':'daily',
                                     'DESTINATION_VISIBILITY':'public',
                                     'YOUTUBE_STREAM_KEY':'test-key',
                                     'FRESH_PRAYER_ENABLED':'true'}), \
                patch('fresh_prayer.recording', return_value=(Path('/fresh/broadcast.mp4'),180)), \
                patch('recorded.httpx.Client'), \
                patch('recorded.YouTube.prepare', return_value='same-event'), \
                patch('recorded.YouTube.finish'), \
                patch('recorded.wait_for_recording', return_value=b''), \
                patch('recorded.subprocess.Popen', return_value=process) as encoder:
            recorded.run()
            command = encoder.call_args.args[0]
            self.assertEqual(command[command.index('-i')+1], '/fresh/broadcast.mp4')
            self.assertEqual(command[command.index('-stream_loop')+1], '0')

    def test_media_gate_date_hash_review_and_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'assets').mkdir()
            (root/'assets/prayer_plans.json').write_text(json.dumps(self.plans))
            directory = root/'media/2026-11-07/morning'
            directory.mkdir(parents=True)
            (directory/'full.mp4').write_bytes(b'test fixture, never published')
            manifest = {'date':'2026-11-07', 'slot':'morning',
                        'script_sha256':fingerprint(self.plans[0]['lines']),
                        'video_sha256':hashlib.sha256((directory/'full.mp4').read_bytes()).hexdigest(),
                        'reviewed_audio_visual':True}
            target = directory/'verified.json'
            target.write_text(json.dumps(manifest))
            self.assertEqual(recording(root,'2026-11-07','morning',lambda _:180)[1],180)
            with self.assertRaises(ValueError):
                recording(root,'2026-11-08','morning',lambda _:180)
            for duration in (119, 181.1):
                with self.assertRaises(ValueError):
                    recording(root,'2026-11-07','morning',lambda _:duration)
            manifest['reviewed_audio_visual'] = False
            target.write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                recording(root,'2026-11-07','morning',lambda _:180)
            manifest['reviewed_audio_visual'] = True
            manifest['video_sha256'] = 'incorrect'
            target.write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                recording(root,'2026-11-07','morning',lambda _:180)


if __name__ == '__main__':
    unittest.main()
