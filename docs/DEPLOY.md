# 배포 가이드 (HTTPS + 리버스 프록시)

> 텔레그램 로그인 위젯은 **HTTPS 도메인**에서만 동작합니다 (@BotFather `/setdomain` 등록 필수).
> 이 문서는 단일 VPS/홈서버에 systemd + Caddy(또는 Nginx)로 배포하는 절차입니다.

## 0. 전제 조건

- Node.js **24 이상** 설치
- Telegram 봇 토큰 + 전용 비공개 채널 chat id (`README.md`의 설정 섹션 참고)
- 도메인 (예: `storage.example.com`) → 서버 IP로 DNS A 레코드

## 1. 코드 준비

```bash
git clone <repo-url> /opt/telegram-storage
cd /opt/telegram-storage
npm ci
npm --prefix web ci
# 프로덕션 빌드 (SPA 정적 파일 생성)
npm --prefix web run build
# 백엔드 타입 체크
npm run typecheck
```

## 2. 환경 설정

```bash
cp .env.example .env
# 반드시 설정할 값
#   TELEGRAM_BOT_TOKEN=<봇 토큰>
#   TELEGRAM_BOT_USERNAME=<봇 유저네임>
#   STORAGE_CHAT_ID=<채널 id>
#   SESSION_SECRET=<openssl rand -hex 32 로 생성한 긴 값>
#   DEV_AUTH=false            ← 실전에서 반드시 false
#   COOKIE_SECURE=true        ← HTTPS 뒤에서 세션 쿠키 Secure 플래그
#   RATE_LIMIT_PER_MINUTE=10  ← 로그인 무차별 대입 방지 (0이면 비활성)
#   CACHE_DIR=/var/cache/telegram-storage  ← 선택, 다운로드 캐시
#   CACHE_MAX_MB=1024
#   PORT=3000                 ← 리버스 프록시가 이 포트로 연결
```

`.env` 파일 권한: `chmod 600 .env`

## 3. systemd 서비스

`/etc/systemd/system/telegram-storage.service`:

```ini
[Unit]
Description=telegram-storage API server
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/telegram-storage
ExecStart=/usr/bin/node --import tsx /opt/telegram-storage/src/index.ts
# tsx로 직접 실행 (npm 스크립트를 통하지 않아 시그널이 깨끗하게 전달됨)
EnvironmentFile=/opt/telegram-storage/.env
Restart=on-failure
RestartSec=3

# (선택) 하드닝
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/telegram-storage/data /opt/telegram-storage/tmp /var/cache/telegram-storage

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-storage
journalctl -u telegram-storage -f   # 로그 확인
curl http://127.0.0.1:3000/health   # {"ok":true} 확인
```

> 참고: `npm start`(`tsx src/index.ts`)로도 충분하지만, systemd는
> 로그 수집·자동 재시작·시그널 처리를 제공합니다.

## 4. 리버스 프록시 (HTTPS)

### 옵션 A — Caddy (자동 HTTPS, 권장)

`/etc/caddy/Caddyfile`:

```
storage.example.com {
    reverse_proxy 127.0.0.1:3000
    encode zstd gzip
    # 정적 SPA는 아래 경로를 먼저 매칭 (선택 — API와 같은 도메인에서 서빙할 경우)
}
```

```bash
sudo systemctl reload caddy
```

Caddy가 자동으로 Let's Encrypt 인증서를 발급/갱신합니다.

### 옵션 B — Nginx

`/etc/nginx/sites-available/telegram-storage`:

```nginx
server {
    listen 80;
    server_name storage.example.com;
    # HTTP → HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name storage.example.com;

    ssl_certificate     /etc/letsencrypt/live/storage.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/storage.example.com/privkey.pem;

    # API → 백엔드
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
    }

    location /health {
        proxy_pass http://127.0.0.1:3000;
    }

    # SPA 정적 파일 (선택 — 별도 호스팅 대신 이 서버로 서빙할 경우)
    root /opt/telegram-storage/web/dist;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

인증서: `sudo certbot --nginx -d storage.example.com`

> **중요**: 텔레그램 위젯이 HTTPS 도메인에서 로드되도록 @BotFather에서
> `/setdomain` → `storage.example.com` 을 등록하세요.

## 5. 로그인 위젯 동작 확인

1. 브라우저에서 `https://storage.example.com` 접속
2. 텔레그램 로그인 위젯이 표시되는지 확인 (안 뜨면 `/setdomain` 재확인)
3. 첫 로그인 사용자가 admin으로 부트스트랩됩니다 (`GET /api/auth/me`로 role 확인)

## 6. 보안 체크리스트

- [ ] `DEV_AUTH=false`
- [ ] `SESSION_SECRET` 고정값 (재시작해도 세션 유지)
- [ ] `COOKIE_SECURE=true`
- [ ] `RATE_LIMIT_PER_MINUTE` ≥ 1 (로그인 429 방어)
- [ ] `.env` 권한 600, `.gitignore`에 `.env` 포함
- [ ] HTTPS 인증서 유효 + 자동 갱신 (Caddy 자동 / certbot 타이머)
- [ ] 세션 무효화: 로그아웃 시 `users.sess_version` 증가 → 이전 토큰 즉시 무효
- [ ] (선택) 백업: `data/` 디렉터리 주기적 백업 — Telegram 쪽 바이너리는 채널에 상주하므로
  DB(메타데이터)만 백업하면 계정 접근권한/목록은 복구 가능

## 7. 운영 팁

- **스케일/속도**: 자주 읽는 파일은 `CACHE_DIR` 활성으로 텔레그램 호출 수를 줄이세요.
  (주의: 캐시 활성 시 첫 다운로드는 전체 재조립 후 스트리밍 — 큰 파일은 메모리 사용 증가)
- **큐 간격**: 그룹/채널 저장 시 분당 20회 제한 → `QUEUE_INTERVAL_MS=3000` 이상 권장.
- **DB**: SQLite WAL 모드. 동시 접속이 많아지면 `data/`를 SSD에 두고 주기적 `VACUUM` 고려.
