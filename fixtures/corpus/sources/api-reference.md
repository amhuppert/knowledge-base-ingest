# RateGuard API Reference

## Authentication

Clients authenticate with an API key passed in the Authorization header. The Gateway service validates the key against the Accounts service before forwarding the request.

## Endpoints

The Gateway service exposes the /v1/limits endpoint. The /v1/limits endpoint returns the current quota for the authenticated client. The Metrics service consumes the audit log produced by the Gateway service.

## Error Responses

When a client exceeds its quota, the Gateway service returns HTTP 429. The response body includes a machine-readable error code and a human-readable message.

## Pagination

List endpoints return at most fifty items per page. Clients page through results with an opaque cursor token.
