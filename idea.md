> **Superseded for execution.** `MASTER_PLAN.md` version 1.0.0 is the V1 contract. This file is the original sketch. Where they differ — attendee media, HLS, storage, accounts, chat, Redis writes — the master plan wins.

# StageFlow (V1) — Master Architecture & Agent Execution Plan
**Real-Time WebRTC Stage, Webinar Broadcast & Automated HLS VOD Engine**

---

## 1. System Overview & Architectural Philosophy

**StageFlow** is a full-stack real-time video conferencing, webinar stage, and automated VOD platform built from the ground up without high-level third-party media SDKs (no Agora, Daily, or LiveKit wrappers).

### Core Capabilities (V1 Scope)
1. **Pre-Join Green Room:** Hardware enumeration (camera, microphone, speaker selection), live local video preview, real-time Web Audio microphone level meter, and graceful device permission handling.
2. **Role-Based Room State Machine:** Explicit permission boundaries between **Host** (room creator, moderates stage, controls recording), **Speaker** (on-stage participant with active WebRTC P2P video/audio/screen tracks, max 4 simultaneous on-stage slots), and **Attendee** (view-only participant who can raise their hand and be promoted to Speaker by the Host in real time).
3. **Native WebRTC Mesh Engine (Perfect Negotiation):** Up to 4 concurrent on-stage speakers connected via raw `RTCPeerConnection` mesh, implementing the W3C Perfect Negotiation pattern to eliminate SDP Offer collisions ("glare") and ICE candidate race conditions.
4. **Screen Sharing & Dynamic Layout Engine:** Seamless screen sharing (`getDisplayMedia`) using `RTCRtpSender.replaceTrack` (zero renegotiation overhead), active speaker border highlighting via Web Audio API (`AnalyserNode`), and automatic Spotlight / Grid layout switching.
5. **Solo Recruiter "Demo Bot" Engine:** A one-click simulation mode that spawns up to 3 synthetic peers using offscreen HTML5 Canvas video streams and Web Audio synthesizer tracks piped through real loopback `RTCPeerConnection` instances. This enables any solo user or recruiter to test a 4-way call, stage promotion, and live network telemetry on a single machine without needing a second device.
6. **WebRTC Internals Telemetry HUD:** A toggleable developer drawer that polls `RTCPeerConnection.getStats()` every 1,000ms to compute and render live outbound/inbound bitrate (kbps), round-trip time (RTT ms), jitter, packet loss percentage, frame rate, resolution, and active ICE candidate pair type (`host`, `srflx`, `relay`).
7. **Live Recording -> FFmpeg HLS -> Cloudflare R2 VOD Pipeline:** The Host can record live sessions. Binary WebM media chunks stream to the NestJS backend, where a **BullMQ** worker invokes **FFmpeg** to transcode the recording into a multi-bitrate **HLS bundle (`master.m3u8` with 720p and 360p variants)** plus a thumbnail, uploads all segments to **Cloudflare R2**, and publishes the session to an on-demand replay catalog powered by `hls.js`.

---

## 2. Agent Execution Protocol & Coding Standards

All AI coding agents working on this repository MUST strictly follow these rules:

### 2.1 Plan & Guide Generation Workflow
Implementation is divided into **6 Phases**. Before writing application code for Phase `N`, generate two files:
1. `/plans/phase<N>.md`: High-level phase scope, exact file manifest (files to create/update), data/state contracts, and end-of-phase manual verification steps.
2. `/plans/phase<N>/guide.md`: A **commit-by-commit implementation guide**. Each commit section (`Commit N.1`, `Commit N.2`, etc.) must be a small, atomic, verifiable unit of work containing:
   - **Commit Message:** Conventional commit format (e.g., `feat(signaling): implement redis room state repository`).
   - **Files Touched:** Exact relative file paths.
   - **Implementation Details:** Concrete architecture rules, key code blocks, and edge-case handling.
   - **Verification Step:** Fast command (`pnpm --filter api typecheck`, `pnpm test`, `curl`, or browser verification) to confirm the commit compiles cleanly before moving to the next commit.

