import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

type SupportedTarget = 'bun-linux-x64' | 'bun-linux-arm64';

const APP_NAME = 'ubuntu-fileserver';
const APP_VERSION = '1.0.0';

function parseTargetArg(): SupportedTarget {
  const arg = process.argv.find((a) => a.startsWith('--target='));
  if (arg) {
    const val = arg.split('=')[1];
    if (val === 'bun-linux-x64' || val === 'bun-linux-arm64') {
      return val;
    }
    throw new Error(`Unsupported target "${val}". Supported targets: bun-linux-x64, bun-linux-arm64.`);
  }
  return process.arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64';
}

async function computeSha256(filePath: string): Promise<string> {
  const data = await Bun.file(filePath).arrayBuffer();
  return crypto.createHash('sha256').update(new Uint8Array(data)).digest('hex');
}

async function build(): Promise<void> {
  const target = parseTargetArg();
  const rootDir = process.cwd();
  const distDir = path.join(rootDir, 'dist');
  const outfileName = target === 'bun-linux-x64' ? APP_NAME : `${APP_NAME}-arm64`;
  const outfile = path.join(distDir, outfileName);

  await fs.mkdir(distDir, { recursive: true });

  console.log(`Building standalone Linux binary for target=${target}...`);

  const result = await Bun.build({
    entrypoints: [path.join(rootDir, 'src', 'index.tsx')],
    compile: {
      target,
      outfile,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'process.env.DEV': JSON.stringify('false'),
    },
    plugins: [
      {
        name: 'stub-optional-ink-devtools',
        setup(builder) {
          // Ink 5 optionally imports react-devtools-core inside reconciler.js when DEV === 'true'.
          // Stubbing it keeps standalone compilation clean without bundling dev-only devtools.
          builder.onResolve({ filter: /^react-devtools-core$/ }, () => ({
            path: 'react-devtools-core',
            namespace: 'stub-devtools',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'stub-devtools' }, () => ({
            contents: 'export default { connectToDevTools() {} };',
            loader: 'js',
          }));
        },
      },
    ],
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  await fs.chmod(outfile, 0o755);
  const stat = await fs.stat(outfile);
  const sha256 = await computeSha256(outfile);
  const buildTime = new Date().toISOString();

  await Bun.write(path.join(distDir, `${outfileName}.sha256`), `${sha256}  ${outfileName}\n`);

  const buildInfo = [
    `Application:   ${APP_NAME}`,
    `Version:       ${APP_VERSION}`,
    `Build Target:  ${target}`,
    `Binary File:   ${outfileName}`,
    `Size (bytes):  ${stat.size}`,
    `SHA-256:       ${sha256}`,
    `Bun Compiler:  Bun ${Bun.version}`,
    `Built At:      ${buildTime}`,
    `Tested Host:   ${process.platform}/${process.arch}`,
    '',
    'Runtime Requirements on Ubuntu Server 24.04:',
    '  - No Bun or Node.js installation required',
    '  - Run with root privileges: sudo ./ubuntu-fileserver',
    '  - Ubuntu system utilities (apt-get, lsblk, lvm2, xfsprogs, samba, winbind, krb5-user, acl)',
    '',
  ].join('\n');

  await Bun.write(path.join(distDir, 'build-info.txt'), buildInfo);

  const distReadme = [
    `${APP_NAME} v${APP_VERSION} - Standalone Linux Distribution`,
    '====================================================',
    '',
    'Quick Start on Ubuntu Server 24.04:',
    `  1. Copy ${outfileName} to your Ubuntu Server 24.04 host.`,
    `  2. Ensure executable permissions: chmod +x ${outfileName}`,
    `  3. Run as root: sudo ./${outfileName}`,
    '',
    'Verify Integrity:',
    `  sha256sum -c ${outfileName}.sha256`,
    '',
    'Notes:',
    '  - Node.js and Bun are embedded inside this executable; neither needs to be installed on the server.',
    '  - Logs, backups, and installation state are stored in ./logs, ./backups, and ./state (or /var/lib/ubuntu-fileserver if CWD is read-only).',
    '  - You can preinstall all required APT packages via Menu Option 2 before configuring AD, LVM, and Samba.',
    '',
  ].join('\n');

  await Bun.write(path.join(distDir, 'README.txt'), distReadme);

  console.log(`Built: ${outfile} (${stat.size} bytes)`);
  console.log(`SHA-256: ${sha256}`);
}

void build();
