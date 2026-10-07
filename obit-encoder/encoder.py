"""Bounded LiveAvatar-to-YouTube rehearsal. Requires an unlisted destination.

No recurring schedule or guest microphone handling is enabled by this runner.
"""
import asyncio
import contextlib
import json
import os
import signal
import uuid

SCRIPT = [
    "Welcome to Obit Billionaires Affirmations. I am Olivia, your AI host. Take a steady breath and repeat after me.",
    "I create value through my skills and service.",
    "I notice opportunities and take thoughtful action.",
    "I manage my money with care and discipline.",
    "I learn every day and improve my abilities.",
    "I build honest relationships and support my community.",
    "I remain patient and consistent in pursuing my goals.",
    "I am grateful for my progress and ready for the work ahead.",
    "Choose one useful action for today. Thank you for joining Obit Billionaires Affirmations.",
]

class ConfigurationError(ValueError):
    """Static operator-facing messages containing no supplied values."""

def destination(key):
    if not key or any(c.isspace() for c in key) or any(c in key for c in "/?#"):
        raise ConfigurationError("YOUTUBE_STREAM_KEY must contain only the stream key, without a URL or whitespace")
    return "rtmps://a.rtmps.youtube.com:443/live2/" + key

def options(width, height, video_port, audio_port, output):
    if width <= 0 or height <= 0 or width > 4096 or height > 4096:
        raise ValueError("Unsupported frame size")
    return ["ffmpeg", "-hide_banner", "-loglevel", "quiet", "-nostdin",
            "-thread_queue_size", "128", "-f", "rawvideo", "-pixel_format", "rgb24",
            "-video_size", f"{width}x{height}", "-framerate", "25",
            "-i", f"tcp://127.0.0.1:{video_port}",
            "-thread_queue_size", "128", "-f", "s16le", "-ar", "48000", "-ac", "1",
            "-i", f"tcp://127.0.0.1:{audio_port}",
            "-map", "0:v", "-map", "1:a", "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k", "-g", "50",
            "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-f", "flv", output]

