import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

const require = createRequire(import.meta.url);
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const packages = lock.packages ?? {};

function installedVersion(dependency) {
  let directory = dirname(require.resolve(dependency));
  const root = parse(directory).root;

  while (directory !== root) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.name === dependency) return manifest.version;
    }
    directory = dirname(directory);
  }

  throw new Error(`Could not locate the installed manifest for ${dependency}`);
}

const resolutions = [
  {
    dependency: 'find-my-way',
    expected: '9.7.0',
    parent: 'node_modules/@nestjs/platform-fastify',
    nested: 'node_modules/@nestjs/platform-fastify/node_modules/find-my-way',
  },
  {
    dependency: 'gaxios',
    expected: '7.3.0',
    parent: 'node_modules/gcp-metadata',
    nested: 'node_modules/gcp-metadata/node_modules/gaxios',
  },
];

for (const resolution of resolutions) {
  const parentVersion = packages[resolution.parent]?.dependencies?.[resolution.dependency];
  if (parentVersion !== resolution.expected) {
    throw new Error(
      `${resolution.parent} must resolve ${resolution.dependency}@${resolution.expected}; found ${parentVersion ?? 'missing'}`,
    );
  }

  if (packages[resolution.nested]) {
    throw new Error(`${resolution.nested} must stay deduplicated to the audited root resolution`);
  }

  const installed = installedVersion(resolution.dependency);
  if (installed !== resolution.expected) {
    throw new Error(
      `Installed ${resolution.dependency} must be ${resolution.expected}; found ${installed}`,
    );
  }

  console.log(`${resolution.dependency}@${installed} production resolution verified`);
}
