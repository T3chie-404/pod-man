#!/usr/bin/env node

const { getComponentVersions } = require('../lib/component-versions');

function humanLine(label, value, extra = null) {
  const suffix = extra ? ` (${extra})` : '';
  return `${label}: ${value || 'N/A'}${suffix}`;
}

async function main() {
  const jsonMode = process.argv.includes('--json');
  const versions = await getComponentVersions();

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(versions, null, 2)}\n`);
    return;
  }

  const lines = [
    humanLine('xandminer', versions.xandminer, versions.codename || null),
    humanLine('xandminerd', versions.xandminerd),
    humanLine('pod', versions.pod),
    humanLine('pod-man', versions.podMan)
  ];

  process.stdout.write(`${lines.join('\n')}\n`);
  if (Array.isArray(versions.warnings) && versions.warnings.length) {
    process.stdout.write(`warnings: ${versions.warnings.join(' | ')}\n`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
