# RateGuard Launch Follow-Up Memo

## Rate Limit Change

The default rate limit ships at 500 requests per second. Load testing showed that the 1000 requests per second target agreed in the planning meeting caused unacceptable tail latency at the edge. To be explicit for the on-call rotation: The default rate limit ships at 500 requests per second.

## Monitoring

Alerts now page the on-call engineer directly instead of posting to the team channel. The rejection-rate dashboard is available to every client team.

## Open Questions

It is still undecided whether enterprise customers get a separate default limit. The team has not agreed on who approves a quota change.
