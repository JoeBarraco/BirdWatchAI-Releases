# live-token

Hands out tokens for the BirdWatch live relay (`live.birdwatchai.com`), the server that carries
community live view. Design and the relay itself: `birdwatchai-server/docs/LIVE-VIEW.md`.

| Call | Who | Proof | Returns |
|---|---|---|---|
| `POST {device_key, write_token}` | a feeder | its community write token (`feeder_write_tokens`) | publish key, 24 h |
| `GET ?feeder=<device_key>` | a viewer on the site | can SELECT that feeder's row as themselves (RLS) | viewer token, 5 min |

Legacy feeders that never claimed a write token can't publish. Private feeders can only be
watched by members of their community, the same rule as their detections.

## Deploy

```bash
supabase secrets set RELAY_SECRET=<same value as RELAY_SECRET in the relay's .env>
supabase functions deploy live-token --no-verify-jwt
```

`--no-verify-jwt` is required. The site sends the publishable key as Bearer (not a JWT) and
feeders call without a user; the function does its own authorization. Until `RELAY_SECRET` is set
it answers 503 "live view not configured".