### 2.2 Engineering & Code Quality Rules
- **Strict TypeScript:** `strict: true` across all packages. **Zero `any` types.** Shared DTOs, WebSocket event maps, and domain enums must reside in `@stageflow/shared` so frontend and backend remain strictly synchronized.
- **Explicit Hardware & Memory Cleanup:** Every `MediaStreamTrack`, `RTCPeerConnection`, `AudioContext`, `MediaRecorder`, `setInterval`, and `requestAnimationFrame` loop MUST have deterministic cleanup on component unmount, peer disconnect, or room leave. Leaving a user's webcam hardware indicator light active after leaving a room is a critical bug.
- **Domain-Driven Modular Boundaries:** Keep NestJS Gateways and Controllers thin. Business rules and state transitions belong in domain services; Redis and PostgreSQL persistence belong in repositories.
- **Pragmatic Testing Policy (No Test Bloat):**
  - **DO NOT** write unit tests for boilerplate React UI components, NestJS controllers, or TypeORM entities.
  - **DO** run `pnpm -r typecheck` and `pnpm -r lint` at the end of every commit.
  - **DO** write targeted unit tests (`vitest` / `jest`) ONLY for pure algorithmic logic:
    1. Perfect Negotiation polite/impolite role resolution and collision state handling.
    2. Redis room stage slot allocation (max 4 speakers) and hand-raise promotion rules.
    3. `getStats()` delta bitrate and packet-loss percentage calculations.
    4. FFmpeg command argument builder for multi-bitrate HLS transcoding.

---

## 3. Tech Stack & Monorepo Structure

- **Workspace Manager:** `pnpm` workspaces
- **Frontend (`/apps/web`):** React 19, TypeScript, Vite, Tailwind CSS, Zustand, TanStack Query v5, React Router v7 (or TanStack Router), Socket.IO Client, `hls.js`, Lucide React.
- **Backend (`/apps/api`):** NestJS 11, TypeScript, Socket.IO (`@nestjs/websockets`), TypeORM, PostgreSQL (`pg`), Redis (`ioredis`), BullMQ (`@nestjs/bullmq`), `@aws-sdk/client-s3` (Cloudflare R2), native `child_process.spawn('ffmpeg')`.
- **Shared Package (`/packages/shared`):** Pure TypeScript interfaces, WebSocket event contracts, room state enums, and DTO types.

```text
stageflow/
├── MASTER_PLAN.md
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── docker-compose.yml               # Local Postgres 16 + Redis 7 + API container
├── .env.example
├── plans/
│   ├── phase1.md
│   ├── phase1/
│   │   └── guide.md
│   ├── phase2.md
│   ├── phase2/
│   │   └── guide.md
│   └── ... (phase3 through phase6)
├── packages/
│   └── shared/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── enums.ts             # RoomMode, RoomStatus, ParticipantRole, VodStatus
│           ├── signaling.types.ts   # Typed Socket.IO ClientToServer & ServerToClient events
│           ├── telemetry.types.ts   # WebRTC getStats() parsed structures
│           └── dto.types.ts         # REST API request/response contracts
├── apps/
│   ├── api/
│   │   ├── Dockerfile               # Node 22 Alpine + ffmpeg binary installed
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── main.ts
│   │       ├── app.module.ts
│   │       ├── config/
│   │       │   └── env.validation.ts
│   │       ├── modules/
│   │       │   ├── auth/            # JWT auth + 1-click Guest/Recruiter session issue
│   │       │   ├── rooms/           # Postgres CRUD + RedisRoomRepository
│   │       │   ├── signaling/       # Socket.IO Gateway, Perfect Negotiation relay, Stage moderation
│   │       │   ├── recording/       # Binary WebM chunk ingestion + file assembler
│   │       │   └── vod/             # BullMQ FFmpeg HLS worker + Cloudflare R2 S3 uploader
│   └── web/
│       ├── Dockerfile
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── api/                 # Fetch wrapper & TanStack Query hooks
│           ├── stores/
│           │   ├── useAuthStore.ts
│           │   ├── useMediaStore.ts # Local tracks, selected device IDs, mute states
│           │   └── useRoomStore.ts  # Participants, stage slots, hand-raise queue, telemetry
│           ├── services/
│           │   ├── signalingClient.ts     # Typed Socket.IO singleton
│           │   ├── webrtcPeerManager.ts   # RTCPeerConnection map, Perfect Negotiation, ICE queue
│           │   ├── statsCollector.ts      # Polls getStats() -> computes bitrate/loss/RTT
│           │   ├── syntheticBotEngine.ts  # Offscreen Canvas + Web Audio loopback peer generator
│           │   └── stageRecorder.ts       # Canvas + AudioContext compositor & MediaRecorder streamer
│           ├── components/
│           │   ├── lobby/           # Pre-join hardware selector & mic level bar
│           │   ├── stage/           # VideoGrid, VideoTile, ScreenShareSpotlight, ControlsBar
│           │   ├── sidebar/         # ParticipantList, HandRaiseQueue, ChatPanel
│           │   ├── telemetry/       # WebRTC Internals live HUD drawer
│           │   └── vod/             # Adaptive HLS player (hls.js) & quality selector
│           └── pages/
│               ├── DashboardPage.tsx
│               ├── RoomPage.tsx
│               └── VodWatchPage.tsx
```

