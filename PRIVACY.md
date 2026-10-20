# Privacy

- CareLoop stores only household action state, limited event metadata, consent, and minimal audit/access records. It never requests Ring media, video, or snapshots.
- Caregiver access requires an owner-approved consent record. Margaret can pause sharing; paused or unconsented caregivers are denied alert and timeline access.
- In demo mode, the browser receives an opaque server-side session cookie for the selected demo page; no bearer token is included in page HTML or JavaScript. Disable demo sessions before deployment.
- Caregiver reads of alerts, timeline, and source counts are recorded. Audit entries retain actor IDs, roles, timestamps, and event IDs rather than message bodies.
- The configured retention is 30 days for audit entries. Configure persistent storage only with an appropriate retention/backup policy.
- Household deletion removes household data and retains only a deletion-request ID and timestamp.
- Access tokens are memory-only. Refresh credentials are kept server-side; rotated refresh token material is written only to `data/ring-refresh.json` with mode 0600. Never commit secrets.
- Recorded fixtures must be sanitized; shipped fixtures are synthetic. No real names, email addresses, or tokens belong in fixtures.
- The browser calls only CareLoop endpoints. Ring API and optional notification calls originate on the server.
- Ring events indicate possible activity or visitor/delivery metadata. They cannot establish that a person is okay. CareLoop never contacts emergency services.
- Ring-driven account linking is not implemented. Real Ring behavior depends on credentials, account permissions, device availability, API behavior, and the Ring base plan.
