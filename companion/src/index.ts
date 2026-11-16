import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import qrcode from 'qrcode-terminal';
import { Bridge } from './bridge.js';
import { configPath, lanAddresses, loadConfig } from './config.js';
import { startServer } from './server.js';

export interface CompanionOptions {
  lockfile?: string;
  port?: number;
  host?: string;
  resetToken?: boolean;
  quiet?: boolean;
  debug?: boolean;
}

export async function runCompanion(opts: CompanionOptions = {}) {
  const cfg = await loadConfig({ resetToken: opts.resetToken });
  const port = opts.port ?? cfg.port;
  const host = opts.host ?? '0.0.0.0';

  const bridge = new Bridge({ lockfile: opts.lockfile ?? process.env.LCU_LOCKFILE, debug: opts.debug });
  bridge.on('log', (m: string) => console.log(`[companion] ${m}`));
  const server = await startServer(bridge, { port, host, token: cfg.token });
  bridge.start();

  const ips = lanAddresses();
  const ip = ips[0] ?? '127.0.0.1';
  const pairUrl = `lolcs://connect?host=${ip}&port=${port}&token=${cfg.token}`;

  if (!opts.quiet) {
    console.log('\n  LoL Champ Select companion is running.\n');
    console.log('  Scan this QR code with the mobile app to pair:\n');
    qrcode.generate(pairUrl, { small: true }, (q) => console.log(q.replace(/^/gm, '  ')));
    console.log(`  Or enter manually:`);
    console.log(`    Host:  ${ip}${ips.length > 1 ? `   (other addresses: ${ips.slice(1).join(', ')})` : ''}`);
    console.log(`    Port:  ${port}`);
    console.log(`    Code:  ${cfg.token}\n`);
    console.log(`  Pairing code stored in ${configPath()} (run with --reset-token to revoke).\n`);
  }

  return { bridge, server, token: cfg.token, port, pairUrl };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { values } = parseArgs({
    options: {
      lockfile: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      'reset-token': { type: 'boolean' },
      debug: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(`Usage: npm start -- [options]

  --lockfile <path>   Path to the League Client lockfile (auto-detected by default)
  --port <n>          Port for the phone to connect to (default 8787)
  --host <addr>       Interface to listen on (default 0.0.0.0)
  --reset-token       Generate a new pairing code, un-pairing existing phones
  --debug             Log every League Client event the companion receives`);
    process.exit(0);
  }
  runCompanion({
    lockfile: values.lockfile,
    port: values.port ? Number(values.port) : undefined,
    host: values.host,
    resetToken: values['reset-token'],
    debug: values.debug,
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
