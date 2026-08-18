# Security and operations for robot web bridges

## Contents

- Define the trust boundary
- Authenticate HTTP and WebSocket clients
- Validate Origin and configure CORS
- Terminate TLS and proxy streams
- Apply authorization, validation, and limits
- Manage connection lifecycle and observability

## Define the trust boundary

Document whether the system is:

- loopback-only development;
- a trusted robot LAN;
- a site network with authenticated operators;
- reachable through a VPN;
- exposed to an untrusted or public network.

Do not apply internet-facing authentication requirements to a repository that explicitly specifies a trusted-LAN/no-auth design unless the user authorizes a design change. Conversely, do not call a no-auth LAN service safe for public exposure.

Expose the narrowest web surface. Keep DDS on the robot network and publish only application resources through the bridge.

## Authenticate HTTP clients

Prefer established organization identity/session infrastructure. For bearer tokens:

- validate signature, issuer, audience, expiry, and not-before;
- rotate keys and reject algorithms not explicitly allowed;
- avoid hardcoded shared secrets;
- distinguish 401 authentication failure from 403 authorization failure;
- apply authorization at the resource/action level.

Do not implement JWT verification by merely decoding a token and checking `exp`.

## Authenticate browser WebSockets

Browser `new WebSocket(url, protocols)` exposes URL and subprotocol selection, not arbitrary request headers. Choose one of these patterns:

### Same-origin session cookie

Prefer this when the web application and WebSocket endpoint share an authenticated site:

- set `Secure`, `HttpOnly`, and an appropriate `SameSite` attribute;
- validate the session before accepting the socket;
- validate the `Origin` header against an exact allowlist;
- close sockets on logout/expiry and periodically revalidate long sessions;
- authorize each state-changing message.

Cookie authentication without Origin validation is vulnerable to Cross-Site WebSocket Hijacking.

### First-message bearer token

Use a short-lived token as the first application message when cookies are unsuitable:

```python
async def authenticate_first_message(ws, verify_token):
    await ws.accept()
    try:
        message = await asyncio.wait_for(ws.receive_json(), timeout=3.0)
        principal = verify_token(message.get("token"))
    except (TimeoutError, ValueError, KeyError):
        await ws.close(code=1008, reason="Authentication failed")
        return None
    return principal
```

Do not process subscriptions or commands before authentication completes.

### Single-use handshake ticket

If authentication must happen before upgrade:

1. Obtain a short-lived, single-use ticket over authenticated HTTPS.
2. Put only that ticket in the WebSocket URL.
3. Consume it atomically during handshake.
4. Redact query strings in proxy/application logs.

Do not put long-lived access tokens, passwords, or reusable API keys in query parameters.

## Origin and CORS

Validate WebSocket `Origin` independently from CORS middleware. Use exact scheme/host/port allowlists; reject missing origins for browser-only endpoints unless a documented non-browser client requires them.

CORS applies to browser HTTP fetches, not as a general authorization mechanism:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://dashboard.example.com"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
)
```

Do not combine `allow_credentials=True` with wildcard origins. Remember that non-browser clients ignore CORS.

## TLS and reverse proxy

Use WSS/HTTPS outside loopback. A minimal nginx pattern:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 443 ssl;
    server_name robot.example.com;

    ssl_certificate /etc/ssl/certs/robot.pem;
    ssl_certificate_key /etc/ssl/private/robot.key;

    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 60s;
    }

    location /video/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_buffering off;
        proxy_cache off;
    }
}
```

Set timeouts from heartbeat behavior; do not use an unexplained 24-hour idle timeout. Configure trusted proxy headers in the application and prevent direct bypass of the proxy where it enforces security.

## Authorization and message validation

For every inbound message:

- enforce a message-size limit;
- parse a versioned schema;
- reject unknown fields where ambiguity is unsafe;
- validate units, numeric ranges, topic/action allowlists, and command age;
- authorize the requested action and robot/resource;
- rate-limit by user/session/device, not only IP;
- log outcome metadata without secrets or full sensitive payloads.

Use separate permissions for viewing telemetry, changing configuration, starting/stopping recording, and motion control.

## Rate limiting and backpressure

Apply limits at multiple layers:

- connection attempts and concurrent connections at proxy/server;
- messages per second and bytes per second per connection;
- command rate per principal/robot;
- server maximum subscription rate regardless of client request;
- bounded queues with documented drop policy;
- global encoder/CPU/memory budgets.

For latest-value telemetry, overwrite stale queued data. For events that must not be lost, use bounded durable storage or explicit acknowledgments; do not silently apply latest-only semantics.

Detect slow clients from send duration, queue depth, or transport metrics. Reduce quality/rate or disconnect before memory grows unbounded.

## Connection lifecycle

- Track active sockets and their authenticated principals.
- Remove sockets in `finally`, not only on a clean `WebSocketDisconnect`.
- Add heartbeat/application liveness where proxies or networks can silently drop connections.
- Revalidate authorization for long-lived connections.
- Close all sessions for a principal on logout/revocation.
- Cancel per-client tasks and release subscriptions/encoders.
- Make cleanup idempotent so concurrent failure paths are safe.

## Observability

Log:

- connection open/close with principal, origin, endpoint, and reason;
- authentication and authorization failures;
- schema/size/rate-limit rejections;
- command IDs and state transitions;
- ROS dependency unavailability and timeouts;
- stream rate/drop/backpressure metrics;
- abnormal disconnects and cleanup failures.

Never log access tokens, cookies, session IDs, TURN credentials, full query strings, or raw image/point-cloud payloads.

## Security tests

- Connect from an unapproved Origin.
- Connect without/with expired credentials.
- Attempt a replayed single-use ticket.
- Send oversized, malformed, and high-rate messages.
- Attempt unauthorized robot/action/topic targets.
- Expire/logout a session while its socket is connected.
- Bypass the reverse proxy and confirm the backend is unreachable or equivalently protected.
- Verify query/token redaction in access and error logs.
- Verify teleoperation stops on auth expiry or disconnect.

## Primary sources

- https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html
- https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket
- https://websockets.readthedocs.io/en/10.0/topics/authentication.html
- https://fastapi.tiangolo.com/advanced/websockets/
