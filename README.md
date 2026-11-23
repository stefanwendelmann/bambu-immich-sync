# Bambu Immich Sync

Automatically download completed Bambu Lab timelapse MP4 files via implicit FTPS (port 990) and upload them to your Immich account and album using the official Immich CLI.

> **Status:** Live-tested with a P2S and Immich. Automated mocked tests and Docker smoke tests pass.

## Requirements

- A Bambu Lab printer exposing `/timelapse` by FTPS, with local IP and LAN access code
- An Immich account and an API key with upload and album permissions
- Docker with Compose; reachability from container to printer and Immich

## Quick start

For a Docker-Hub installation, download the provided Compose file and environment template without building from source:

```sh
curl -O https://raw.githubusercontent.com/stefanwendelmann/bambu-immich-sync/main/compose.yaml
curl -O https://raw.githubusercontent.com/stefanwendelmann/bambu-immich-sync/main/.env.example
mv .env.example .env
# Edit .env: printer IP/DNS, access code, Immich URL/API key, album
docker compose pull
docker compose up -d
docker compose logs -f
```

Direct Docker start:

```sh
docker pull stefanwendelmann/bambu-immich-sync:latest
```

The Docker image expects configuration through environment variables or `.env`; never commit `.env`.

### Build from source

```sh
cp .env.example .env
# Edit .env: printer IP, access code, Immich URL/API key
# Prefer IP or reachable LAN URL for Immich, not immich-server unless on same Docker network.
docker compose up -d --build
docker compose logs -f
```

The first cycle records video sizes; files are downloaded after sizes remain unchanged for the next `SYNC_INTERVAL` seconds. Only names like `video_2026-11-21_20-58-28.mp4` are processed. Files `tmp.video` and `thumbnail/` are ignored. Upload state is retained under `/data/state.json`; videos under `/data/videos/`.

`DELETE_LOCAL_AFTER_UPLOAD=true` removes *local downloaded copies* after successful CLI upload and album verification, **never** original files on the printer. The default is `false`. Existing videos are uploaded on first run (after stability confirmation). The service verifies album membership through the Immich API before marking a file `album-assigned`.

## Important limitations

- FTPS with `BAMBU_TLS_VERIFY=false` does not validate the printer TLS certificate. Use only on a trusted private network; verify/pin certificate for stronger security.
- The P2S is connected with implicit FTPS using TLS 1.2 and SNI. This matches the verified live P2S behavior and avoids the printer's TLS session-reuse requirement for data transfers.
- A same-size, same-timestamp mutation cannot be ruled out cryptographically. The service re-lists metadata before and after transfer and retries changed transfers, but FTP metadata is not guaranteed to be trustworthy.
- If local state is reset, the CLI's Immich hash deduplication normally avoids duplicate assets. Album membership is still checked against the configured album.
- After failed transfers, the next cycle retries. If a file changes during transfer, the next cycle detects its size/signature change before reuploading.
- Only implicit FTPS on port 990 is supported. The P2S LAN access code is used as the `bblp` password.
- CI publishes GHCR images only after tests and the amd64 CLI smoke check; multi-architecture publishing and the upstream CLI image should still be reviewed before release.

## Troubleshooting

- `Missing required environment variable ...`: verify every required value in `.env` and restart Compose.
- FTPS connection failures: confirm printer IP, port 990, `bblp` credentials, and that Docker can reach the printer LAN.
- `Immich album lookup failed` or membership errors: the API key needs asset upload/read and album permissions for the selected user.
- Invalid JSON state: the service renames `state.json` to `state.json.corrupt-<timestamp>` and starts a clean state. Keep the quarantine file for diagnosis.
- Safe retries: failed files remain in local state as `failed_retryable` and are retried on later cycles. `.part` files are removed after failures.

Use `RUN_ONCE=true` for a one-shot diagnostic run. `docker compose up --build` remains the normal unattended mode.

## Real-device validation checklist

Before treating a release as stable:

1. Connect one P2S successfully at `/timelapse` with `BAMBU_TLS_VERIFY=false` or a verified certificate.
2. Confirm `tmp.video` is never downloaded and thumbnails/3MF files are ignored.
3. Start a short print and verify no growing MP4 is uploaded until it settles.
4. Complete the print and verify the MP4 appears in the selected Immich account and album.
5. Restart the container twice and confirm no duplicate or unnecessary re-download occurs.
6. Temporarily stop the printer or Immich, then restore them and confirm recovery.
7. Confirm `/timelapse` remains unchanged and no printer files are deleted.

## Testing

```sh
npm ci
npm test
```
