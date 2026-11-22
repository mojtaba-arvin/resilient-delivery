# Browser Compatibility Matrix

The browser matrix runs against the built Web SDK and verifies IndexedDB queue persistence/flush plus Service Worker activation. Background Sync is recorded as a capability rather than required, because browser support differs.

| Engine | CI check | Background Sync |
|---|---|---|
| Chromium | IndexedDB + Service Worker smoke | Capability recorded |
| Firefox | IndexedDB + Service Worker smoke | Capability recorded |
| WebKit | IndexedDB + Service Worker smoke | Capability recorded |

Run locally after building:

```sh
pnpm --filter @resilient-delivery/web build
npm install --no-save --package-lock=false playwright@1.51.0
npx playwright install chromium firefox webkit
node scripts/browser-compatibility.mjs
```

This is a browser API compatibility smoke test, not a substitute for testing every supported browser release or real-device background execution. Browser versions are the Playwright-pinned engine builds from CI; maintain a separate release matrix for the browser versions your application supports.
