# telegram-storage

Telegram 기반 무제한 파일 스토리지 — **실제 바이너리는 Telegram 봇에, 메타데이터는 SQLite에** 저장하는 개인 프로젝트(M1~M4).

- **백엔드**: Hono + TypeScript (Node 24)
- **웹 UI (M4)**: Vite + React + TypeScript SPA (`web/`) — 폴더 트리/파일 목록/업로드(진행률)/다운로드/삭제/권한 관리 + 로그인
- **DB**: SQLite (better-sqlite3, WAL)
- **Telegram 클라이언트**: grammY (+ throttler, autoRetry) — **토큰이 없으면 mock 클라이언트로 전체 동작 검증 가능**
- **청크**: 15MB 고정 (Telegram 공개 Bot API: 업로드 50MB / 다운로드 20MB 한도 이내)
- **무결성**: 파트별 sha256 checksum 저장 + 다운로드 시 검증
- **속도제한**: 앱 레벨 큐(직렬 실행 + 최소 간격 + 429 시 `retry_after` 존중 + 지수 백오프)
- **인증 (M3)**: 텔레그램 로그인 위젯 서명 검증 + httpOnly 쿠키 세션 (HMAC 서명)
- **폴더/권한 (M3)**: 폴더 트리 CRUD + 사용자별 read/write/admin 권한 (조상 상속)

> 이번 범위(M1~M4): 파일 업로드/다운로드/목록/논리삭제, 15MB 분할·조립, checksum, mock 검증,
> 사용자 인증(텔레그램 위젯 + dev-login), 폴더 CRUD, 권한 부여/회수/상속,
> 웹 UI (React SPA: 폴더 트리/파일 목록/업로드/다운로드/삭제/권한 관리).

## 아키텍처

```
클라이언트 ──REST──▶ Hono API ──▶ SQLite (users / folders / permissions / files / parts)
                      │
                      └─ 속도제한 큐 ──▶ TgClient (grammY 실전 / mock 로컬 저장)
                                          └─ Telegram 전용 비공개 채널
```

업로드: 요청 본문 → 임시 디스크 스트리밍 → 15MB 분할 → 청크별 `sendDocument` → 전 청크 성공 후 `files`+`parts` 원자 커밋 → 임시 파일 정리 (실패 시 DB 롤백, 부분 전송된 Telegram 메시지는 고아로 남음 — 설계상 허용).
다운로드: `parts`를 `part_index` 순으로 조회 → `getFile` → 파트별 sha256 검증 → 스트리밍 응답.

## 요구사항

- Node.js **24 이상** (권장: 24.x LTS)

## 설치

```bash
npm install
```

## 설정 (.env)

```bash
cp .env.example .env
```

토큰이 **없어도** mock 모드로 전체 동작이 가능합니다. 실전(REAL) 모드만 아래 설정이 필요합니다.

### 1) 봇 생성 (@BotFather)

