# CareLoop

CareLoop turns a household morning check into an owned, acknowledged, escalated family action. Ring metadata can add context, but it cannot establish that a person is okay. CareLoop never contacts emergency services.

## Ring integration status

CareLoop is a hackathon prototype built for the Ring track. It uses the Ring Developer Playground/API path where available for device discovery, device status, motion configuration, and Event History. It also implements a Ring-compatible webhook receiver with raw-body HMAC-SHA256 verification and request_id-based idempotency.

The live demo primarily uses Ring-shaped simulator events routed through the signed webhook receiver and the same event normalization and CareLoop processing path used for incoming Ring events. Fixture mode lets judges run the project without Ring credentials. The source labels distinguish synthetic `fixture` and `simulated` records from real `ring_api` records and signed incoming `webhook` events.

This is not a certified Ring Appstore product; production publication is outside the scope of this hackathon prototype. Playground staging, account linking, or API access may depend on Ring developer-platform restrictions and an eligible Ring account. Do not treat fixture or simulator records as real observations. CareLoop never accesses video, media, or snapshots. Ring signals do not establish that a resident is safe, and CareLoop never contacts emergency services.

## Judging map

| Criterion | Evidence |
|---|---|
| Evidence integrity | Decision and event classification in [`src/domain.js`](src/domain.js); no Ring event resolves an alert |
| Alert ownership/action | Versioned transitions and sweep in [`src/server.js`](src/server.js); see [`docs/STATE_MACHINE.md`](docs/STATE_MACHINE.md) |
| Privacy/consent | Consent gates, pause and deletion routes; [`PRIVACY.md`](PRIVACY.md) |
| Security/auth/HMAC | Bearer role checks and raw-body signature verification in [`src/server.js`](src/server.js) |
| Resilience/data gaps | [`src/ring/client.js`](src/ring/client.js) errors, freshness/device/config health and UNVERIFIABLE decisions |
| Accessibility | Labeled controls, keyboard focus, large targets, live alert regions and reduced-motion CSS |
| Demoability | Fixture default, demo clock and signed simulator controls |
| Tests | Built-in `node:test` suite in [`test/`](test/) |
| Documentation | This guide, `PRIVACY.md`, `docs/STATE_MACHINE.md`, and the friction log |

## Modes and sources

| Mode/input | Network/evidence | Event source | Caveat |
|---|---|---|---|
| `fixtures` (default) | Synthetic document-shaped sample; no Ring calls | `fixture` | Never present as real-world evidence |
| `playground` | Server-side Ring API with credentials supplied by the operator | `ring_api`, signed `webhook` | Requires an eligible Ring account/base plan and supported API access |
| `simulator` | Locally signed v1.1-shaped events | `simulated` | Synthetic only |
| Ring webhook | Signed payload to `/ring/webhook` | `webhook` | Metadata only; events do not prove a resident is safe |

## Morning-check decision table

| Recipient confirmation | Ring/data status | Decision/action |
|---|---|---|
| Confirmed | Any | CONFIRMED and resolve |
| Not confirmed | Data gap | UNVERIFIABLE; task immediately |
| Not confirmed | Fresh, no possible activity | UNCONFIRMED; task and acknowledgement deadline |
| Not confirmed | Fresh, possible human/unclassified motion | Low-priority note and second prompt; promote after 60 minutes |

Ring evidence never closes an alert. Human classification means possible activity. Unclassified motion is labeled “Smart Alerts may be off.” Vehicle, animal, and other-motion subtypes are not resident evidence. Doorbell/button is a visitor note; package delivery is a delivery note; live view/on-demand is ignored.

## Architecture

Node 20 runs an Express server, a small Store interface (memory by default, JSON file when configured), timezone-aware domain logic, a Ring adapter, and three plain HTML/CSS/JS pages. The frontend calls only CareLoop; only the server calls Ring. There is no frontend build step and no AWS SDK. `ring.config.json` records the supplied Ring endpoints. Ring-driven account linking is not implemented; the playground token endpoint accepts an access token in memory.

## Setup and run

```sh
npm install
npm start
```

Open `http://localhost:3000/caregiver`, `/recipient`, or `/sources`. In demo mode, each page receives an opaque, server-side role session so the browser does not contain bearer tokens. API tests and local API clients can use the synthetic development tokens seeded in [`src/server.js`](src/server.js): `careloop-demo-priya-token`, `careloop-demo-arjun-token`, and `careloop-demo-margaret-token`. Replace or disable these for deployment. The demo UI shows “Demo time accelerated”; fixture and simulator data remain synthetic. `npm run demo` starts the app. `npm test` runs the Node built-in test suite.

Set `RING_MODE=playground` and configure Ring credentials in the server environment to use real metadata. `RING_ACCESS_TOKEN` or `POST /api/ring/token` supplies an access token in memory. A refresh token is not a Bearer token. Refresh credentials rotate; only the new refresh token and expiry metadata are saved to the ignored `data/ring-refresh.json` with mode 0600. Never paste production secrets into source files. See [Ring API documentation](https://developer.amazon.com/docs/ring/api-documentation.html). Ring feature availability may require a Ring base plan.

Use `STORE_MODE=json` and `DATA_FILE=data/db.json` for file persistence. Set `DEMO_MODE=false` to disable local simulation and demo role sessions. `NOTIFY_URL` is optional and used by the server only. `scripts/scenario.js` reads the demo clock and sends signed events covering a quiet morning, visitor, token expiry, and motion disabled; run it with `npm run scenario` against a running local server.

To record a sample response, run `RING_MODE=playground node scripts/record-fixtures.js input.json fixtures/recorded-sample.json`. The script removes token, secret, email, and name fields before writing a mode-0600 file marked `recorded`.

## Privacy, retention, limitations

Caregiver access is gated by owner consent. Margaret can pause sharing and request household deletion. A deletion request removes household records and retains only an ID and timestamp tombstone. Audit retention is configured as 30 days. No Ring media/video/snapshot endpoint is called. The simulator and fixtures do not represent real Ring observations. Linking a Ring account is not implemented; an operator must supply credentials. Network and device failures create a data gap, not reassurance. CareLoop does not contact emergency services; EXHAUSTED suggests contacting a neighbor or local support service.

## Claims to evidence

| Claim | What CareLoop actually does | Evidence/file | Caveat |
|---|---|---|---|
| “Possible activity” | Labels Ring motion metadata | [`src/domain.js`](src/domain.js) | It does not mean a person is okay |
| Ring evidence cannot resolve an alert | Only recipient or caregiver actions resolve | [`src/server.js`](src/server.js), [`docs/STATE_MACHINE.md`](docs/STATE_MACHINE.md) | Operator phone confirmation is a caregiver record |
| Data gaps become UNVERIFIABLE | Missing freshness, API error, offline, removed integration, or disabled motion sets a gap | [`src/server.js`](src/server.js), [`src/domain.js`](src/domain.js) | Fixture mode is synthetic |
| Sources can be distinguished | Each event includes a source label | [`src/ring/client.js`](src/ring/client.js), [`fixtures/ring-samples.json`](fixtures/ring-samples.json) | Fixture/simulated evidence is not real Ring evidence |
| CareLoop does not call emergency services | No emergency dispatch integration; exhausted copy recommends local support | [`src/domain.js`](src/domain.js), [`PRIVACY.md`](PRIVACY.md) | Household members choose their own next step |
