# Public shopping help and seller product videos

The storefront and account navigation link to `market-help.html`. It gives plain-language instructions for search, product details, bags, email sign-in, delivery preferences, seller quotes and unpaid orders. It does not advertise payment checkout or courier booking as available.

Approved product videos appear on public product cards and inside the product details dialog. The Product videos collection filter selects approved videos from active listings and active member sellers. Visitors do not need an account to watch. Playback is requested explicitly and closing the details stops and removes the player. No autoplay, background video download or server fetch of seller URLs is used.

Sellers can supply one YouTube video link or a public HTTPS MP4 link and a description when creating a listing, or submit a replacement against an existing listing. The listing and its initial video commit together. Video approval is separate from product approval. Replacements immediately withdraw the earlier video until review. Staff review uses version checks, a note and an explicit confirmation of product match and permission. Staff can reject or unpublish an approved video. Private review notes are excluded from public catalogue responses.

This is hosted-video support, not raw video upload, transcoding, content scanning or guaranteed streaming availability. Sellers must provide actual footage they are authorised to publish. External hosts receive connection information only when playback is requested. YouTube uses its privacy-enhanced embed host. Invalid or unavailable media has a readable fallback.

## Real-product demonstration

The requested public click-by-click video must use genuine, approved products, not sample listings. On 30 October 2026 the live catalogue returned zero approved products and zero shops. No example products, sample footage or walkthrough video are published by this release.

A draft narration generated with ElevenLabs before the user clarified the real-product requirement is superseded and excluded from this repository and public site. The accepted provider is ElevenLabs. Record the actual published listing and visible shopping actions after obtaining a real seller, confirmed product name, price, quantity, product photos and authorised footage. Do not demonstrate a paid purchase or courier booking while those functions remain closed.

## Validation

Four new backend regression cases cover URL validation, ownership, approval visibility, edits withdrawing approval, stale review, private review notes, authenticated routes, and atomic initial listing/video creation. The existing PostgreSQL workflow runs these cases. Mobile checks cover the public guide at 320, 390 and 430 pixels, the approved-video filter, deferred player creation, closing the player, and staff unpublishing. Fictional fixtures are restricted to the ignored local QA runner.
