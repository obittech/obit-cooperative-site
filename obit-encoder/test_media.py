"""Local synthetic media integration check. No provider keys or broadcasts."""
import asyncio
import json
import math
import struct
import tempfile
import time
from pathlib import Path
from encoder import options

async def smoke():
    connected = {}
    clients = []
    async def feed(reader, writer, kind):
        connected[kind] = time.monotonic()
        clients.append(writer)
        try:
            for index in range(150 if kind == 'video' else 300):
                if kind == 'video':
                    data = bytes((30, 100, 160)) * (320 * 180)
                else:
                    data = b''.join(struct.pack('<h', int(8000 * math.sin(2*math.pi*440*(index*960+n)/48000))) for n in range(960))
                writer.write(data)
                await writer.drain()
                await asyncio.sleep(.04 if kind == 'video' else .02)
        except (ConnectionError, BrokenPipeError):
            pass
        finally:
            writer.close()
    servers = []
    for kind in ('video', 'audio'):
        servers.append(await asyncio.start_server(lambda r,w,k=kind: feed(r,w,k), '127.0.0.1', 0))
    with tempfile.TemporaryDirectory() as folder:
        target = str(Path(folder) / 'smoke.flv')
        args = options(320, 180, *(s.sockets[0].getsockname()[1] for s in servers), target)
        proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            result = await asyncio.wait_for(proc.wait(), 20)
            assert result == 0, f'Encoder exit {result}'
            probe = await asyncio.create_subprocess_exec('ffprobe','-v','error','-show_streams','-of','json',target,stdout=asyncio.subprocess.PIPE)
            data,_ = await probe.communicate()
            streams = json.loads(data)['streams']
            assert {s['codec_name'] for s in streams} == {'h264', 'aac'}
            video = next(s for s in streams if s['codec_type'] == 'video')
            assert (video['width'], video['height']) == (1280,720)
            lag = connected['audio'] - connected['video']
            print(f'720p H264 and AAC output verified; input connection offset {lag:.2f}s')
            assert lag < .5, 'Audio input starts too late for live speech'
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
            for s in servers:
                s.close()
                await s.wait_closed()

if __name__ == '__main__':
    asyncio.run(smoke())