async def run():
    import httpx
    from livekit import rtc
    if os.environ.get("ENABLE_REHEARSAL") != "true":
        print("Rehearsal disabled. No avatar session or broadcast started.", flush=True)
        return
    if os.environ.get("DESTINATION_VISIBILITY") != "unlisted":
        raise ConfigurationError("DESTINATION_VISIBILITY must be unlisted")
    output = destination(os.environ["YOUTUBE_STREAM_KEY"])
    try:
        duration = min(240, max(60, int(os.environ.get("MAX_TEST_SECONDS", "180"))))
    except ValueError:
        raise ConfigurationError("MAX_TEST_SECONDS must be an integer") from None
    room = rtc.Room()
    stop = asyncio.Event()
    first_video = asyncio.Event()
    media_ready = asyncio.Event()
    speaking_finished = asyncio.Event()
    expected_speech = None
    tasks = set()
    streams = []
    frame = None
    dimensions = None
    audio = bytearray()
    token = None
    process = None
    servers = []
    writers = []
    failures = []
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    def spawn(coro):
        task = asyncio.create_task(coro)
        tasks.add(task)
        def done(t):
            tasks.discard(t)
            if not t.cancelled() and t.exception():
                failures.append(type(t.exception()).__name__)
                stop.set()
        task.add_done_callback(done)
        return task

    async def receive_video(track):
        nonlocal frame, dimensions
        stream = rtc.VideoStream(track, capacity=2, format=rtc.VideoBufferType.RGB24)
        streams.append(stream)
        async for event in stream:
            size = (event.frame.width, event.frame.height)
            if dimensions is not None and dimensions != size:
                raise RuntimeError("Video dimensions changed")
            dimensions = size
            frame = bytes(event.frame.data)
            first_video.set()

    async def receive_audio(track):
        stream = rtc.AudioStream(track, capacity=10, sample_rate=48000, num_channels=1, frame_size_ms=20)
        streams.append(stream)
        async for event in stream:
            if not media_ready.is_set():
                # Exclude the automatic intro before the broadcast is ready.
                continue
            audio.extend(bytes(event.frame.data))
            # Fail rather than silently losing speech or accumulating stale audio.
            if len(audio) > 48000 * 2:
                raise RuntimeError("Audio encoder backpressure")

    @room.on("track_subscribed")
    def subscribed(track, publication, participant):
        if track.kind == rtc.TrackKind.KIND_VIDEO:
            spawn(receive_video(track))
        elif track.kind == rtc.TrackKind.KIND_AUDIO:
            spawn(receive_audio(track))

    @room.on("data_received")
    def received(packet):
        if packet.topic != "agent-response":
            return
        try:
            event = json.loads(packet.data)
            if (event.get("event_type") == "avatar.speak_ended"
                    and expected_speech is not None
                    and event.get("source_event_id") == expected_speech):
                speaking_finished.set()
            elif event.get("event_type") == "session.stopped":
                stop.set()
        except (ValueError, TypeError):
            pass

    @room.on("disconnected")
    def disconnected(*args):
        stop.set()

    async def socket_feed(video):
        connected = loop.create_future()
        async def client(reader, writer):
            if connected.done():
                writer.close()
                return
            writers.append(writer)
            connected.set_result(writer)
        server = await asyncio.start_server(client, "127.0.0.1", 0)
        servers.append(server)
        async def feed():
            writer = await asyncio.wait_for(connected, 20)
            tick = .04 if video else .02
            target = loop.time()
            while not stop.is_set():
                if video:
                    chunk = frame
                else:
                    count = 1920  # 20 ms, 48 kHz, mono, signed 16-bit
                    chunk = bytes(audio[:count])
                    del audio[:count]
                    chunk += bytes(count - len(chunk))
                writer.write(chunk)
                await asyncio.wait_for(writer.drain(), 3)
                target += tick
                if loop.time() - target > .5:
                    raise RuntimeError("Encoder cannot keep up with real time")
                await asyncio.sleep(max(0, target - loop.time()))
        spawn(feed())
        return server.sockets[0].getsockname()[1], connected

    async with httpx.AsyncClient(timeout=20) as client:
        async def call(path, body=None):
            headers = {"Authorization": "Bearer " + token} if token else {"X-API-KEY": os.environ["LIVEAVATAR_API_KEY"]}
            response = await client.post("https://api.liveavatar.com/v1/" + path, headers=headers, json=body)
            if not response.is_success:
                # Never log upstream bodies, tokens or destination URLs.
                print(f"LiveAvatar request failed: {path}, HTTP {response.status_code}", flush=True)
                raise RuntimeError(f"LiveAvatar HTTP {response.status_code}")
            return response.json()["data"]
        try:
            created = await call("sessions/token", {
                "mode": "FULL", "avatar_id": os.environ["LIVEAVATAR_AVATAR_ID"],
                "max_session_duration": duration,
                "video_settings": {"quality": "medium", "encoding": "H264"},
                "avatar_persona": {"voice_id": os.environ["LIVEAVATAR_VOICE_ID"],
                                   "context_id": os.environ["LIVEAVATAR_CONTEXT_ID"], "language": "en"},
            })
            token = created["session_token"]
            print("LiveAvatar authenticated. Starting bounded session.", flush=True)
            started = await call("sessions/start")
            await room.connect(started["livekit_url"], started["livekit_client_token"])
            await asyncio.wait_for(first_video.wait(), 30)
            (vp, video_connected), (ap, audio_connected) = await socket_feed(True), await socket_feed(False)
            process = await asyncio.create_subprocess_exec(*options(*dimensions, vp, ap, output),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await asyncio.wait_for(asyncio.gather(video_connected, audio_connected), 20)
            audio.clear()
            media_ready.set()
            async def watch_encoder():
                await process.wait()
                if not stop.is_set():
                    failures.append("Encoder exited")
                    stop.set()
            spawn(watch_encoder())
            async def speak_script():
                nonlocal expected_speech
                # Interrupt the context intro so the broadcast uses the exact test script.
                async def command(kind, text=None):
                    command_id = str(uuid.uuid4())
                    payload = {"event_id": command_id, "event_type": kind,
                               "session_id": started["session_id"]}
                    if text is not None:
                        payload["text"] = text
                        expected_speech = command_id
                    await room.local_participant.publish_data(json.dumps(payload).encode(), reliable=True, topic="agent-control")
                await command("avatar.interrupt")
                await asyncio.sleep(2)
                for line in SCRIPT:
                    if stop.is_set():
                        return
                    speaking_finished.clear()
                    await command("avatar.speak_text", line)
                    await asyncio.wait_for(speaking_finished.wait(), 35)
                    await asyncio.sleep(4)
                stop.set()
            spawn(speak_script())
            async def keepalive():
                while not stop.is_set():
                    await asyncio.sleep(30)
                    if not stop.is_set():
                        await call("sessions/keep-alive")
            spawn(keepalive())
            print("Encoder running. Verify picture and audio in the unlisted YouTube control room.", flush=True)
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), duration)
        finally:
            stop.set()
            pending = list(tasks)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for stream in streams:
                with contextlib.suppress(Exception):
                    await stream.aclose()
            for writer in writers:
                writer.close()
            for server in servers:
                server.close()
                await server.wait_closed()
            if process and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            await room.disconnect()
            if token:
                with contextlib.suppress(Exception):
                    await call("sessions/stop")
    if failures:
        raise RuntimeError("Rehearsal ended because a media task failed")
    print("Rehearsal ended. No recurring broadcast scheduled.", flush=True)

if __name__ == "__main__":
    try:
        asyncio.run(run())
    except ConfigurationError as error:
        print("Configuration check failed: " + str(error), flush=True)
        raise SystemExit(1)
    except Exception as error:
        # Exception type only. Third-party SDK messages may include secrets.
        print("Rehearsal failed: " + type(error).__name__, flush=True)
        raise SystemExit(1)
