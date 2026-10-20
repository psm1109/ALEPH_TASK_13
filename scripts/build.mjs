import { mkdirSync, copyFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
for (const name of ['index.html', 'app.js', 'session.js', 'style.css', 'tonearm.svg']) copyFileSync(`public/${name}`, `dist/${name}`);
console.log('정적 화면과 재생 동기화 모듈을 dist에 준비했습니다. API는 Vercel Functions로 배포됩니다.');
