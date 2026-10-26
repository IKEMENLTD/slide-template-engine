// 使い方: npx tsx scripts/phase0/check-structure.ts <a.pptx> [...]  問題があれば exit 1
import { readFileSync } from 'node:fs';
import { checkPptxStructure } from '../../src/check/pptx-structure.ts';
for (const f of process.argv.slice(2)) { const i = await checkPptxStructure(readFileSync(f)); console.log(f, i.length); if (i.length) process.exitCode = 1; for (const x of i) console.log('  ', x.code, x.part, x.detail); }
