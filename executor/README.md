# Independent three-node Copilot executor

This module is separate from the original mobile/PC App conversation relay.
It does not extend that relay's endpoints, permissions, accounts, bindings or
desktop extension. Install and run it from `executor`, not the repository root.

## Topology and capabilities

```text
Operator terminal ──outbound WSS──┐
PC A: Copilot SDK ──outbound WSS──┼── Public authenticated relay
PC B: device tools ─outbound WSS──┘
                      A → relay → B → relay → A
```

Copilot reasoning, conversation state and GitHub credentials live on **A**.
Target files and processes live on **B**. Neither private PC needs an inbound
listener, publicly routable address, port forwarding or SSH access.
The operator can run on A or another computer.

| Surface | First version |
| --- | --- |
| Copilot session creation/resume | Official Node SDK; private state directory on A |
| Live output, questions, permission decisions | Companion terminal over the relay |
| Reconnect | Transport reconnect + bounded event replay/history snapshot; no instruction replay |
| B filesystem | Device information, directory list, UTF-8 read/write |
| B processes | Allowed executable + argument array, live stdout/stderr, bounded output/time, no shell by default |
| Native Copilot CLI TUI / Copilot App attachment | **Not implemented**; this terminal is a companion, not native remote mounting |
| B desktop/browser, interactive PTY, file picker, binary uploads | **Not implemented** |
| Arbitrary local Copilot tools transparently targeting B | **Not supported**; each capability needs a real remote adapter |

A uses SDK `mode: "empty"` with an explicit `custom:device_*` allowlist and
`builtin:*`/`mcp:*` exclusions. Host git operations, file hooks, instruction
discovery, shared session store and skills are disabled. An isolated A workspace
holds session data only; it is never advertised as B's working directory.
This is an intentionally restricted SDK session, **not full local feature parity**.

## Requirements and supported interface

- Node.js **22.12+** on A and on machines running from source; the standalone
  Windows B executable includes its runtime and needs no Node.js installation.
- Windows, Linux and macOS are implementation targets. The pinned SDK includes
  Windows/Linux/macOS x64/arm64 optional runtime packages (also Linux musl).
  Keep optional dependencies enabled on A.
- A needs a Copilot-enabled account and a credential supported by the official
  SDK/CLI authentication flow. Set `EXECUTOR_GITHUB_TOKEN` explicitly. Existing
  PC App/CLI login state is not used or modified.
- B defaults to terminal approval. Headless operation is possible only with
  explicitly selected `EXECUTOR_APPROVAL=operator`, trusting paired A to obtain
  the operator's decision for each request; this is not approve-all.
- Public deployment needs a TLS reverse proxy supporting WebSocket upgrades,
  a trusted certificate, and a persistent process supervisor.

The implementation pins `@github/copilot-sdk` **1.0.21**, bundled runtime
**1.0.97**, and `ws` **8.22.0** in a separate lockfile. It uses published
`createSession`, `resumeSession`, `send`, `on`, `getEvents`, `abort`, `stop`,
`onPermissionRequest`, `onUserInputRequest`, and custom tool handlers.
No CLI flags, private App interfaces or native remote attachment protocols
are invented. The SDK also documents experimental AHP hosting, but that is not
evidence that an arbitrary Copilot App can mount this executor; it is not enabled.

