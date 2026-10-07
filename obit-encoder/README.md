# Obit Billionaires encoder rehearsal

Status: implementation prepared, not deployed or verified with provider media.

This isolated container receives Olivia's LiveAvatar video and audio using LiveKit,
encodes 720p video with FFmpeg, and sends it to YouTube over RTMPS. The script runs
once for at most four minutes. It is not the completed daily automation system.

Required provider secrets, entered through the hosting service's protected settings:
- LIVEAVATAR_API_KEY (replacement key, never the revoked key)
- YOUTUBE_STREAM_KEY (the Obit Billionaires unlisted rehearsal)

Non-secret configuration:
- LIVEAVATAR_AVATAR_ID=dc6a2ade-fcad-48b4-89ce-8ae807b18c32
- LIVEAVATAR_VOICE_ID=3cfb966a-e2b6-45d3-bc73-10fe4c92d8ae
- LIVEAVATAR_CONTEXT_ID=8f87025d-e99b-4e98-a407-ce48eb58c0f2
- MAX_TEST_SECONDS=180
- DESTINATION_VISIBILITY=unlisted
- ENABLE_REHEARSAL=false (change only after verifying the actual YouTube visibility)

Secrets are not included in this package. LiveAvatar credentials already stored
in the private studio have not been extracted or copied to Render.

The visibility flag is an operator assertion, not a YouTube API check. Verify the
actual room before enabling. FFmpeg's destination includes the key in its process
arguments inside this isolated service. It is never logged. Do not share process
dumps or give other users shell access to the service.

Run locally with the same protected environment, or build the Docker image on a
dedicated hosting service. Do not attach this encoder to the cooperative API.
Render's available connector cannot create Docker workers. A repository plus the
Render dashboard or Blueprint deployment is needed. Hosting charges must be
reviewed before provisioning. Restarting an enabled service can repeat the test,
so disable rehearsal after the first run before choosing any automatic restart.

Validation completed: Python compilation and isolated destination/argument checks.
Outstanding: image build, real provider API authentication, LiveKit event timing,
audio/video synchronisation, YouTube ingestion and ending the stream.
Audio/video synchronisation must be checked by listening to the actual rehearsal.
Speech completion is correlated by source_event_id. Provider event behaviour still needs verification.

The draft Render Blueprint uses a disabled cron job so a service restart cannot
automatically rebroadcast. The placeholder annual schedule does not enable a
daily broadcast. Run the rehearsal manually, then set ENABLE_REHEARSAL=false.
Review the displayed Render charges before creating the service. The proposed
standard instance is for the video encoding test, not an approved purchase.

After the test: implement durable scheduling with run locks, automatic broadcast
creation/ending, bounded recovery, spend limits and a guest consent/queue/media
system. The present runner accepts no guest microphones and handles no live chat.

Primary implementation references:
- https://docs.liveavatar.com/docs/full-mode/events
- https://docs.liveavatar.com/api-reference/sessions/create-session-token
- https://docs.liveavatar.com/api-reference/sessions/start-session
- https://docs.livekit.io/reference/python/livekit/rtc/video_stream.html
- https://docs.livekit.io/reference/python/livekit/rtc/audio_stream.html
