// GitHub Pages용 사이트 만들기: public/ + lib.js → _site/ (서버 없이 이 기기 저장소 사용)
import { cpSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '_site');
rmSync(out, { recursive: true, force: true });
cpSync(path.join(root, 'public'), out, { recursive: true });
copyFileSync(path.join(root, 'lib.js'), path.join(out, 'lib.js'));
const index = path.join(out, 'index.html');
const html = readFileSync(index, 'utf8');
const tag = '<script type="module" src="app.js"></script>';
if (!html.includes(tag)) throw new Error('index.html에서 app.js 태그를 찾지 못했습니다.');
writeFileSync(index, html.replace(tag, `<script type="module" src="local-api.js"></script>\n  ${tag}`));
console.log('사이트 생성: _site/');
