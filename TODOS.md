# TODOS.md — 남은 할 일

> 진행 현황: M1+M2(분할 저장) · M3(인증/폴더/권한) · M4(웹 UI) 완료.
> 최근 추가: i18n(ko/en/ja) + 설정 모달(⚙️ 톱니바퀴) + Taskfile.yaml.

---

## 🔴 지금 바로 (미커밋 정리)

- [ ] **커밋 정리**: i18n + 설정 모달(`web/src/i18n.tsx`, `SettingsModal.tsx` 등 web/* 수정분)과 `Taskfile.yaml` 커밋
  - 참고: 그 이전에 미커밋이던 브레드크럼 기능(Browser/FileList/styles.css)도 함께 있음 — 한 번에 정리 권장

## 🟠 M5 — 폴리싱 & 실전 검증

- [ ] **실전(REAL) 스모크 검증**: `.env`에 `TELEGRAM_BOT_TOKEN` + `STORAGE_CHAT_ID` + `DEV_AUTH=true` 넣고 `npm run smoke` → 실제 봇/채널로 왕복 무결성 확인 (README 244줄 참고)
- [ ] **실제 팀원 로그인 테스트**: 텔레그램 로그인 위젯 → @BotFather `/setdomain` 등록 + HTTPS 도메인에서 동작 확인 (첫 로그인 admin bootstrap, 멤버 권한 부여 플로우)
- [ ] **동시성 점검** (20명 가정): 업로드 동시 발생 시 큐 동작, 동일 파일 덮어쓰기/삭제 중 다운로드, 권한 변경 중 접근 race 확인
- [ ] **에러 핸들링/로깅 개선**: 요청 로그, 다운로드 스트리밍 실패 복구, 토스트 오류 메시지 일관성

## 🟡 보안 하드닝 (README 287~292줄 언급 사항)

- [ ] **HTTPS 배포 + Secure 쿠키**: 리버스 프록시(Caddy/Nginx) 도입, 세션 쿠키 `Secure` 플래그
- [ ] **서버 측 세션 무효화**: 현재 로그아웃이 stateless(쿠키 삭제) → 탈취 토큰 재사용 방지용 블록리스트/DB 세션 도입
- [ ] **로그인 rate limit**: 텔레그램/로그인 엔드포인트 무차별 대입 방지
- [ ] 배포 시 `DEV_AUTH=false` + `SESSION_SECRET` 고정값 필수 확인

## 🟢 기능 개선 (M4 웹 UI 후속)

- [ ] **파일 검색** (plan.md 아키텍처에 명시된 "검색 UI" — 이름 기준, 폴더 범위 지정)
- [ ] **파일 이동/복사**: 폴더 간 이동(드래그 또는 메뉴), 권한 상속 고려
- [ ] **다중 파일 업로드 / 드래그 앤 드롭**: 현재 단일 파일 + 진행률만 지원
- [ ] **업로드 큐 UX**: 큰 파일 여러 개 연속 업로드 시 진행률/취소/재개
- [ ] **다운로드 캐시 계층** (선택, plan.md): 자주 읽는 파일 로컬 디스크 캐시 → 텔레그램 N회 호출 지연 개선
- [ ] **스토리지 사용량 표시**: 사용자/폴더별 용량 (files.size 합산)

## 🔵 문서/유지보수

- [ ] README에 **i18n(ko/en/ja) + 설정 기능** 문서화
- [ ] 배포 가이드 작성 (HTTPS + 리버스 프록시 + systemd/Docker 등)
- [ ] `docs/plan.md`의 "다음 액션" 체크리스트 최신화

---

## 참고: 완료된 것

- ✅ M1+M2: 15MB 청크 업로드/다운로드, sha256 checksum, 속도제한 큐, mock 클라이언트 검증 (54 tests)
- ✅ M3: 텔레그램 로그인 위젯 검증, httpOnly 세션 쿠키, 사용자/폴더 CRUD, 권한 부여/회수/상속
- ✅ M4: React SPA — 폴더 트리/파일 목록/업로드 진행률/다운로드/삭제/권한 관리/로그인
- ✅ i18n: ko/en/ja 3개 언어, localStorage 영속화, 로그인 페이지 포함 전체 적용
- ✅ 설정: topbar 우상단 ⚙️ → 설정 모달(언어 선택), ESC/배경 클릭 닫기
- ✅ Taskfile.yaml: dev/stop/build/test/typecheck 등 명령어 정리