1. Telegram에서 [@BotFather](https://t.me/BotFather)를 열고 `/newbot` 실행
2. 봇 이름/유저네임 입력 → 발급되는 토큰을 `.env`의 `TELEGRAM_BOT_TOKEN`에 입력

### 2) 전용 비공개 채널 생성 (팀 그룹 금지!)

1. Telegram에서 **새 채널 생성** (유형: Private)
2. 채널명은 저장소 전용으로 (예: "tg-storage")
3. 채널 설정 → **Administrators** → 봇 유저네임 검색 → **Add Administrator**
   (관리자 권한은 기본값으로 충분 — 메시지 게시 권한 포함)

### 3) chat id 확인

`npm run chatid` 헬퍼 사용 (토큰 필요):

```bash
# 공개 유저네임이 있는 경우
npm run chatid -- @mychannel
# 완전 비공개 채널: 채널에 아무 메시지나 게시한 뒤
npm run chatid
```

또는 직접: `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` 후 `channel_post.chat.id` 확인.
채널 id는 보통 `-100...` 형태의 숫자입니다. `.env`의 `STORAGE_CHAT_ID`에 입력.

### 4) 로그인 위젯 도메인 설정 (@BotFather /setdomain)

웹 UI(또는 위젯)가 동작할 도메인을 봇에 등록해야 합니다 (M4에서 사용):

1. @BotFather에서 `/setdomain` 실행
2. 봇 선택
3. 도메인 입력: 실전 배포는 `https://your-domain.com`, **로컬 개발은 `localhost:3000`** (HTTPS 없이 허용되는 유일한 예외)

> 참고: 위젯 콜백(`POST /api/auth/telegram`) 서명 검증은 위젯 자체가 아닌
> **서버가** 수행하므로, curl/스크립트로도 로그인할 수 있습니다 (아래 curl 예시 참고).
> Vite dev 서버(포트 5173)에서 위젯을 쓰려면 `localhost:5173`도 /setdomain에 등록해야 합니다.
> 위젯 없이 개발하려면 `DEV_AUTH=true`로 dev-login 폼을 쓰면 됩니다.

### 5) 실행

```bash
npm run dev        # 개발 모드 (tsx watch)
# 또는
npm start          # 실행
```

시작 로그에 `telegram client: MOCK` 또는 `grammY (real)`이 표시됩니다.

### 인증 설정 요약

| 항목 | 값 | 설명 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | 봇 토큰 | 위젯 콜백 서명 검증 + 파일 저장 |
| `TELEGRAM_BOT_USERNAME` | 봇 유저네임 (예: `my_storage_bot`) | 웹 UI의 텔레그램 로그인 위젯 버튼용 (`GET /api/auth/config`가 노출) |
| `SESSION_SECRET` | 임의의 긴 문자열 | 세션 쿠키 HMAC 서명. 비우면 재시작마다 세션 만료 |
| `DEV_AUTH` | `true`/`false` | `true`면 `POST /api/auth/dev-login`(username → 세션) 허용 — 로컬 개발/테스트 전용, **실전에선 false** |
| @BotFather `/setdomain` | 도메인 | 위젯 동작 도메인 (로컬은 `localhost:3000`) |

## 인증 / 권한 모델 (M3)

### 인증 흐름

- **실전**: 텔레그램 로그인 위젯 → `POST /api/auth/telegram` (폼 필드 + `hash`) → 서버가
  `secret_key = SHA256(봇 토큰)` 으로 `HMAC-SHA256(secret_key, data_check_string)` 을 계산해
  `hash`와 상수시간 비교, `auth_date`가 24시간 이내인지 확인 → 세션 쿠키 발급.
- **개발/테스트**: `DEV_AUTH=true` 시 `POST /api/auth/dev-login` (`{"username":"alice"}`) → 즉시 세션.
  **첫 로그인한 사용자는 자동으로 `admin`** (부트스트랩) — 이후 로그인은 모두 `member`.
- 세션은 httpOnly + SameSite=Lax 쿠키 (`tg_session`, HMAC 서명, 7일).
- 로그아웃(`POST /api/auth/logout`)은 쿠키를 삭제합니다 (stateless 설계 — 재생된 토큰은 만료까지 유효).

### 권한 규칙

- 유효 권한 해석 (폴더): **본인 직접 권한 행(row)** → 없으면 **조상 폴더 체인에서 가장 가까운 권한** 상속 → 없으면 **기본값 `read`** (전체 읽기 기본 허용).
- `role='admin'` 사용자 = 전역 admin. **폴더 소유자 = 항상 admin** (소유자 권한 행 생성/삭제 불가).
- 역할 계층: `read < write < admin`.
- 파일: 루트(folder_id NULL)는 기본 `write` (누구나 루트에 폴더/파일 생성 가능).

| 동작 | 필요 권한 |
|---|---|
| 폴더/파일 보기, 파일 다운로드 | 해당 폴더 `read` |
| 폴더 생성 (부모 지정), 파일 업로드/삭제, 폴더 이름 변경/이동 | 부모/대상 폴더 `write` |
| 루트에 폴더/파일 생성 | 기본 허용 (member `write`) |
| 권한 부여/회수, 폴더 삭제 | 해당 폴더 `admin` |

안전장치: 폴더 소유자 권한 행 불가 / 자기 admin 권한 강등·회수 불가 / 마지막 admin 보호(≥1명 유지).

## API

### 인증

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/api/auth/config` | (public) `{devAuth, botUsername}` — 웹 UI가 로그인 방식을 결정 (M4) |
| `POST` | `/api/auth/telegram` | 로그인 위젯 콜백 (form data: `id, first_name, username, auth_date, hash` 등) → `{user}` + 세션 쿠키 |
| `POST` | `/api/auth/dev-login` | `DEV_AUTH=true` 전용. `{"username","displayName?"}` → `{user}` + 세션 쿠키 |
| `GET` | `/api/auth/me` | 현재 사용자 `{user: {id, username, displayName, role, telegramId, createdAt}}` (인증 필요) |
| `POST` | `/api/auth/logout` | 세션 쿠키 삭제 |

### 폴더 / 권한 (전부 인증 필요)

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/api/folders` | 폴더 트리 `{folders: [...]}` — 각 노드에 `children`, 유효 `role` 포함 (read 이상만) |
| `POST` | `/api/folders` | 생성 `{name, parentId?}` → 201 폴더 객체 (부모는 `write` 필요, 루트는 기본 허용) |
| `PATCH` | `/api/folders/:id` | 수정 `{name?, parentId?}` → 폴더 객체 (이동 시 순환/중복 검사, `write` 필요) |
| `DELETE` | `/api/folders/:id` | 서브트리 삭제 (해당 폴더 `admin`). 내부 파일 논리 삭제 |
| `GET` | `/api/folders/:id/permissions` | 권한 목록 `{permissions: [{id,userId,folderId,role,createdAt}]}` (admin) |
| `POST` | `/api/folders/:id/permissions` | 부여/변경 `{userId, role: read|write|admin}` → 201/200 (admin) |
| `DELETE` | `/api/folders/:id/permissions?userId=` | 회수 → 204 (admin) |

### 파일 (전부 인증 필요)

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/api/files` | multipart(`file`, 선택 `folder_id` 필드) 업로드 → 분할 → Telegram 저장 → 메타데이터 기록. 기본 루트. 대상 폴더 `write` 필요 |
| `GET` | `/api/files?folder_id=` | 파일 목록 (folder_id 생략 시 루트 파일). tg 식별자 미노출 |
| `GET` | `/api/files/:id/download` | 파트 재조립 + checksum 검증 + 스트리밍 (소속 폴더 `read` 필요) |
| `DELETE` | `/api/files/:id` | 논리 삭제 (`deleted_at` 설정, 소속 폴더 `write` 필요) |
| `GET` | `/health` | 헬스 체크 |

응답의 파일 객체: `{id, name, size, mime, folderId, ownerId, createdAt, updatedAt}`.

### curl 예시 (mock/dev 모드)

```bash
# 1) 개발 로그인 → 쿠키 저장
curl -c cookies.txt -X POST http://localhost:3000/api/auth/dev-login \
  -H 'content-type: application/json' -d '{"username":"alice"}'
# → {"user":{"id":"1","username":"alice","role":"admin",...}}

# 2) 폴더 생성
curl -b cookies.txt -X POST http://localhost:3000/api/folders \
  -H 'content-type: application/json' -d '{"name":"team"}'

# 3) 폴더에 업로드 (folder_id 필드)
curl -b cookies.txt -F "folder_id=1" -F "file=@/path/to/big.bin" http://localhost:3000/api/files

# 4) 목록 / 다운로드 / 삭제
curl -b cookies.txt "http://localhost:3000/api/files?folder_id=1"
curl -b cookies.txt -OJ http://localhost:3000/api/files/1/download
curl -b cookies.txt -X DELETE http://localhost:3000/api/files/1

# 5) 권한 부여 (userId는 /api/auth/me 또는 DB에서 확인)
curl -b cookies.txt -X POST http://localhost:3000/api/folders/1/permissions \
  -H 'content-type: application/json' -d '{"userId":"2","role":"write"}'
curl -b cookies.txt -X DELETE "http://localhost:3000/api/folders/1/permissions?userId=2"
```

> 보안: `tg_file_id`, `tg_message_id`, `tg_chat_id`, 그리고 봇 토큰이 포함된 `file_path` URL은
> **어떤 API 응답에도 노출되지 않습니다.** 다운로드는 서버가 Telegram에서 직접 조립해 스트리밍합니다.

## 웹 UI (M4)

`web/` 에 Vite + React + TypeScript SPA가 있습니다 (의존성: react/react-dom만, UI 라이브러리 없음).
Vite dev 서버가 `/api`를 `http://localhost:3000`으로 프록시하므로 브라우저에서 API와 같은 오리진으로 동작하며,
httpOnly 세션 쿠키(`tg_session`)가 자동으로 전달됩니다.

### 실행 (터미널 2개)

```bash
# 터미널 1 — API 서버 (포트 3000)
npm install
DEV_AUTH=true npm run dev        # dev-login 폼 사용 (위젯 없이 바로 로그인)

# 터미널 2 — 웹 dev 서버 (포트 5173)
npm --prefix web install
npm run dev:web                  # == npm --prefix web run dev
```

브라우저에서 `http://localhost:5173` 접속 → dev-login 폼(username 입력) → 폴더 트리/파일 목록/업로드/권한 관리.

- 로그인 화면은 `GET /api/auth/config` 응답으로 결정됩니다: `devAuth=true`면 dev-login 폼, 아니면 `botUsername`의
  텔레그램 로그인 위젯, 둘 다 없으면 안내 메시지.
- 텔레그램 위젯을 쓰려면 봇에 `TELEGRAM_BOT_USERNAME` + @BotFather `/setdomain` 등록이 필요합니다 (로컬 Vite는 `localhost:5173`).
- 401 응답 시 자동으로 로그인 화면으로 돌아갑니다.

빌드: `npm run build:web` (tsc + vite build → `web/dist`). 프리뷰: `npm run preview:web`.

## 테스트 / 검증

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest — 위젯 서명(known vector), 세션, dev-login, 부트스트랩,
                    # 폴더 CRUD/순환/중복, 권한 상속/부여/회수, 업로드 403,
                    # mock 왕복 무결성, checksum, 롤백, 큐 동작
```

스모크 테스트 (토큰 없으면 mock, 있으면 실전; **DEV_AUTH=true 필요**):

```bash
DEV_AUTH=true npm run smoke                       # mock: 32MB 랜덤 파일 왕복 sha256 검증
SMOKE_FILE_SIZE_MB=120 DEV_AUTH=true npm run smoke # 100MB+ 검증 (8개 파트)
```

실전 검증: `.env`에 `TELEGRAM_BOT_TOKEN` + `STORAGE_CHAT_ID` + `DEV_AUTH=true`(스모크용) 를 넣고 `npm run smoke` 실행.

## 프로젝트 구조

```
src/
  index.ts            서버 엔트리 (env → deps 조립 → serve)
  app.ts              Hono 앱 팩토리 (에러/로깅/라우팅/세션시크릿 해석 — 테스트에서 주입)
  config.ts           env 로딩 (.env 자동 로드, CHUNK_SIZE=15MB 고정)
  db.ts               SQLite 스키마 + 마이그레이션(user_version) + 리포지토리
  queue.ts            속도제한 큐 (직렬 + 최소 간격 + 429 retry_after + 지수 백오프)
  multipart.ts        busboy 기반 스트리밍 multipart 파서 (메모리 안전, form 필드 수집)
  upload.ts           업로드 파이프라인 (스풀 → 분할 → 전송 → 원자 커밋)
  download.ts         다운로드 파이프라인 (part_index 정렬 → 검증 → 스트리밍)
  auth/
    telegram.ts       위젯 서명 검증 (순수 함수 — known vector 단위 테스트)
    session.ts        HMAC 서명 세션 토큰 발급/검증
    permissions.ts    유효 권한 해석 (직접 → 조상 상속 → 기본 read) + admin 가드
    middleware.ts     requireAuth Hono 미들웨어
  routes/
    auth.ts           /api/auth/* (config, telegram, dev-login, me, logout)
    folders.ts        /api/folders/* (CRUD + 권한 부여/회수)
    files.ts          /api/files/* (인증 + 폴더 권한 게이트)
  tg/
    types.ts          TgClient 인터페이스
    grammy.ts         grammY 실전 구현 (throttler + autoRetry)
    mock.ts           로컬 파일 mock (토큰 불필요, 실패 주입 지원)
web/                  M4 웹 UI (Vite + React + TS)
  src/
    App.tsx           부트스트랩(config/me 로드, 401 → 로그인 전환)
    api.ts            fetch 래퍼(credentials: 'include') + XHR 업로드(진행률)
    components/       LoginPage, Browser, FolderTree, FileList, PermissionsPanel, Toasts
scripts/
  smoke.ts            왕복 무결성 스모크 (mock/실전)
  chatid.ts           chat id 확인 헬퍼
test/                 vitest 테스트
```

## 알려진 동작 / 주의사항

- 업로드 실패 시 DB에는 아무것도 커밋되지 않지만, **이미 전송된 Telegram 메시지는 고아로 남습니다** (저장소 무제한 전제의 설계상 허용).
- `file_id`는 봇 계정 종속·비영구이므로 parts에 `tg_chat_id` + `tg_message_id` + `tg_file_id`를 모두 저장합니다.
- 텔레그램 약관상 **전용 비공개 채널** 사용을 전제로 합니다 (팀 그룹/공개 채널 금지).
- 세션 쿠키는 Secure 플래그가 없습니다 (로컬 HTTP 개발용). HTTPS 배포 시 리버스 프록시 + 필요시 Secure 옵션 추가 필요.
- 로그아웃은 쿠키 삭제 방식(stateless)이라, 탈취된 토큰은 만료까지 재사용될 수 있습니다 — 실전 배포 시 서버 측 세션 블록리스트 도입을 권장.
- `GET /api/folders`는 read 이상만 노출하지만, member 기본값이 read이므로 실질적으로 모든 폴더가 보입니다 (승인된 설계).
- 웹 UI의 권한 부여 폼은 API 계약상 사용자 **id**(숫자)를 입력받습니다 (사용자 목록 엔드포인트가 없음).
  알려진 사용자 id(폴더 소유자/기존 부여분)는 패널 하단에 칩으로 표시됩니다. 사용자 이름으로 검색하려면 향후 `GET /api/users` 추가 필요.
- 로컬 dev에서 세션 쿠키는 Secure 플래그가 없습니다(HTTP). HTTPS 배포 시 리버스 프록시 + Secure 쿠키 설정 필요.

## 다음 마일스톤 (범위 외)

- M5: 캐시 계층, 동시성 점검
