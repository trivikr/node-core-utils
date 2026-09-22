import { Agent, globalAgent } from 'node:https';
import { spawnSync } from 'node:child_process';

import { getMergedConfig } from './config.js';

export default function proxy() {
  let proxyUrl = getMergedConfig().proxy;
  if (proxyUrl == null || proxyUrl === '') {
    proxyUrl = spawnSync(
      'git',
      ['config', '--get', '--path', 'https.proxy']
    ).stdout.toString();
  }
  proxyUrl = proxyUrl?.trim();
  if (proxyUrl == null || proxyUrl === '') {
    return globalAgent;
  } else {
    return new Agent({ proxyEnv: { HTTPS_PROXY: proxyUrl } });
  }
}
