# Obit Market location directory

Released 6 November 2026. The default market.html is now the location directory; market-products.html retains the full shopping, cart, payment planning, seller inventory and Amazon Finds flows. Root redirects remain unchanged. Successful member seller sign-in lands at market-products.html#sellerPanel.

## Location hierarchy

Six geopolitical zones, 36 states plus FCT, existing state/LGA source (including FCT Area Councils), then trader-supplied community, location type, market/plaza name, shop number/floor, street address, landmark, goods/search words and hours. Standalone shops need no cluster name. The shared state/LGA source is copied into both frontend/data and backend/src/data so Render's backend service does not depend on files outside its root. Keep both copies identical.

No invented shops or map pins are seeded. Lugbe quick searches use place names supplied by the owner as search suggestions, not verified operating markets. Public market/plaza grouping is derived from approved shop profiles sharing state, LGA, community, type and cluster name. Staff must standardise spelling during review. There are no fabricated visitor counts, sales, reviews or prices.

## Submission and approval

Existing approved-member seller authentication is reused. Public browsing creates no account. Existing /seller/store version-controlled submissions accept a location object. The additive market_shop_locations table stores validated location JSON and a staff-only verification flag. Profile edits revoke store publication and location verification. Staff see the public fields and photo/video destinations in store review, and may check the location with a recorded evidence note. Public APIs expose neither membership codes nor private review notes.

GET /api/market/directory supports q, zone, state, lga, community, cluster, kind, video, page, lat, lon and radius. State/LGA/community/cluster filters use case-insensitive exact matching. Text search searches trader details plus active approved product descriptions and categories. Common clothes/clothing/cloths/fashion terms are normalised; cheap matches the word affordable and does not certify a lowest price. Results paginate at 24. Near search uses Haversine straight-line distance, defaults to 25 km and excludes profiles without coordinates. Coordinates are not persisted by the directory service. The endpoint does not reverse-geocode or request any paid Google API.

GET /api/market/directory/shops/:id exposes approved active member storefronts. Shop links use market.html?shop=<member-id>. Legacy ?seller= links also resolve to the public shop. Member shops without a location profile remain accessible in the product catalogue; add and approve location details to appear in the new directory.

Photos and YouTube/MP4 video links are optional, require seller content permission and staff review before publication. Google Maps opens a supplied coordinate pin, or an explicitly labelled address search where there is no pin. Exact street/market shop details remain important because a map pin can identify only the market entrance.

## Validation

Commerce tests exercise hidden pending profiles, publication, edits, suspended sellers, no private evidence leakage, geographic/keyword filters, nearby distance, invalid coordinates/media and verification evidence. Existing frontend navigation tests now check the retained product page and the new seller destination. PostgreSQL CI covers the commerce suite with the additive migration.

Production starts with no location listings until real traders submit and staff approve their location details. The existing nine sourcing products remain reachable and three are shown on the directory landing page. Amazon paid links remain tagged obitmarket-20 on the product page.
