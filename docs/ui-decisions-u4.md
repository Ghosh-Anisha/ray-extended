# UI U4 decisions

- Reused the existing guarded WhatsApp approval card and the existing merchant voice-note endpoint. A merchant voice note is displayed as context for the card and still requires the same merchant tap as the case page.
- Reused the seeded Acme simulated call record for the WhatsApp call card so the phone story stays grounded in database rows.
- Rebuilt customer and buyer views around a Gmail-style folder, thread list and reading pane. Quick replies only fill the existing composer; sending still uses the existing simulated message route.
- Styled Store admin as a WooCommerce-like admin surface and highlighted the seeded `#1234` order. The existing simulated store failure control remains available.
- Added first-visit coach marks for WhatsApp, Customer inbox and Buyer inbox. Dismissal is stored per browser and each step targets an element rendered by that surface.
- Removed the build-time Google Fonts fetch from `src/app/layout.tsx`. The existing CSS stack still starts with Inter and falls back to system fonts, so production builds work without network access.
- The first unattended pass was denied server and Git permissions. On retry, `npm run demo` served successfully on port 3001, Playwright captured the U4 screen set, and Git operations became available.
