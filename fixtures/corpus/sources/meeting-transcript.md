# Rate Limit Planning Meeting

## Limits Discussion

Alice noted that for launch the default rate limit is 100 requests per second. Bob replied that marketing wants us to raise the default rate limit to 1000 requests per second for the launch. The team agreed to raise it.

## Open Questions

Carol said it is still unclear whether burst credits should roll over between windows. Dave added that we have not decided how to handle clients that share an IP address.

## Monitoring

The team will add a dashboard tracking rejection rates per client. Alerts fire when the rejection rate exceeds five percent.
