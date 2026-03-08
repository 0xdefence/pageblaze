import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const contractsDir = path.join(root, 'docs', 'contracts');
if (!fs.existsSync(contractsDir)) {
  console.error('contracts dir missing');
  process.exit(1);
}

const files = fs.readdirSync(contractsDir);
const jsonFiles = files.filter((f) => f.endsWith('.json'));
let ok = true;

for (const f of jsonFiles) {
  const p = path.join(contractsDir, f);
  try {
    JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    ok = false;
    console.error(`invalid json: ${f}`);
  }
}

for (const csvName of ['export.issues.csv', 'export.recommendations.csv']) {
  const p = path.join(contractsDir, csvName);
  if (!fs.existsSync(p)) continue;
  const firstLine = fs.readFileSync(p, 'utf8').split(/\r?\n/)[0] || '';
  if (!firstLine.includes(',')) {
    ok = false;
    console.error(`invalid csv header: ${csvName}`);
  }
}

if (!ok) process.exit(1);
console.log(`contracts check passed (${jsonFiles.length} json files)`);
