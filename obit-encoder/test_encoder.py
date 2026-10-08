import unittest
from encoder import destination, options

class ConfigurationTests(unittest.TestCase):
    def test_destination_only_allows_keys(self):
        for key in ('', 'bad/key', 'key?x=y', 'x\ny', 'x#y'):
            with self.assertRaises(ValueError):
                destination(key)
        self.assertTrue(destination('test-key').startswith('rtmps://'))

    def test_media_options_are_local_and_encrypted(self):
        args = options(1280, 720, 12001, 12002, destination('test-key'))
        self.assertIn('tcp://127.0.0.1:12001', args)
        self.assertIn('tcp://127.0.0.1:12002', args)
        self.assertEqual(args[-1], 'rtmps://a.rtmps.youtube.com:443/live2/test-key')
        self.assertEqual(args[args.index('-loglevel') + 1], 'error')

    def test_frame_size_is_bounded(self):
        for size in ((0, 720), (1280, 9000)):
            with self.assertRaises(ValueError):
                options(*size, 12001, 12002, 'unused')

if __name__ == '__main__':
    unittest.main()
