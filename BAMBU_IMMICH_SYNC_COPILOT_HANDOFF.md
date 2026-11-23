# Bambu Immich Sync — Project Handoff for GitHub Copilot

> **Read this document first.** It describes the confirmed hardware behavior, product goals, existing prototype, known limitations, and the implementation plan. Treat the existing repository as an **untested prototype**, not as production-ready software.

## 1. Your role and working method

Act as a senior Node.js, Docker, security, and CI/CD engineer. Continue implementing the open-source project **`bambu-immich-sync`** incrementally, with tests and clear documentation. Do not guess behavior of a printer or Immich CLI that can be verified from code, official docs, or actual logs.

**Priority:** Make the existing prototype safely and reliably work with one Bambu Lab P2S and one Immich instance before adding support for other models or features.

For each meaningful change:
1. Inspect the repository and summarize the existing behavior.
2. State the change, assumptions, and how it can be tested.
3. Make small, reviewable commits or patches.
4. Add or update automated tests and user-facing documentation.
5. Keep all credentials out of the repository, logs, and test fixtures.

Ask for sensitive values only to be placed in local `.env` files or secret stores; never ask users to paste access codes or API keys into chat or GitHub issues.

## 2. Product goal

Develop a self-hosted, open-source Docker application that:

- Connects over the local network to a Bambu Lab printer using **implicit FTPS on TCP port 990**.
- Detects completed 3D-print timelapse videos on the printer's removable storage.
- Downloads **new and stable MP4** files automatically.
- Uploads them to a user-selected **Immich account** using the **official Immich CLI**.
- Automatically places the assets into a configurable Immich album, e.g. **`3D P2S Zeitraffer`**.
- Prevents unnecessary re-downloads and duplicate imports.
- Runs unattended as a single Docker container, configured through environment variables / Docker Compose.
- Can eventually be published on GitHub, Docker Hub, and optionally GHCR, with automated CI and controlled updates of the official Immich CLI base image.

**Initial target:** Bambu Lab P2S. Other compatible Bambu Lab printers may be added after confirmation of their file layouts and protocols.

**Architecture:** Bambu P2S (FTPS) → Node.js sync service in Docker → local persistent `/data` → official Immich CLI → Immich API and album.

**No Home Assistant dependency.** Home Assistant integration may be a future optional feature. The user's setup includes Home Assistant on Raspberry Pi and Immich in Docker on an Ubuntu VM hosted by Proxmox on an HP Z420, but the software should be broadly deployable.

## 3. Confirmed real-world P2S findings (verified with FileZilla on Windows)

The user **successfully connected** to the physical Bambu Lab P2S with FileZilla and **successfully downloaded MP4 files**.

- Connection: FTPS (implicit TLS), port `990`.
- User: `bblp`.
- Password: printer's local LAN access code.
- FTP root `/` shows several `.3mf` files and a `timelapse` directory.
- **Completed videos are directly under `/timelapse/`**.
- Example: `/timelapse/video_2026-11-21_20-58-28.mp4`.
- While the printer is actively printing, `/timelapse/tmp.video` is present. **Never import it.** It appears to be an in-progress recording; this interpretation is a hypothesis, but exclusion is mandatory.
- `/timelapse/thumbnail/` contains JPEG thumbnails for each video, generally a regular `.jpg` and a `_mini.jpg` using the same stem as the MP4.
- Do not upload thumbnails or `.3mf` files by default.

Example directory layout:

```text
/
├── print_file.3mf
└── timelapse/
    ├── video_2026-11-21_20-58-28.mp4
    ├── tmp.video
    └── thumbnail/
        ├── video_2026-11-21_20-58-28.jpg
        └── video_2026-11-21_20-58-28_mini.jpg
```

Note: the user repeated one thumbnail filename when describing the pair, but explicitly confirmed that one version has `_mini.jpg` and the other does not. Use the above as the expected structure, and keep thumbnail handling optional.

## 4. Existing prototype: inventory and behavior

A prototype project archive was already produced as **`bambu-immich-sync-prototype.zip`**, with this structure:

```text
bambu-immich-sync/
├── .github/workflows/publish.yml
├── src/helpers.mjs
├── src/sync.mjs
├── tests/helpers.test.mjs
├── .dockerignore
├── .env.example
├── .gitignore
├── Dockerfile
├── compose.yaml
├── package.json
└── README.md
```

The source code currently:

- Uses Node.js ES modules and the npm package `basic-ftp`.
- Creates an FTPS client with `user: 'bblp'`, `secure: 'implicit'`, port 990, configurable TLS verification.
- Lists files in the configured remote folder; `helpers.mjs` filters recognized timelapse MP4 names.
- Records file metadata/signatures and first-observed times in `/data/state.json`.
- Waits for a file to have a stable signature for at least `SYNC_INTERVAL` before downloading.
- Downloads first to a `*.part` file and checks downloaded byte count against the listed size before renaming.
- Invokes the official CLI as a child process via roughly:

```sh
immich upload --album-name "3D P2S Zeitraffer" --no-progress /data/videos/video_2026-11-21_20-58-28.mp4
```

