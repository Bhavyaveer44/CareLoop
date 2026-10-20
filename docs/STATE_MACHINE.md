# CareLoop state machine

| State | Meaning | Allowed next states | Actor |
|---|---|---|---|
| ASSIGNED | A caregiver owns an open task | ACKNOWLEDGED, ESCALATED, RESOLVED, EXHAUSTED | Owner, recipient confirmation, sweep |
| ACKNOWLEDGED | Caregiver accepted ownership | RESOLVED | Owner or phone-confirming caregiver |
| ESCALATED | Task moved to backup caregiver | ACKNOWLEDGED, RESOLVED, EXHAUSTED | Backup caregiver, sweep |
| RESOLVED | A person confirmed or caregiver recorded a phone confirmation | — | Recipient or caregiver |
| EXHAUSTED | No caregiver acknowledged | — | Sweep |

Each transition compares the stored `version` to the version read by the caller. A successful compare-and-set increments it; a stale version returns a conflict. The first successful transition wins the acknowledgement/escalation race.

There is one alert per household and local calendar date (`household#YYYY-MM-DD`). At 08:00 local time the daily prompt opens. A reminder is recorded at 09:30; at the 10:00 cutoff the morning-check decision is applied. Data-gap and morning-check information merge into the same daily alert. A data gap has precedence and produces UNVERIFIABLE immediately, with the normal five-minute caregiver acknowledgement window. Confirmed recipient input resolves; Ring evidence never resolves an alert. Fresh/no evidence creates an UNCONFIRMED task and acknowledgement deadline. Possible activity creates a low-priority note and a second recipient prompt, promoted to a task after the configured 60 minutes.

Primary and backup caregivers have 22:00–07:00 local quiet hours in their own time zones. A one-second sweep uses the demo clock for prompt, reminder, cutoff, promotion, and acknowledgement deadlines. It skips a caregiver in quiet hours, appends a minimal audit record, and tries the consented backup. If no caregiver is available, the alert becomes EXHAUSTED with the neighbor/local-support suggestion. CareLoop never contacts emergency services.
