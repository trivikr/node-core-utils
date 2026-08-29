import fs from 'node:fs';

import { password } from '@inquirer/prompts';

import { clearCachedConfig, encryptValue, getMergedConfig, getNcurcPath } from './config.js';

export default lazy(auth);

function check(username, token, format = /^[A-Za-z0-9\-_.]+$/) {
  if (typeof username !== 'string') {
    throw new Error(`username must be a string, received ${typeof username}`);
  }
  if (!/^[a-zA-Z0-9-]+$/.test(username)) {
    throw new Error(
      'username may only contain alphanumeric characters or hyphens, ' +
      `received ${username}`
    );
  }
  if (typeof token !== 'string') {
    throw new Error(`token must be a string, received ${typeof token}`);
  }
  if (!format.test(token)) {
    throw new Error(`token is misformatted: ${token}`);
  }
}

function lazy(fn) {
  let cachedValue;
  return function(...args) {
    if (cachedValue !== undefined) {
      return cachedValue;
    }
    cachedValue = fn(...args);
    return cachedValue;
  };
}

export async function getGitHubCredentials(
  passwordPrompt = password,
  request = globalThis.fetch) {
  const token = await passwordPrompt({
    message: 'Paste your GitHub personal access token:',
    validate: (value) => value.length > 0 || 'A token is required'
  });
  const response = await request('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'node-core-utils'
    }
  });
  const user = await response.json();

  if (!response.ok) {
    throw new Error(user.message || `GitHub API returned ${response.status}`);
  }
  if (typeof user.login !== 'string') {
    throw new Error('GitHub API response did not include a username');
  }

  return { user: user.login, token };
}

async function tryCreateGitHubToken(getCredentials) {
  let credentials;
  try {
    credentials = await getCredentials();
  } catch (e) {
    throw new Error(`Could not get token: ${e.message}`, { cause: e });
  }
  return credentials;
}

function encode(name, token) {
  return Buffer.from(`${name}:${token}`).toString('base64');
}

function setOwnProperty(target, key, value) {
  return Object.defineProperty(target, key, {
    __proto__: null,
    configurable: true,
    enumerable: true,
    value
  });
}

// TODO: support jenkins only...or not necessary?
// TODO: make this a class with dependency (CLI) injectable for testing
async function auth(
  options = { github: true },
  getCredentials = getGitHubCredentials) {
  const result = {
    get github() {
      let username;
      let token;
      try {
        ({ username, token } = getMergedConfig());
      } catch {
        // Ignore error and prompt
      }

      check(username, token);
      const github = encode(username, token);
      setOwnProperty(result, 'github', github);
      return github;
    },

    get jenkins() {
      const { username, jenkins_token } = getMergedConfig();
      if (!username || !jenkins_token) {
        throw new Error(
          'Get your Jenkins API token in https://ci.nodejs.org/me/security ' +
          'and run the following command to add it to your ncu config: ' +
          'ncu-config --global set -x jenkins_token'
        );
      }
      check(username, jenkins_token);
      const jenkins = encode(username, jenkins_token);
      setOwnProperty(result, 'jenkins', jenkins);
      return jenkins;
    },

    get h1() {
      const { h1_username, h1_token } = getMergedConfig();
      check(h1_username, h1_token, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
      const h1 = encode(h1_username, h1_token);
      setOwnProperty(result, 'h1', h1);
      return h1;
    }
  };
  if (options.github) {
    let config;
    try {
      config = getMergedConfig();
    } catch {
      config = {};
    }
    if (!Object.hasOwn(config, 'token') || !Object.hasOwn(config, 'username')) {
      process.stdout.write(
        'If this is your first time running this command, ' +
        'follow the instructions to create an access token' +
        '. If you prefer to create it yourself on Github, ' +
        'see https://github.com/nodejs/node-core-utils/blob/main/README.md.\n');
      const credentials = await tryCreateGitHubToken(getCredentials);
      const username = credentials.user;
      let token;
      try {
        token = await encryptValue(credentials.token);
      } catch {
        console.warn('Failed encrypt token, storing unencrypted instead');
        token = credentials.token;
      }
      const json = JSON.stringify({ username, token }, null, 2);
      fs.writeFileSync(getNcurcPath(), json, {
        mode: 0o600 /* owner read/write */
      });
      // Try again reading the file
      clearCachedConfig();
    }
  }

  return result;
}
