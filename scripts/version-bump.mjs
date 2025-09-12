#!/usr/bin/env node
import fs from 'fs';

const manifestPath = 'manifest.json';
const pkgPath = 'package.json';

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

if (!pkg.version) {
  console.error('package.json is missing version');
  process.exit(1);
}

manifest.version = pkg.version;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Updated ${manifestPath} to version ${pkg.version}`);

