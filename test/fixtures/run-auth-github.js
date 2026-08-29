import assert from 'assert';

async function mockCredentials(...args) {
  assert.deepStrictEqual(args, []);
  return {
    user: 'nyancat',
    token: '0123456789abcdef'
  };
}

(async function() {
  const { default: auth } = await import('../../lib/auth.js');
  const authParams = await auth({ github: true }, mockCredentials);
  if (typeof authParams === 'object' && authParams != null) {
    for (const key of Object.getOwnPropertyNames(authParams)) {
      if (key !== 'github') delete authParams[key];
    }
  }
  process.stdout.write(`${JSON.stringify(authParams)}\n`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