References:
[official Node SDK](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md),
[SDK getting started](https://github.com/github/copilot-sdk/blob/main/docs/getting-started.md),
[CLI authentication](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli).
The installed package declarations, not unreleased `main` examples, govern this version.

## Explicit pairing

One relay process serves **one A / one B / one operator** pair.
Provision three **different** random role tokens offline, using a protected
secret manager or secure administrative channel. Generate each token with:

```console
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The relay gets all three tokens. A gets only the agent token, B only the device
token, and the operator only the operator token. This explicit provisioning is
the authorization/pairing step; there is no open registration or unauthenticated
execution endpoint. Possessing a role token authenticates that role, not a
hardware identity or attested device. Revoke/rotate tokens and restart the relay
to change the pair. Do not reuse one token for multiple roles.

Protect environment variables and state with OS user permissions. On Windows,
Node's POSIX file modes do not configure ACLs: use a directory owned by the
dedicated service user. Never commit tokens or copy personal App account data.

## Install and start

For source-based setup, install dependencies from this directory on the nodes
you run from source:

```console
npm ci
```

### Build a standalone Windows device app

From the repository root, run this once on a Windows x64 build machine:

```powershell
.\executor\build-device.ps1
```

The script installs/upgrades Node.js LTS with `winget` if Node.js 22.12+ is not
available, installs the locked npm dependencies, and builds
`executor\dist\device.exe`. It may require approval for the Node.js installer.
The build machine needs internet access. Copy `device.exe` to private PC B; B
does not need Node.js, npm, or this repository. This packages only the device
role, not A, the relay, or the operator.

On B, open PowerShell in the directory where you want the device state stored
and run the app with its configuration:

```powershell
$env:EXECUTOR_RELAY = 'wss://your-relay-host'
$env:EXECUTOR_DEVICE_TOKEN = '<device-token>'
$env:EXECUTOR_ROOT = 'C:\work\my-project'
.\device.exe
```

Keep the terminal open. By default, each request requires local approval in
that terminal. Optionally set `EXECUTOR_STATE` to a stable private directory
and `EXECUTOR_EXECUTABLES` to a JSON array of explicitly allowed absolute
executable paths. Do not place tokens in the executable or commit them.

Double-clicking the executable does not set these environment variables.
Set them in PowerShell and launch the executable from that same window.
Startup failures display their cause and configuration instructions; in an
interactive console the app waits for Enter before closing. Noninteractive
launches still exit with a failure status without waiting for input.

Examples below use placeholders for your separately provisioned tokens.
The localhost URL is for a same-host smoke test only. In deployment use
`wss://your-relay-host` on A, B and the operator. Non-loopback `ws://` is rejected.

### Public relay

To build the standalone Windows x64 relay server, run from the repository root:

```powershell
.\executor\build-relay.ps1
```

Like the device build script, this installs/upgrades Node.js through `winget`
when needed and installs the locked build dependencies. The output is
`executor\dist\relay.exe`. Copy it to the Windows relay server; Node.js and npm
are not required there. In PowerShell on that server, set the three different
role tokens as shown below, then run `.\relay.exe` instead of `npm run relay`.
Startup errors remain visible until Enter is pressed in an interactive console.

This executable is a console server, not a native Windows service. The build
script does not register a service or update/restart a deployed server. Public
TLS reverse proxy and persistent process supervision are still required.

PowerShell:

```powershell
$env:EXECUTOR_AGENT_TOKEN = '<agent-token>'
$env:EXECUTOR_DEVICE_TOKEN = '<device-token>'
$env:EXECUTOR_OPERATOR_TOKEN = '<operator-token>'
npm run relay
```

Linux/macOS shell:

```sh
export EXECUTOR_AGENT_TOKEN='<agent-token>'
export EXECUTOR_DEVICE_TOKEN='<device-token>'
export EXECUTOR_OPERATOR_TOKEN='<operator-token>'
npm run relay
```

By default this binds **127.0.0.1:8788**, not a public interface.
Deploy the TLS reverse proxy on the public server and forward WebSocket
upgrades at `/` to that loopback listener. Preserve `Authorization` and
`X-Executor-Role`, disable access logging of authorization headers, and use
an idle timeout longer than the 15-second heartbeat interval.
Do not expose the plaintext backend to the Internet.
`EXECUTOR_BIND`/`EXECUTOR_PORT` are explicit overrides for controlled deployments.
The relay has no command endpoint, no SDK runtime, no credential for GitHub,
and does not persist prompts/results. It sees their plaintext after TLS
termination; **this is not end-to-end encryption**, so trust the relay operator.

### Private PC B

PowerShell:

```powershell
$env:EXECUTOR_RELAY = 'ws://127.0.0.1:8788'
$env:EXECUTOR_DEVICE_TOKEN = '<device-token>'
$env:EXECUTOR_ROOT = 'C:\work\my-project'
# Optional. No executables are allowed unless explicitly configured.
$env:EXECUTOR_EXECUTABLES = (node -e "console.log(JSON.stringify([process.execPath]))")
npm run device
```

Linux/macOS:

```sh
export EXECUTOR_RELAY='ws://127.0.0.1:8788'
export EXECUTOR_DEVICE_TOKEN='<device-token>'
export EXECUTOR_ROOT="$HOME/work/my-project"
export EXECUTOR_EXECUTABLES="$(node -e 'console.log(JSON.stringify([process.execPath]))')"
npm run device
```

`EXECUTOR_ROOT` must already exist. All tool paths are relative to that root,
using B's native path syntax. `device_info` reports B's platform/root and
canonical allowed executable paths. Add only the executables you intend to
authorize via a JSON array of absolute paths. There is no automatic executable
discovery and no unrestricted shell mode.

By default **every** request, including reads, requires B's owner to type `yes`
at B's terminal. Approval expires after five minutes; missing input denies it.
Keep B running while testing the operator.

For a B that must run unattended, its owner can explicitly set
`EXECUTOR_APPROVAL=operator` before `npm run device`. In PowerShell:
`$env:EXECUTOR_APPROVAL = 'operator'`; in Linux/macOS: `export EXECUTOR_APPROVAL=operator`.
This authorizes the paired A service to carry out **individual operator-approved**
requests. A always requests an explicit target/argument confirmation, and B
requires A's approval marker. This marker is **not an independent cryptographic
signature from the operator**: the configured A service and relay are trusted
authorities and can forge it if compromised. Use terminal mode when B must
independently approve every request. There is no environment setting for
approve-all or permission bypass.

### Private PC A

PowerShell:

```powershell
$env:EXECUTOR_RELAY = 'ws://127.0.0.1:8788'
$env:EXECUTOR_AGENT_TOKEN = '<agent-token>'
$env:EXECUTOR_GITHUB_TOKEN = '<Copilot-supported-GitHub-credential>'
npm start
```

Linux/macOS:

```sh
export EXECUTOR_RELAY='ws://127.0.0.1:8788'
export EXECUTOR_AGENT_TOKEN='<agent-token>'
export EXECUTOR_GITHUB_TOKEN='<Copilot-supported-GitHub-credential>'
npm start
```

A validates authentication before connecting. Copilot data is isolated under
`.executor/agent/copilot`; nothing is copied from the old `.local` ledger or
personal App state. `EXECUTOR_STATE` overrides the parent state directory on
A or B. Use stable, private directories and do not run multiple owners against
the same state; a lock fails closed. SDK dependencies/runtime stay within this
module installation; no global CLI installation or configuration change is needed.

### Operator

PowerShell:

```powershell
$env:EXECUTOR_RELAY = 'ws://127.0.0.1:8788'
$env:EXECUTOR_OPERATOR_TOKEN = '<operator-token>'
npm run connect
```

Linux/macOS:

```sh
export EXECUTOR_RELAY='ws://127.0.0.1:8788'
export EXECUTOR_OPERATOR_TOKEN='<operator-token>'
npm run connect
```

Use `/new`, then enter a prompt, for example:

> Describe B using device_info, then list its project root. Do not write or execute anything.

Use `/approve ID` or `/deny ID` for a displayed permission request, and
`/answer ID text` for a question. The runtime may ask for its own custom-tool
permission in addition to the adapter's explicit target/argument confirmation.
These do **not** grant session-wide or permanent approval. In default terminal
mode B separately confirms the actual request; in explicitly selected operator
mode B relies on the paired A service's report of that one-time approval.

`/list` lists only this executor's sessions; `/resume ID` restores one.
Mutating requests print their ID before dispatch. `/status REQUEST_ID` reads A's
durable admission record without retransmitting the instruction; `accepted`
means SDK admission, **not task completion**. `uncertain` must not be retried
automatically, and a missing record after state loss is not proof of non-execution.
Save the printed session ID, or set `EXECUTOR_SESSION` to attach when starting
the operator. `/abort` aborts A's turn and requests cancellation of active and
queued B work for that session. If B is unreachable, cancellation is **uncertain**;
it cannot recall an already executed operation. `/quit` disconnects the operator
without deleting or stopping A's session.

## Failure and safety semantics

- Transport reconnect is automatic. Prompts, tool invocations and permission
  answers are **never automatically retransmitted**. Connection loss/timeouts
  report uncertainty, not success or confirmed non-execution.
- A persists request IDs before SDK calls; B does the same before executing
  tools. A repeated ID returns the stored result/status; different content with
  the same ID is rejected. Records in flight at a crash remain `uncertain`.
  Do not replace an uncertain request with a fresh ID unless you deliberately
  intend a new operation after inspecting the target.
- Journals are flushed before dispatch. They are not a distributed transaction
  or exactly-once guarantee against filesystem loss/restoring stale backups.
  Preserve A/B state together; never prune/reset ledgers while delayed requests
  could arrive. State and result retention grows with use; automatic pruning is
  intentionally absent.
- A restart requires explicit session resume. `continuePendingWork: false`
  prevents automatic continuation of interrupted tools/permissions; damaged
  transcripts fail rather than silently recovering. Host restart does not replay
  old prompt IDs. Existing live sessions remain attached across relay reconnects.
- The last 1000 live events are replayable per A process. Epoch changes/gaps
  trigger a history snapshot (up to 900 KiB of recent user/assistant events),
  plus current reviews. Older transcript data remains on A; live partial deltas
  and B process output deltas are not guaranteed across an A crash/disconnection.
  The completed B result retains the bounded full stdout/stderr.
- Files are bounded to 512 KiB, listings to 2000 entries, process output to
  512 KiB and runtime to 120 seconds. Processes have no interactive stdin.
  Nonzero exit status is surfaced as a failed tool result, with stdout/stderr.
  Serialized approval details are limited to 400 KiB each / 850 KiB total /
  16 pending requests. Large writes beyond the review budget require a future
  chunked-write adapter; the current write tool overwrites, it does not append.
  Relay messages are limited to 2 MiB; oversized requests fail explicitly.
- File tools reject traversal, absolute target paths, symlink targets/escapes
  and non-regular files. **The root is not an OS sandbox.** The B owner must
  control it against concurrent symlink/path replacement (TOCTOU). Approved
  executables, including Node or a shell you allow explicitly, can access the
  OS user's other files/network and spawn processes. Use a dedicated restricted
  OS account/container for actual isolation.
- Timeout/stop/cancellation kills the current process tree using PID-scoped
  PowerShell on Windows and a process group on Linux/macOS. Daemonized processes
  escaping that group/tree and side effects already performed cannot be undone.
  No broad process-name killing is used.
- Relay role routing prevents operator → B direct execution and B → operator
  direct messages (B progress goes through A). Sender identities are stamped by the relay; duplicate role
  connections are refused. TLS verification stays enabled, browsers with an
  Origin header are refused, and payload/backpressure limits close abusive
  connections. This single-pair module is not a multitenant Internet service.

## Stop and resume

Use Ctrl+C (or SIGTERM on Unix) in A, B and relay terminals. A asks B to cancel
its sessions, then the SDK stops its owned runtime; B cancels pending approval
and active bounded processes. If the relay/B is already offline, cancellation
may be uncertain; stop B locally when necessary. The operator closing does not
stop the servers.

Abrupt termination may leave `STATE/agent/lock` or `STATE/device/lock`.
Inspect its `pid` and confirm the owning process is gone before manually removing
**that specific lock directory**. Never delete the state/ledger to solve a lock.
Restart with the same state/root/token pairing and explicitly `/resume ID`.

## Verification

```console
npm test
npm run test:runtime
```

The regular suite tests serialized persistent deduplication, ownership,
approval/expiration, replay gaps, role authentication/routing, reconnect without
replay, real filesystem tools, path escapes, real subprocess timeout/output/
cancellation, and state locks.

`test:runtime` uses the **actual bundled Copilot runtime**, real custom-tool
RPC dispatch, authenticated loopback relay and B filesystem/process tools.
It verifies create/runtime restart/resume, B-only writes/process output, disabled A `view`/
`powershell`, and operator/device confirmation paths. Test approvals are explicit
test substitutes; production terminal approval is not disabled.
It uses no existing login and makes no model inference calls.

Verified here on **Windows with Node 24.11.1**. A/B/relay are distinct roles on
the same test host, not three deployed PCs. Linux/macOS execution and real
public WSS deployment have **not** been tested on external hosts. Authenticated
model reasoning also remains untested without a supplied Copilot credential.
No public service, network configuration, automation, PR or commit is created.
