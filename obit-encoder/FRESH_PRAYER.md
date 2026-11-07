# Fresh Obit Billionaires Prayer

Status: preparation only. Do not enable `FRESH_PRAYER_ENABLED` until dated full
recordings and their reviewed manifests exist. No fresh voice/video has yet
been produced and this change does not generate speech or spend credits.

The recurring spoken opening is exactly:

- Morning: Dear Obit Billionaires, join us in this morning prayer. Repeat after me.
- Work: Dear Obit Billionaires, join us in this work hour prayer. Repeat after me.
- Bedtime: Dear Obit Billionaires, join us in this bedtime prayer. Repeat after me.

Write new prayers for every dated slot in `assets/prayer_plans.json`. Morning
focuses on wealth, money, provision and speaking into the day. Work focuses on
positive energy and encouragement. Bedtime focuses on protection, health and
spiritual prayer. Do not use a shuffled old script as new content. Catalog
validation rejects identical statement sets across dates. This is a duplicate
check, not a semantic originality detector. Editorial review remains required.

The current catalog contains the three 7 November scripts only, not an endless
stock of future sessions. Keep all previous dated plans in the catalog for
duplicate checking. Do not label an old recording as a new script.

Produce each full recording with an approved voice, response pauses, soft music
and the official sun logo. The blocked local narration process must not be
rerun. An ElevenLabs connection, chosen voice and approved usage allowance are
outstanding. Do not assume an API key or paid allowance exists.

After audio and visual review, place the MP4 at
`media/YYYY-MM-DD/SLOT/full.mp4` and its `verified.json` alongside it. Include
`date`, `slot`, `script_sha256` (from `fingerprint(plan['lines'])`),
`video_sha256`, and `reviewed_audio_visual: true`. Never set the review flag
without actually listening and inspecting the video. A checksum does not
prove spoken content matches the script.

When enabled, `recorded.run` checks this exact date/slot media before any
YouTube event is created. Missing or unreviewed media fails closed, with no old
recording fallback. Final duration must be 300–420 seconds. Existing channel,
duplicate, binding, live-transition and actual-publication safeguards remain.
Cron schedule stays `0 6,13,21 * * *` UTC. Do not manually trigger public tests.

Create a one-minute excerpt from the corresponding finished recording. Verify
the full YouTube session actually plays before using its URL in WhatsApp
Status or the authorised Cooperative group. Inspect previous placements first.
Facebook receives the full recording, not the excerpt or a text-only reminder.

The Dockerfile still invokes the historical build narration process. Therefore
do not deploy this branch while the previous narration execution block applies.
The approved replacement narration/build path must be completed before rollout.