- Marks success in persisted state only after the CLI exits with code `0`.
- Optionally deletes the **local downloaded copy** after a successful upload; **never deletes the file on the printer**.
- Repeats polling at `SYNC_INTERVAL` seconds and supports `RUN_ONCE`.
- Has two existing helper-level tests, according to the previous prototype run. Re-run these; do not assume integration tests exist.
- Has a GitHub Actions workflow for tests plus publishing to Docker Hub and GHCR.

**Important:** At the time of handoff, the prototype had **not** been Docker-built, run against the real P2S, or successfully uploaded to Immich in a verified end-to-end test. No public repository or published Docker Hub image has been confirmed.

### Docker image approach

The current Dockerfile uses a Node Alpine build stage for npm dependencies, then:

```dockerfile
FROM ghcr.io/immich-app/immich-cli:latest
```

The runtime copies Node packages and JS source into that base image, then executes `node /app/src/sync.mjs`. Verify that **the current official Immich CLI image** contains a compatible Node runtime, the `immich` executable in PATH, required system libraries, and supports the intended architectures and CLI flags. Do not treat this as validated merely because the Dockerfile exists.

## 5. Existing proposed configuration (check against implementation)

```dotenv
BAMBU_HOST=192.168.178.50
BAMBU_ACCESS_CODE=REPLACE_ME
BAMBU_FTPS_PORT=990
BAMBU_REMOTE_PATH=/timelapse
BAMBU_TLS_VERIFY=false
IMMICH_INSTANCE_URL=http://immich-server:2283/api
IMMICH_API_KEY=REPLACE_ME
IMMICH_ALBUM_NAME=3D P2S Zeitraffer
SYNC_INTERVAL=300
DELETE_LOCAL_AFTER_UPLOAD=false
RUN_ONCE=false
```

**Notes:**
- `192.168.178.50` is only an example. Never hardcode a specific printer IP.
- The Immich API URL must be reachable **from inside the container**. A Docker-internal service name works only on a shared Docker network; otherwise use a reachable LAN address/domain.
- `BAMBU_TLS_VERIFY=false` is a prototype setting for a trusted local network with a possibly self-signed device certificate. Provide safer TLS verification / certificate pinning when possible, and document the risk clearly.
- Treat `.env` and API credentials as secrets; exclude them from Git and logs.
- The Immich API key must belong to the desired Immich user and have the necessary permissions to create/upload assets and use albums. Verify current Immich permissions requirements.
- Check whether newer Immich CLI versions still recognize `IMMICH_INSTANCE_URL`, `IMMICH_API_KEY`, `upload`, `--album-name`, and `--no-progress` as expected.

## 6. Mandatory behavior and acceptance criteria

### File detection and download

- List `/timelapse` and select completed MP4 videos; skip subdirectories, `.jpg`, `.3mf`, `tmp.video`, and arbitrary unrecognized files.
- Do not assume that *every* `.mp4` is complete merely because its name ends with `.mp4`.
- Require stable remote size / metadata over at least two separate polls, with a minimum age or settling window when appropriate.
- Avoid uploading a file that changes while downloading. A byte-count check alone **cannot** detect same-size changes or all file mutations. Consider re-listing metadata before and after transfer, timestamps when trustworthy, and a configurable delay; test with simulated changes.
- Write downloads to a temporary path, then atomically promote completed downloads where possible.
- Handle printer being offline, FTPS timeouts, connection resets, and transient errors without losing state or crashing permanently.
- Support initial import of existing recordings; document any option to skip history if added.

### Immich upload and state

- Upload with the **official Immich CLI**, honoring user and album configuration.
- Handle an existing asset and album association correctly; verify what the CLI actually does when it reports an asset as duplicate. Never assume `--album-name` adds an existing asset to the album without a test.
- Avoid duplicates on retries and container restarts.
- Use an atomically written persistent state file or SQLite; `/data` must be mounted as a volume.
- Distinguish statuses: discovered, stable, downloaded, uploaded, album-assigned, failed/retryable.
- Never mark an upload as complete if the CLI failed or if album assignment was not confirmed when album assignment is a requirement.
- Support retention configuration **only for local cache copies**, with a default that never removes anything from the printer.
- Limit disk growth and document cache behavior. Handle low disk space.
- Support safe retries with backoff and avoid overlapping sync cycles.

### Operator experience

- Provide concise structured logs with filename, stage, elapsed time, and sanitized errors, without leaking keys.
- Validate all required config at startup; fail with actionable error messages.
- Make shutdown graceful (`SIGTERM`) and do not interrupt a state write.
- Provide a minimal ready-to-run `compose.yaml`, `.env.example`, clear README, troubleshooting section, and optional one-shot test mode.
- Keep a portable config suitable for other Bambu printer owners.

### Security

- No shell interpolation of file paths or user-supplied values; use safe spawn argument arrays and robust path handling.
- Ensure remote filenames cannot escape the local download directory (path traversal / weird Unicode / separators).
- Restrict mounted directories and container permissions where possible; use a non-root runtime if compatible.
- Do not make the printer's FTPS endpoint publicly accessible.
- Never embed access codes or API keys in images, CI artifacts, README examples, or GitHub Actions logs.
- Review base image updates and supply-chain security before automatic releases.

