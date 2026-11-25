'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { builtinAsar } = require('./asar-engine');
const {
  findWindowLoadAnchor,
  verifyCleanStructure,
  cleanUtilsSource,
  validateSyntax
} = require('./modular-installer');
const { install } = require('./install');
const { restore } = require('./restore');

const V235_UTILS_SAMPLE = `"use strict";
function setupNodeWrapper(env) {
  return env;
}
function loadHubWindowUrl(win, url, opts) {
  return win.loadURL(url, opts);
}
function createWindow(url, storageManager, options) {
  const win = {
    loadURL() {},
    titleBarStyle: 'hidden',
  };
    const skipBootstrapMint = Boolean(options?.partition || options?.navigationPolicy);
    void loadHubWindowUrl(win, url, { skipBootstrapMint });
    return win;
}
const showOrCreateWindow = (port) => {
  const wins = [];
  if (wins.length > 0) {
    wins[0].focus();
  } else if (port > 0) {
    createWindow(\`\${constants_1.WINDOW_ORIGIN}:\${port}/\`);
  }
};
`;

test('findWindowLoadAnchor 与 verifyCleanStructure 同时兼容 <=2.34 与 >=2.35.1', () => {
  const v234Sample = V235_UTILS_SAMPLE.replace(
    '    void loadHubWindowUrl(win, url, { skipBootstrapMint });',
    '    void win.loadURL(url);'
  );

  assert.equal(findWindowLoadAnchor(v234Sample), '    void win.loadURL(url);');
  assert.equal(verifyCleanStructure(v234Sample), true);

  assert.equal(
    findWindowLoadAnchor(V235_UTILS_SAMPLE),
    '    void loadHubWindowUrl(win, url, { skipBootstrapMint });'
  );
  assert.equal(verifyCleanStructure(V235_UTILS_SAMPLE), true);

  // 重复锚点或缺失锚点必须拒绝
  const dupSample = V235_UTILS_SAMPLE + '\n    void win.loadURL(url);\n';
  assert.equal(findWindowLoadAnchor(dupSample), null);
  assert.equal(verifyCleanStructure(dupSample), false);

  const missingSample = V235_UTILS_SAMPLE.replace(
    '    void loadHubWindowUrl(win, url, { skipBootstrapMint });',
    '    // removed'
  );
  assert.equal(findWindowLoadAnchor(missingSample), null);
  assert.equal(verifyCleanStructure(missingSample), false);
});

test('v2.35.1 模拟 app.asar 可完整安装、重复清洗重装并无损还原', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v235-test-'));
  const prevStateDir = process.env.AG_METER_STATE_DIR;
  const stateDir = path.join(tmpRoot, 'state');
  process.env.AG_METER_STATE_DIR = stateDir;

  try {
    const srcDir = path.join(tmpRoot, 'src');
    fs.mkdirSync(path.join(srcDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.35.1' }));
    fs.writeFileSync(path.join(srcDir, 'dist', 'utils.js'), V235_UTILS_SAMPLE);
    fs.writeFileSync(path.join(srcDir, 'dist', 'preload.js'), '"use strict";\nconst electron_1 = require("electron");\n');

    const mockAsar = path.join(tmpRoot, 'app.asar');
    await builtinAsar.createPackage(srcDir, mockAsar);
    const originalBuf = fs.readFileSync(mockAsar);

    // 首次安装
    const res1 = await install({ path: mockAsar, pureMeterOnly: true });
    assert.equal(path.resolve(res1.installed), path.resolve(mockAsar));
    assert.ok(res1.meterVersion);

    const patchedUtils = builtinAsar.extractFile(mockAsar, 'dist/utils.js').toString('utf8');
    assert.equal(validateSyntax(patchedUtils, 'dist/utils.js'), true);
    assert.match(patchedUtils, /installContextMeter/);
    assert.match(patchedUtils, /void loadHubWindowUrl\(win, url, \{ skipBootstrapMint \}\);/);

    // 清洗后应再次通过结构校验
    const cleaned = cleanUtilsSource(patchedUtils);
    assert.equal(verifyCleanStructure(cleaned), true);

    // 二次幂等重装
    const res2 = await install({ path: mockAsar, pureMeterOnly: true });
    assert.equal(path.resolve(res2.installed), path.resolve(mockAsar));

    // 无损还原
    const resRestore = await restore({ path: mockAsar });
    assert.ok(resRestore);
    assert.deepEqual(fs.readFileSync(mockAsar), originalBuf);
  } finally {
    if (prevStateDir === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevStateDir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('v2.35.1 local-api 在 GET / 返回 401 时可通过 authBootstrap 与 daemon/hub_*.json 获取 CSRF Token', async () => {
  const http = require('node:http');
  const { connect, connectOrigin } = require('./local-api');

  const expectedToken = 'v235-bootstrap-csrf-token';
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized: bootstrap token required');
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetUserStatus') {
      if (req.headers['x-codeium-csrf-token'] !== expectedToken) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Invalid CSRF');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ userStatus: { email: 'user@example.com' } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const tmpDaemon = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-v235-daemon-'));

  try {
    // 1) 通过主进程 authBootstrap 回退鉴权
    const api1 = await connectOrigin(origin, null, [origin], {
      _authBootstrap: {
        getActiveLsBaseUrl: () => origin,
        getActiveLsCsrfToken: () => expectedToken
      }
    });
    const r1 = await api1.call('GetUserStatus', {});
    assert.equal(r1.userStatus.email, 'user@example.com');

    // 2) 通过 daemon/hub_*.json 回退鉴权
    fs.writeFileSync(
      path.join(tmpDaemon, `hub_${port}.json`),
      JSON.stringify({ pid: process.pid, httpsPort: port, httpPort: port, csrfToken: expectedToken })
    );
    const api2 = await connect({ origin, daemonDir: tmpDaemon });
    const r2 = await api2.call('GetUserStatus', {});
    assert.equal(r2.userStatus.email, 'user@example.com');
  } finally {
    server.close();
    fs.rmSync(tmpDaemon, { recursive: true, force: true });
  }
});