---

## 4. Data Models & Contracts

### 4.1 PostgreSQL Schema (TypeORM Entities)

```typescript
// 1. User Entity (Supports both registered accounts and 1-click Guest/Recruiter sessions)
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 80 })
  displayName: string;

  @Column({ type: 'varchar', unique: true, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  passwordHash: string | null;

  @Column({ default: false })
  isGuest: boolean;

  @CreateDateColumn()
  createdAt: Date;
}

// 2. Room Entity
export enum RoomMode {
  MEETING = 'MEETING', // Up to 4 peers join directly as SPEAKER
  WEBINAR = 'WEBINAR', // Host joins as HOST; others join as ATTENDEE and can be promoted
}

export enum RoomStatus {
  SCHEDULED = 'SCHEDULED',
  LIVE = 'LIVE',
  ENDED = 'ENDED',
}

@Entity('rooms')
export class Room {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, length: 24 })
  slug: string; // e.g., "system-design-townhall"

  @Column({ length: 120 })
  title: string;

  @Column({ type: 'enum', enum: RoomMode, default: RoomMode.WEBINAR })
  mode: RoomMode;

  @Column({ type: 'enum', enum: RoomStatus, default: RoomStatus.SCHEDULED })
  status: RoomStatus;

  @Column('uuid')
  hostId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'hostId' })
  host: User;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt: Date | null;
}

// 3. VodRecording Entity
export enum VodStatus {
  RECORDING = 'RECORDING',
  QUEUED = 'QUEUED',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
}

@Entity('vod_recordings')
export class VodRecording {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  roomId: string;

  @ManyToOne(() => Room)
  @JoinColumn({ name: 'roomId' })
  room: Room;

  @Column({ type: 'enum', enum: VodStatus, default: VodStatus.RECORDING })
  status: VodStatus;

  @Column({ type: 'varchar', nullable: true })
  masterPlaylistUrl: string | null; // Public R2 URL to master.m3u8

  @Column({ type: 'varchar', nullable: true })
  thumbnailUrl: string | null;

  @Column({ type: 'int', default: 0 })
  durationSeconds: number;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
```

### 4.2 Redis Ephemeral Room State Schema

Live room state is stored in Redis with a 24-hour TTL (`EXPIRE 86400`) so WebSocket disconnects, reconnections, and stage promotions are atomic:

- `room:{roomId}:participants` -> **Redis Hash** (`socketId -> JSON(ParticipantState)`)
- `room:{roomId}:stage` -> **Redis Set** of `socketId`s currently on stage (enforced max cardinality = `4`)
- `room:{roomId}:hands` -> **Redis Sorted Set (`ZSET`)** (`socketId` scored by Unix timestamp ms of hand raise)
- `room:{roomId}:recording` -> **Redis String** storing active `recordingId` if recording is in progress

