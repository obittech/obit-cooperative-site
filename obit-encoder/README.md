# Obit Billionaires recorded broadcaster

The container now plays a reusable branded 112-second recording, produced once with HeyGen Amy voice, with the existing Obit Group-based logo and affirmation cards. Playback creates no LiveAvatar sessions and needs no voice-generation subscription per show. FFmpeg prepares H264/AAC at build time and copies encoded media at runtime.

## Verified status (8 October 2026)

The recorded rehearsal ran on Render from 05:02:57 to 05:04:49 UTC and exited successfully. YouTube Studio displayed the branded recording LIVE with Excellent ingestion health in the unlisted test room FUp5-_K0wpY. The packaged media passed H264 1280x720, AAC 48kHz and non-silent audio checks. Seven configuration and mocked YouTube lifecycle tests passed. The deployed ENABLE_RECORDED and ENABLE_REHEARSAL flags are now false. Daily owner OAuth and actual API lifecycle validation remain incomplete because Google Cloud Console is unavailable in the current browser. No public daily schedule is enabled.

## Rehearsal

ENABLE_RECORDED=true, BROADCAST_MODE=rehearsal, DESTINATION_VISIBILITY=unlisted. The saved YOUTUBE_STREAM_KEY must belong to the actual unlisted room. The room visibility must be checked in YouTube Studio; the environment assertion alone cannot verify it. A single full recording plays and exits. Disable ENABLE_RECORDED after the test.

## Daily mode

BROADCAST_MODE=daily requires YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET and YOUTUBE_REFRESH_TOKEN stored privately in Render. They must authorize the Obit Billionaires channel UC2cjo3492WY8JtfB1tq7dwA with youtube.force-ssl scope. Never paste credentials into chat or commit them. A YouTube API-enabled Google Cloud project and one owner OAuth consent are required. A browser login or stream key does not provide a refresh token.

The runner refreshes authorization, verifies the channel, matches the existing stream key to an authorized stream, avoids duplicate/active events, creates or reuses today’s event, confirms privacy and automatic start/end, then plays three complete rounds (about 5m37s). Each show states that the host is recorded. It uses Lagos dates. No second event is created if an existing one is active or today’s event already completed. Failures stop instead of endlessly retrying. Live chat remains native to YouTube; microphone guests are not implemented.

Proposed schedule: 07:00 Africa/Lagos daily = 0 6 * * * UTC. The deployed schedule remains the disabled annual placeholder until OAuth authorization and daily lifecycle testing pass. Unlisted remains the launch-test default. A public launch needs the real visibility changed explicitly.

## Costs and validation

Reuse the existing Render cron. Current 2c-4g runtime pricing was $0.00197/minute with $1/service monthly minimum. At three rounds/day, playback runtime alone is about $0.33/month, below that floor; startup time and other account services add usage. No new plan or service is required for playback. Verify the account bill rather than treating $1 as a guaranteed total.

prepare_recording.py builds the packaged media from logo.jpg.b64 and voice.opus.b64. Assets are checked in so the runtime needs no expiring download links. encoder.py retains only helper functions and the inactive legacy LiveAvatar runner; Docker’s default command is recorded.py. ENABLE_REHEARSAL stays false.

Primary references:
- https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert
- https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/bind
- https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition
- https://render.com/docs/cronjobs
