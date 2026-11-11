# OBS WhatsApp relay

Dedicated public callback for Meta app 893718760430391. No public inbox or sending API. Source copied from the tested owned OBS implementation.

Run Node 22 or newer: `node obs-whatsapp-relay/server.mjs`. Test: `node --test obs-whatsapp-relay/relay.test.mjs`.

Configure META_APP_SECRET, WHATSAPP_VERIFY_TOKEN and OBS_SERVICE_TOKEN through hosting secrets only. Until all exist, webhook requests return 503. Health path: /health. Webhook path: /webhooks/whatsapp. The receiver verifies signatures independently and stores messages by assigned business account.

Deployment is separate from the Cooperative website and API. Live delivery also requires receiver routing, callback verification, app subscription and Meta app publication.