```typescript
// packages/shared/src/signaling.types.ts
export enum ParticipantRole {
  HOST = 'HOST',
  SPEAKER = 'SPEAKER',
  ATTENDEE = 'ATTENDEE',
}

export interface ParticipantState {
  socketId: string;
  userId: string;
  displayName: string;
  role: ParticipantRole;
  isAudioMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing: boolean;
  isHandRaised: boolean;
  isSyntheticBot: boolean;
  joinedAt: number;
}
```

### 4.3 WebSocket Signaling Contract (`@stageflow/shared`)

```typescript
export interface ServerToClientEvents {
  'room:state-sync': (payload: {
    roomId: string;
    participants: ParticipantState[];
    stageSocketIds: string[];
    activeRecordingId: string | null;
  }) => void;
  'participant:joined': (participant: ParticipantState) => void;
  'participant:updated': (participant: ParticipantState) => void;
  'participant:left': (payload: { socketId: string; userId: string }) => void;

  // WebRTC Perfect Negotiation Signaling
  'webrtc:description': (payload: {
    fromSocketId: string;
    description: RTCSessionDescriptionInit;
  }) => void;
  'webrtc:ice-candidate': (payload: {
    fromSocketId: string;
    candidate: RTCIceCandidateInit;
  }) => void;

  // Stage Moderation
  'stage:role-changed': (payload: {
    targetSocketId: string;
    newRole: ParticipantRole;
    stageSocketIds: string[];
  }) => void;
  'stage:force-mute': (payload: { kind: 'audio' | 'video' }) => void;

  // Live Chat & Recording Status
  'chat:message': (msg: {
    id: string;
    senderName: string;
    senderRole: ParticipantRole;
    text: string;
    timestamp: number;
  }) => void;
  'recording:status': (payload: {
    isRecording: boolean;
    recordingId: string | null;
  }) => void;
}

export interface ClientToServerEvents {
  'room:join': (
    payload: {
      roomId: string;
      isAudioMuted: boolean;
      isVideoOff: boolean;
      isSyntheticBot?: boolean;
      botDisplayName?: string;
    },
    ack: (res: {
      ok: boolean;
      error?: string;
      selfSocketId?: string;
      iceServers?: RTCIceServer[];
    }) => void
  ) => void;
  'room:leave': () => void;

  // Media Track State Updates
  'media:toggle': (payload: {
    isAudioMuted?: boolean;
    isVideoOff?: boolean;
    isScreenSharing?: boolean;
  }) => void;

  // WebRTC Signaling Relay
  'webrtc:description': (payload: {
    toSocketId: string;
    description: RTCSessionDescriptionInit;
  }) => void;
  'webrtc:ice-candidate': (payload: {
    toSocketId: string;
    candidate: RTCIceCandidateInit;
  }) => void;

  // Webinar Hand-Raise & Host Stage Moderation
  'stage:raise-hand': (payload: { raised: boolean }) => void;
  'stage:promote': (payload: { targetSocketId: string }) => void;
  'stage:demote': (payload: { targetSocketId: string }) => void;
  'stage:mute-peer': (payload: { targetSocketId: string; kind: 'audio' | 'video' }) => void;

  // Chat
  'chat:send': (payload: { text: string }) => void;
}
```

---

## 5. Core Technical Specifications (The "Hard Parts")

### 5.1 WebRTC Mesh & The W3C "Perfect Negotiation" Pattern
Naive WebRTC code breaks when two peers send an SDP Offer at the same time ("glare") or when an ICE candidate arrives before `setRemoteDescription` completes. `webrtcPeerManager.ts` MUST implement:

1. **Deterministic Polite / Impolite Role Assignment:**
   Compare socket IDs lexically: `const isPolite = selfSocketId < remoteSocketId;`.
2. **Glare / Offer Collision Resolution:**
   ```typescript
   const offerCollision =
     description.type === 'offer' &&
     (peer.makingOffer || peer.pc.signalingState !== 'stable');

   peer.ignoreOffer = !peer.isPolite && offerCollision;
   if (peer.ignoreOffer) {
     return; // Impolite peer ignores colliding offer; polite peer rolls back
   }
   ```
