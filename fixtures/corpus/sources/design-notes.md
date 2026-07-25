# RateGuard Design Notes

## Storage

The token store keeps per-client counters in Redis for low-latency reads. Each counter tracks a sliding one-minute window. Redis was chosen for its atomic increment operations.

## Rate Limit Algorithm

RateGuard uses a token-bucket algorithm to smooth bursts. The default rate limit is 100 requests per second per client. Buckets refill continuously at the configured rate.

## Constraints

The limit is enforced at the edge. The limit is enforced at the edge. Enforcement must add no more than two milliseconds of latency to any request.

## Request Pipeline

Incoming requests pass through an authentication filter before the rate limiter. Rejected requests return a 429 status with a Retry-After header.
