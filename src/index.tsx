import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { logEvent } from './modules/logger.js';
import { PackageManager } from './modules/packageManager.js';

export const APP_NAME = 'ubuntu-fileserver';
export const APP_VERSION = '1.0.0';

function printHelp(): void {
  console.log(`${APP_NAME} v${APP_VERSION}
Ubuntu Server 24.04 Samba + Active Directory + LVM Automation TUI

Usage:
  sudo ./ubuntu-fileserver [options]

Options:
  -h, --help         Show this help message and exit
  -v, --version      Show application version and runtime details
  --check-packages   Print required package installation status as JSON and exit
`);
}

let inAltScreen = false;

function enterAltScreen(): void {
  if (process.stdout.isTTY && !inAltScreen) {
    inAltScreen = true;
    process.stdout.write('\x1b[?1049h\x1b[H\x1b[?25l');
  }
}

function exitAltScreen(): void {
  if (process.stdout.isTTY && inAltScreen) {
    inAltScreen = false;
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`${APP_NAME} v${APP_VERSION} (${process.platform}/${process.arch})`);
    process.exit(0);
  }

  if (args.includes('--check-packages')) {
    const pm = new PackageManager();
    const [prereq, packages] = await Promise.all([pm.checkPrerequisites(), pm.getPackageStatuses()]);
    console.log(JSON.stringify({ app: APP_NAME, version: APP_VERSION, prerequisites: prereq, packages }, null, 2));
    process.exit(0);
  }

  process.on('unhandledRejection', (reason) => {
    logEvent('error', 'process', 'Unhandled promise rejection caught', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });

  process.on('uncaughtException', (err) => {
    exitAltScreen();
    logEvent('error', 'process', 'Uncaught exception caught', {
      error: err.message,
    });
  });

  enterAltScreen();
  const handleSignal = (): void => {
    exitAltScreen();
    process.exit(0);
  };
  process.once('exit', exitAltScreen);
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    const { waitUntilExit } = render(<App />, {
      exitOnCtrlC: false,
    });
    await waitUntilExit();
  } finally {
    exitAltScreen();
  }
  process.exit(0);
}

void main();