3. **ICE Candidate Queueing Buffer:**
   If a `webrtc:ice-candidate` event arrives while `peer.pc.remoteDescription === null`, push the candidate into `peer.pendingCandidates[]`. Flush all queued candidates immediately after `await peer.pc.setRemoteDescription(description)` resolves.
4. **Screen Sharing via `RTCRtpSender.replaceTrack`:**
   When a stage speaker starts screen sharing, call `videoSender.replaceTrack(screenVideoTrack)` on every active peer connection and emit `media:toggle({ isScreenSharing: true })`. When `screenVideoTrack.onended` fires, automatically revert back via `videoSender.replaceTrack(cameraVideoTrack)`.
5. **View-Only Attendee Mesh Topology:**
   - On-stage speakers (`HOST` and `SPEAKER`, max 4) establish full bidirectional audio/video transceivers (`sendrecv`) with all other stage speakers and send-only transceivers to attendees (up to room capacity).
   - When an `ATTENDEE` is promoted to `SPEAKER` via `stage:role-changed`, the promoted client attaches its local camera/mic tracks to its peer connections, triggering `onnegotiationneeded` seamlessly.

### 5.2 Solo Recruiter "Demo Bot" Engine (`syntheticBotEngine.ts`)
To guarantee that any recruiter or engineer inspecting the live deployment can test a multi-speaker webinar, active speaker detection, stage promotion, and live WebRTC telemetry completely solo:

1. Clicking **"Spawn Demo Peer"** in the room toolbar creates an offscreen `<canvas width="640" height="360">`.
2. A `requestAnimationFrame` loop renders a clean dark-themed synthetic camera feed displaying the Bot's name (e.g., `"Alex Rivera (Demo Peer)"`), role badge, animated equalizer bars, and a live frame counter.
3. A Web Audio API `OscillatorNode` + `GainNode` generates a soft harmonic pulse every 4 seconds so the active-speaker audio detector highlights the bot naturally.
4. `canvas.captureStream(24)` and the Web Audio track are combined into a native `MediaStream`.
5. The engine opens an independent secondary Socket.IO connection (`isSyntheticBot: true`) and creates real `RTCPeerConnection` instances that negotiate with the host's primary `RTCPeerConnection` over local WebRTC loopback—producing real RTP packet flow, real jitter/bitrate curves in `getStats()`, and real Redis stage entries.

### 5.3 Live Recording -> FFmpeg Multi-Bitrate HLS Pipeline
1. **Stage Compositor (`stageRecorder.ts`):** When the Host clicks **Start Recording**, an offscreen `<canvas width="1280" height="720">` draws up to 4 active stage `<video>` elements in a clean $2 \times 2$ or spotlight layout at 24fps, while an `AudioContext` mixes local and remote stage audio tracks into a single `MediaStreamAudioDestinationNode`.
2. **Binary Chunk Ingestion:** `MediaRecorder` (`video/webm;codecs=vp8,opus`, `videoBitsPerSecond: 2_500_000`) fires `ondataavailable` every `3000ms`. Each binary chunk is uploaded via `POST /api/recordings/:recordingId/chunks` and appended sequentially to `/tmp/stageflow-recordings/{recordingId}.webm`.
3. **BullMQ FFmpeg Worker (`vod.processor.ts`):** When the Host stops recording, `POST /api/recordings/:recordingId/finalize` enqueues a BullMQ job that spawns `ffmpeg` to generate:
   - `720p/index.m3u8` + `720p/seg_%03d.ts` (`1280x720`, `2500k` H.264, `128k` AAC, `-hls_time 4`)
   - `360p/index.m3u8` + `360p/seg_%03d.ts` (`640x360`, `800k` H.264, `96k` AAC, `-hls_time 4`)
   - `master.m3u8` referencing both stream variants (`BANDWIDTH=2628000` and `BANDWIDTH=896000`)
   - `thumbnail.jpg` captured at `00:00:01.500`
4. **Cloudflare R2 Upload:** All generated `.m3u8`, `.ts`, and `.jpg` files are uploaded to Cloudflare R2 (`@aws-sdk/client-s3`) under `vod/{recordingId}/`, Postgres `VodRecording` is updated to `READY` with the public `masterPlaylistUrl`, and temporary local files are unlinked.

