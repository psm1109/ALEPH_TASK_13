import { mkdirSync, copyFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
for (const name of ['index.html', 'app.js', 'style.css']) copyFileSync(`public/${name}`, `dist/${name}`);
console.log('정적 화면 3개를 dist에 준비했습니다. API는 Vercel Functions로 배포됩니다.');