## 7. Immediate engineering backlog (prioritized)

### P0 — Establish a working, testable baseline

1. Inspect all prototype files and run `npm test` locally; fix any errors.
2. Inspect official Immich CLI documentation/source and verify current version, environment variable names, required scopes, Docker image shape, and upload flags.
3. Build the Docker image for `linux/amd64` and run startup + `immich --help` smoke checks inside the resulting image.
4. Create mock FTPS and mock Immich CLI integration tests, including offline printer, new file, still-growing file, `tmp.video`, broken transfer, failed CLI upload, and restart scenarios.
5. Confirm that `basic-ftp` uses implicit FTPS correctly for the P2S, including certificate behavior, listing, and `downloadTo` on a live printer.
6. Test the complete flow with a real P2S and test Immich account/album, without deleting originals.

### P1 — Reliability and data correctness

7. Improve download race handling, idempotency, durable state writes, and error handling.
8. Verify duplicate asset behavior and album membership with current Immich; fix if necessary using supported Immich APIs.
9. Add configurable handling for existing videos, retries/backoff, disk cache cleanup, and single-process locking.
10. Add structured/clear logs and documentation for troubleshooting.

### P2 — Open-source packaging and release

11. Add `package-lock.json` and reproducible npm install (`npm ci`); pin major image/build tooling versions as appropriate.
12. Add a permissive license (e.g., MIT) only after the repository owner selects it; review third-party dependency licenses.
13. Finish README including setup screenshots/examples if useful, network prerequisites, supported printers, FAQ, limitations, and security guidance.
14. Strengthen GitHub Actions: run tests on PRs; publish only trusted branch/tags; permissions; multi-arch smoke tests; safe handling of forks and secrets.
15. Publish images to GHCR and Docker Hub using owner-configured credentials, semantic version tags, and a documented `latest` policy.
16. Check the upstream Immich CLI image regularly; rebuild and **test** when it changes. Rebuilding `FROM ...:latest` is not equivalent to hot-updating a running image. Avoid silently deploying untested upstream breaking changes.

### P3 — Optional future enhancements

17. Add confirmed compatible models, configurable file naming rules, and printer-specific remote paths.
18. Optionally import thumbnails or create richer descriptions (not needed for v1).
19. Optional multiple-printer support with separate state namespaces and album routing.
20. Optional Home Assistant status sensor/webhook and Docker healthcheck.

## 8. Specific prototype issues to inspect carefully

- **Metadata signature:** Check implementation in `src/helpers.mjs`; FTP metadata timestamps may be absent, coarse, or inconsistent. Ensure readiness checks don't falsely identify active writes as finished.
- **Stability timing:** Determine whether two polls are actually required and whether the first poll persists correctly after restart.
- **Race condition:** A downloaded MP4 may change during the transfer; recheck remote metadata and retry or discard when unsafe.
- **State validation:** Corrupt or partially written JSON needs defined recovery behavior; atomic rename is present but not sufficient for every failure mode.
- **Upload idempotency:** Investigate CLI behavior for duplicate hashes and album membership; a successful CLI process exit does not necessarily prove album association.
- **CLI base image:** Confirm availability of Node, `immich` executable, and `basic-ftp` dependencies; do a real Docker build and smoke test.
- **Architecture compatibility:** Ensure copied node dependencies are compatible with the CLI image and `linux/arm64` if publishing multi-architecture builds.
- **Current CI:** The scheduled publish job pushes `latest` without full integration validation. Define controlled releases and prevent accidental publication of broken builds.
- **Tests:** The current suite only checks helper logic. Add end-to-end and failure-path tests before declaring stability.

## 9. Definition of done for v1.0

A fresh user with a compatible Bambu printer and Immich can:

1. Copy `compose.yaml` and `.env.example`, set printer IP/access code and Immich endpoint/API key/album.
2. Execute `docker compose up -d` using a published image.
3. Observe existing completed MP4 files imported into the correct Immich user and album.
4. Print another model; find its new timelapse in Immich automatically after completion and polling.
5. Restart the container repeatedly without duplicate assets or unnecessary re-downloads.
6. Survive a temporarily unavailable printer or Immich server and recover automatically.
7. Verify that no videos on the printer are modified or deleted.
8. Consult the README to diagnose errors and safely update the container.

All acceptance criteria should be backed by automated tests where practicable, plus a documented real-device validation checklist.

## 10. Suggested first Copilot task

> Inspect this repository and read `BAMBU_IMMICH_SYNC_COPILOT_HANDOFF.md`. Begin with **P0 only**. Audit the code against the documented behavior; run tests; verify official Immich CLI image and commands; fix blocking issues; add a repeatable Docker build/smoke test. Do not add unrelated features, publish images, or delete files from the printer. Show the changed files, test results, and any assumptions that still need validation on the physical P2S.

---

**Handoff snapshot:** 2026-11-23. Hardware FTPS listing and MP4 download are confirmed via FileZilla; Docker/Immich end-to-end operation is not yet confirmed. This file is an implementation brief, not a claim that all features already work.