---

## 6. Phased Implementation Roadmap & Commit Index

Each phase below corresponds to `/plans/phase<N>.md` and `/plans/phase<N>/guide.md`.

### Phase 1: Monorepo Foundation, Shared Contracts, Auth & Room CRUD
- **Plan Files:** `/plans/phase1.md` and `/plans/phase1/guide.md`
- **Commits:**
  - `Commit 1.1` — `chore(workspace): initialize pnpm monorepo, docker-compose (postgres + redis), and base tsconfig`
  - `Commit 1.2` — `feat(shared): define domain enums, REST DTOs, and strict Socket.IO signaling contracts`
  - `Commit 1.3` — `feat(api-auth): implement NestJS TypeORM setup, User entity, JWT auth, and 1-click Guest session endpoint`
  - `Commit 1.4` — `feat(api-rooms): implement Room entity, unique slug generator, and room CRUD endpoints`
  - `Commit 1.5` — `feat(web-shell): scaffold Vite React 19 app, Tailwind dark theme, Auth store, and Dashboard room creation UI`

### Phase 2: Redis Room State Machine, Signaling Gateway & Pre-Join Green Room
- **Plan Files:** `/plans/phase2.md` and `/plans/phase2/guide.md`
- **Commits:**
  - `Commit 2.1` — `feat(api-redis): implement RedisRoomRepository for atomic participant state, 4-slot stage set, and hand-raise ZSET with unit tests`
  - `Commit 2.2` — `feat(api-signaling): build Socket.IO SignalingGateway with JWT handshake guard, join/leave lifecycle, and STUN/TURN config provider`
  - `Commit 2.3` — `feat(api-moderation): implement webinar role transitions (raise hand, promote to speaker, demote to attendee, force mute)`
  - `Commit 2.4` — `feat(web-lobby): build Pre-Join Green Room with camera/mic hardware selector, live audio level meter, and Zustand media store`
  - `Commit 2.5` — `feat(web-room-state): wire Socket.IO client singleton, room state synchronization store, and live participant/hand-raise sidebar`

### Phase 3: Native WebRTC Mesh Engine, Perfect Negotiation & Stage UI
- **Plan Files:** `/plans/phase3.md` and `/plans/phase3/guide.md`
- **Commits:**
  - `Commit 3.1` — `feat(webrtc): implement WebRtcPeerManager with W3C Perfect Negotiation, glare resolution, ICE candidate queue, and unit tests`
  - `Commit 3.2` — `feat(web-stage): build responsive Stage VideoGrid, VideoTile with deterministic srcObject cleanup, and Attendee view-only bar`
  - `Commit 3.3` — `feat(web-audio): add Web Audio API AnalyserNode voice activity detector for active speaker border highlighting`
  - `Commit 3.4` — `feat(webrtc-screenshare): implement screen sharing via RTCRtpSender.replaceTrack and Spotlight presentation layout`
  - `Commit 3.5` — `feat(web-controls): wire Host stage moderation actions (1-click promote attendee to live WebRTC stage, remote mute, end room)`

### Phase 4: WebRTC Internals Telemetry HUD & Solo Recruiter "Demo Bot" Engine
- **Plan Files:** `/plans/phase4.md` and `/plans/phase4/guide.md`
- **Commits:**
  - `Commit 4.1` — `feat(telemetry): build RTCPeerConnection.getStats() polling service with delta bitrate, packet loss, jitter, and RTT calculation + unit tests`
  - `Commit 4.2` — `feat(web-hud): create toggleable WebRTC Internals Telemetry Drawer displaying per-peer metrics and active ICE candidate pair types`
  - `Commit 4.3` — `feat(demo-bots): implement SyntheticBotEngine using offscreen Canvas 24fps stream and Web Audio harmonic pulse generator`
  - `Commit 4.4` — `feat(demo-orchestrator): add 1-click "Spawn Demo Peer" toolbar action with full loopback WebRTC negotiation and simulated hand-raising`

