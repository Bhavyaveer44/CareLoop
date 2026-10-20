# Friction log

| task | steps | expected | actual | severity | workaround | suggestion |
|---|---|---|---|---|---|---|
| Start local demo | Install dependencies, then run `npm start` | Three demo pages load and use the local demo session | Demo identity is selected by the page route; production needs an identity provider | Low | Set `DEMO_MODE=false` and provide protected API auth for deployment | Add a production identity provider |
| Connect Ring | Configure playground credentials and sync | Device health and event metadata appear | OAuth refresh rotation and account permissions can prevent a sync | Medium | Use fixtures until credentials and permission are confirmed | Add an owner-controlled Ring connection diagnostic |
| Test alert timing | Change demo clock speed | Prompt, reminder, cutoff, and escalation stages advance | Browser timer throttling may delay visible updates | Low | Keep the caregiver page foregrounded | Make clock controls show last sweep time |
