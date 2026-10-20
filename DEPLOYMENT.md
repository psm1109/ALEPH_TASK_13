# Vercel 서버리스 배포 — 처음부터 순서대로

이 프로젝트는 **정적 화면 + Vercel Function + Upstash Redis** 구조입니다. 방 코드는 6자리 숫자이며 Redis에서 빈 방을 자동 만료시킵니다. SQL 테이블 생성, 별도 음악 스트리밍 서버, Cron 예약은 필요 없습니다. 음악은 사용자의 브라우저에 보이는 공식 YouTube 플레이어에서 재생합니다.

## 1. 필요한 계정 준비

Vercel 계정과 Upstash 계정이 필요합니다. 곡 제목 검색까지 사용하려면 Google 계정과 YouTube Data API v3 키도 필요합니다. 키가 없어도 유튜브 링크 신청·투표·재생은 사용할 수 있습니다.

- [Vercel](https://vercel.com/)
- [Upstash Console](https://console.upstash.com/)
- [Google Cloud Console](https://console.cloud.google.com/)

이 과제는 Upstash와 Vercel 모두 무료 플랜으로 사용합니다. 생성 화면에서 Free를 선택하고 유료 플랜·자동 업그레이드를 활성화하지 마세요. 음악 API 한도와 별개로 상태 조회·접속 확인에도 함수와 DB 요청이 발생하므로 무료 사용량은 각 대시보드에서 확인합니다.

## 2. Upstash에서 Redis 데이터베이스 생성

Upstash Console에서 Redis를 선택하고 Create Database로 DB를 만듭니다. 이름은 예를 들어 `sai-music`으로 정합니다. 제공되는 플랜 중 사용 목적에 맞는 것을 선택하고, DB와 Vercel 함수의 리전이 가까우면 응답 시간이 줄어듭니다. 첫 테스트에는 기존 기본 리전도 사용할 수 있습니다.

DB 상세의 REST 연결 정보에서 아래 값을 복사합니다.

| 항목 | 복사할 값 |
|---|---|
| REST URL | `https://…upstash.io` 형태의 HTTPS 주소 |
| REST Token | 읽기·쓰기가 가능한 일반 토큰 |

`redis://…` 접속 문자열이나 Read-Only Token은 이 앱에 맞지 않습니다. 방 생성·투표·삭제에 쓰기 권한이 필요합니다. 토큰은 공개 코드·채팅·브라우저 코드에 넣지 마세요.

이 DB는 캐시뿐 아니라 방의 원본 상태를 저장합니다. 메모리 부족 시 임의로 키를 제거하는 Eviction 옵션이 있다면 끈 상태를 유지하세요. 앱이 설정하는 90초 TTL 만료는 별도로 정상 작동합니다.

공식 문서: [REST 연결 정보](https://upstash.com/docs/redis/features/restapi), [Eviction](https://upstash.com/docs/redis/features/eviction).

## 3. 선택: 유튜브 검색 API 키 준비

이미 발급받은 키가 있으면 그대로 사용합니다. 아직 없다면 Google Cloud에서 프로젝트 생성 → API 및 서비스 → 라이브러리 → YouTube Data API v3 사용 → 사용자 인증 정보 → API 키를 만듭니다.

키의 API 제한은 YouTube Data API v3로 지정합니다. 이 앱의 검색은 서버에서 실행하므로 웹사이트용 HTTP 리퍼러 제한과 맞지 않습니다. 서버 IP 제한을 적용하려면 별도로 고정 송신 IP를 마련해야 하므로 기본 Vercel 배포에 임의의 로컬 IP를 입력하지 마세요. 일반 과제용 설정에서는 API 종류 제한을 적용하고 키를 서버 환경변수에 보관합니다.

공식 문서: [발급 절차](https://developers.google.com/youtube/registering_an_application).

## 4. 로컬 파일 확인

프로젝트 폴더 `C:\aleph_task\ALEPH_TASK_13`에서 실행합니다.

```powershell
npm test
npm run build
```

별도 npm 패키지 설치가 필요하지 않는 코드입니다. Node.js는 22.9 이상이 필요하며 배포용 버전은 22.x로 고정했습니다. `dist` 폴더에는 화면과 재생 위치 계산 모듈이 들어갑니다. API 소스는 프로젝트의 `api/index.js`가 별도로 배포됩니다.

기존 `.env`는 그대로 보관하세요. 로컬 `.env`는 Vercel로 업로드하지 않으므로 대시보드에서 값을 다시 등록해야 합니다.

## 5. Vercel 프로젝트 연결 — Git에 올리지 않는 방법

터미널에서 다음을 순서대로 실행합니다. 최초 실행 시 Vercel CLI 패키지 다운로드 확인이 나타날 수 있습니다.

```powershell
npx vercel@latest login
npx vercel@latest link
```

로그인 후 사용할 계정·팀을 선택합니다. 기존 프로젝트가 있으면 그 프로젝트에 연결하고, 새 프로젝트면 원하는 이름으로 만듭니다. 작업 디렉터리는 현재 프로젝트 폴더 `.` 입니다.

이 절차는 Git 커밋·푸시 없이 로컬 소스를 Vercel에 배포하기 위한 준비입니다. GitHub 연동을 선호하면 본인이 변경 파일을 저장소에 반영한 후 Vercel에서 Import할 수도 있습니다. 현재 로컬 변경을 Git에 반영하지 않은 채 기존 원격 저장소만 Import하면 새 코드가 포함되지 않습니다.

## 6. Vercel의 빌드 설정 확인

Vercel 대시보드에서 해당 프로젝트의 Settings → Build and Deployment에서 확인합니다. UI 명칭은 변경될 수 있습니다.

| 설정 | 값 |
|---|---|
| Framework Preset | Other |
| Root Directory | `package.json`과 `vercel.json`이 있는 폴더. 이 저장소가 프로젝트 루트면 `.` |
| Node.js Version | 22.x |
| Build Command | `npm run build` |
| Output Directory | `dist` |

`vercel.json`이 Framework, Build Command, Output Directory, API 경로와 보안 헤더를 이미 지정합니다. 수동 설정이 남아 있다면 이 값과 충돌하지 않게 맞춥니다. `npm start`는 로컬 서버 실행 명령이므로 빌드 명령에 넣지 않습니다. 서버리스 배포용 PORT·DATA_DIR·상시 실행 Start Command는 설정하지 않습니다.

공식 문서: [프로젝트 설정](https://vercel.com/docs/project-configuration/vercel-json), [Node.js 함수](https://vercel.com/docs/functions/runtimes/node-js).

## 7. 환경변수 등록

프로젝트 Settings → Environment Variables에서 아래 값을 추가합니다. **Production과 Preview 모두** 선택해야 두 환경에서 테스트할 수 있습니다. 이미 Upstash Marketplace 연동으로 주입됐다면 중복 등록할 필요가 없습니다.

| 이름 | 값 | 필수 여부 |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | 2번에서 복사한 HTTPS REST 주소 | 필수 |
| `UPSTASH_REDIS_REST_TOKEN` | 2번에서 복사한 일반 읽기·쓰기 토큰 | 필수 |
| `YOUTUBE_API_KEY` | 3번의 유튜브 API 키 | 제목 검색에 필요 |
| `COOKIE_SECURE` | `1` | 권장. Vercel에서는 코드에서도 Secure를 강제함 |

`REDIS_KEY_PREFIX`는 처음에는 등록하지 않아도 됩니다. 기본값은 Production에서 `sai:v1:production`, Preview에서 `sai:v1:preview`, 로컬에서 `sai:v1:development`로 서로 분리됩니다. 동일 DB를 여러 앱이 공유할 경우 각 앱·환경에 고유한 접두사를 지정하세요.

일부 Upstash/Vercel 연동에서 자동 생성하는 `KV_REST_API_URL`, `KV_REST_API_TOKEN` 이름도 지원합니다. 두 이름 묶음을 모두 설정하면 `UPSTASH_…`가 우선하므로 서로 다른 DB 정보가 섞이지 않게 확인하세요.

토큰에는 `NEXT_PUBLIC_` 또는 `VITE_` 접두사를 붙이지 않습니다. 클라이언트가 이 값을 볼 필요가 없습니다. 등록한 환경변수는 다음 배포부터 적용됩니다.

공식 문서: [Vercel 환경변수](https://vercel.com/docs/environment-variables), [Upstash 연동](https://upstash.com/docs/redis/howto/vercelintegration).

## 8. Preview 배포와 동작 확인

같은 프로젝트 폴더에서 실행합니다.

```powershell
npx vercel@latest
```

표시된 Preview 주소에서 아래 순서로 확인합니다.

1. 방 이름·닉네임을 입력해 생성하고 6자리 코드를 확인합니다.
2. 다른 브라우저나 휴대폰에서 **동일한 배포 주소**를 엽니다. 첫 화면에서 코드를 입력하고 닉네임으로 참여합니다.
3. 유튜브 링크로 첫 곡을 신청하면 방장 기기에서만 자동 재생을 시도합니다. 차단 시 재생 버튼을 누릅니다. 다른 브라우저에서는 현재 곡과 투표만 표시되고 영상·소리가 재생되지 않는지 확인합니다.
4. 두 번째 곡을 신청한 뒤 같은 브라우저의 반복 투표가 한 표만 반영되는지 확인합니다.
5. 현재 참여자의 과반이 건너뛰기에 동의하면 다음 곡으로 전환되는지 확인합니다.
6. 방장의 일시정지 버튼을 누른 후 재생 시간과 레코드 회전이 멈추는지 확인합니다. 기다리거나 새로고침해도 같은 위치를 유지하고, 재생 버튼으로 이어지는지 확인합니다. 다른 참여자에게 재생 버튼이나 재생 권한이 생기면 안 됩니다.
7. 마지막 참여자가 퇴장 버튼을 누르면 같은 코드로 다시 입장할 수 없어야 합니다.
8. 새 방에서 모두 창을 닫고 90초 이상 기다린 뒤 코드를 입력하면 방이 없어야 합니다.

Preview에 Vercel 로그인이 요구되면 Deployment Protection 설정 때문일 수 있습니다. 초대받을 사람의 접근 권한을 확인하거나 다음 단계의 Production 주소로 테스트하세요. 앱의 방 코드는 Vercel 자체 로그인 제한을 우회하지 않습니다.

## 9. Production 배포

Preview 확인 후 직접 실행합니다.

```powershell
npx vercel@latest --prod
```

배포 완료 후 표시되는 Production 주소를 실제 참여자에게 공유하세요. Preview의 코드·쿠키와 Production의 것은 분리되므로 **Production에서 새 방을 만들어야 합니다**. 사람마다 다른 Preview 주소나 localhost를 사용하면 같은 방 코드라도 함께 입장할 수 없습니다.

환경변수를 나중에 바꿨다면 다시 배포합니다. 이후에도 같은 명령으로 로컬 소스의 변경을 올릴 수 있습니다. Git 푸시는 이 명령에 필요하지 않습니다.

## 10. 빈 방 자동 삭제와 실제 사용의 주의점

접속 확인은 15초 간격입니다. Redis 방 키의 TTL을 90초로 갱신하며, 모두 연결이 끊기면 더 이상 갱신되지 않아 자동 삭제됩니다. 별도 Cron 설정은 필요 없습니다. 활성 참여자가 있으면 접속 확인 때 계속 갱신되므로 방이 90초마다 무조건 삭제되는 구조가 아닙니다.

음악은 방장의 기기에서만 재생합니다. 방장이 일시정지하면 서버에도 멈춘 위치를 저장하므로 재생 시간과 자동 다음 곡 전환이 멈춥니다. 방의 접속 확인은 일시정지 중에도 유지됩니다. 브라우저 절전이나 기기 수면으로 접속 확인이 중단되면 자동 퇴장으로 처리될 수 있습니다. 소리 자동 재생 정책을 앱이 무조건 해제할 수는 없습니다. 영상 길이는 플레이어 메타데이터 로드 후 확인하며 녹화된 영상·음악이 대상입니다. 광고·버퍼링 등으로 기기별 오차가 발생할 수 있습니다.

이 앱은 브라우저별 한 표입니다. 실제 한 사람·한 물리 기기를 인증하는 로그인 시스템은 아닙니다.

## 11. 자주 만나는 오류

| 증상 | 확인할 내용 |
|---|---|
| 화면은 열리지만 방 생성 시 DB 설정 오류 | REST URL과 토큰을 Production/Preview에 모두 등록했는지, 등록 후 재배포했는지 |
| DB 요청이 거절됨 | 일반 쓰기 토큰인지, 주소·토큰이 같은 DB의 것인지, 서비스 사용 한도를 넘지 않았는지 |
| API가 404 | 프로젝트 루트·`api/index.js`·`vercel.json` 포함 여부와 Output Directory 확인 |
| 방 코드가 없다고 나옴 | 만료된 방인지, 모두 같은 배포 주소·환경인지, 기존 32자리 링크를 사용 중인지 |
| 제목 검색 비활성 | `YOUTUBE_API_KEY`를 해당 배포 환경에 넣고 재배포했는지 |
| 유튜브 검색 오류 | API 활성화, API 종류 제한, 할당량, 서버 요청에 맞지 않는 리퍼러 제한 여부 |
| 영상은 보이지만 소리가 안 남 | 방장 기기에서 재생 버튼·음소거·출력 확인 |
| 영상이 곧바로 넘어감 | 영상의 외부 재생·연령·지역 제한 등으로 플레이어가 오류를 보낸 경우. 다른 영상 사용 |

## 12. 검증 범위

코드의 자동 테스트는 로컬 API, 분산 요청 충돌, 중복 투표, 중간 합류 위치, 공유 시각에 따른 다음 곡 전환, 코드·접속 만료, Vercel 요청 형식을 검사합니다. Redis는 REST 계약 모형으로 검증합니다. 계정의 실제 Upstash 연결과 Vercel 운영 배포는 위 8~9번 절차로 확인해야 합니다. 이 문서가 생성됐다는 사실이 실제 배포 완료를 뜻하지는 않습니다.