### Phase 5: Live Stage Recording, BullMQ Worker & FFmpeg HLS Pipeline
- **Plan Files:** `/plans/phase5.md` and `/plans/phase5/guide.md`
- **Commits:**
  - `Commit 5.1` — `feat(api-recording): create VodRecording entity, RecordingController binary chunk append endpoint, and Redis recording state lock`
  - `Commit 5.2` — `feat(web-recorder): build StageRecorder service compositing active stage video tiles onto 720p Canvas + mixed AudioContext stream`
  - `Commit 5.3` — `feat(api-ffmpeg): implement BullMQ VodProcessor worker spawning FFmpeg for multi-bitrate HLS (720p/360p + master.m3u8 + thumbnail) + unit tests`
  - `Commit 5.4` — `feat(api-r2): implement R2StorageService using @aws-sdk/client-s3 for concurrent HLS segment uploads and temp file cleanup`

### Phase 6: Adaptive HLS VOD Player, Replay Catalog & Production Docker Polish
- **Plan Files:** `/plans/phase6.md` and `/plans/phase6/guide.md`
- **Commits:**
  - `Commit 6.1` — `feat(web-vod-player): build custom HlsVideoPlayer component using hls.js with manual resolution switcher (Auto / 720p / 360p) and buffer indicators`
  - `Commit 6.2` — `feat(web-vod-catalog): create VOD Library tab on Dashboard and VodWatchPage displaying processing status badges and session metadata`
  - `Commit 6.3` — `chore(docker): finalize production multi-stage Dockerfile for API (Node 22 Alpine + FFmpeg), healthcheck endpoint, and README architecture docs`

---

## 7. Templates for Generating Phase Plans & Guides

When prompted to generate **Phase `N`**, the AI agent MUST create `/plans/phase<N>.md` and `/plans/phase<N>/guide.md` following these templates:

### 7.1 Template for `/plans/phase<N>.md`
```markdown
# Phase <N>: <Phase Title>

## 1. Objective
<2-3 sentences summarizing what system capability becomes operational at the end of this phase.>

## 2. File Manifest
### Create
- `path/to/file.ts` — <1-line responsibility>
### Modify
- `path/to/existing.ts` — <1-line modification summary>

## 3. Architectural Invariants & Edge Cases
- <Bullet list of strict rules for this phase, e.g., cleanup rules, Redis key TTLs, race condition guards>

## 4. End-of-Phase Verification Checklist
- [ ] `pnpm -r typecheck` passes with 0 errors
- [ ] <Specific manual or automated functional check>
```

### 7.2 Template for `/plans/phase<N>/guide.md`
```markdown
# Phase <N> Implementation Guide (Commit-by-Commit)

---

## Commit <N>.1: `<type>(<scope>): <commit message>`

### Files Touched
- `path/to/fileA.ts` (Create)
- `path/to/fileB.ts` (Modify)

### Implementation Steps
1. <Step-by-step instructions and complete code blocks for the files>

### Verification
Run:
```bash
pnpm --filter <package> typecheck
```
Expected outcome: <Exact expected behavior>
```

---

## 8. Environment Variables & $0 Deployment Blueprint

### `.env.example` (Backend `/apps/api`)
```ini
PORT=4000
NODE_ENV=development
JWT_SECRET=super-secret-dev-jwt-key-change-in-prod
CORS_ORIGIN=http://localhost:5173

# PostgreSQL (Local Docker or Neon Free Tier)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stageflow

# Redis (Local Docker or Upstash Free Tier)
REDIS_URL=redis://localhost:6379

# WebRTC STUN / TURN (Google Free STUN + Cloudflare / Metered Free TURN)
STUN_URL=stun:stun.l.google.com:19302
TURN_URL=
TURN_USERNAME=
TURN_CREDENTIAL=

# Cloudflare R2 Object Storage (10GB Free Tier, $0 Egress)
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key
R2_SECRET_ACCESS_KEY=your_r2_secret_key
R2_BUCKET_NAME=stageflow-vod
R2_PUBLIC_BASE_URL=https://pub-xxxxxxxx.r2.dev
```

### `.env.example` (Frontend `/apps/web`)
```ini
VITE_API_BASE_URL=http://localhost:4000/api
VITE_WS_URL=http://localhost:4000
```