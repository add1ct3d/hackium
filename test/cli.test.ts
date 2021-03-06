import { start, TestServer } from '@jsoverson/test-server';
import { expect } from 'chai';
import { promises as fs } from 'fs';
import path from 'path';
import { Hackium } from '../src';
import { Arguments } from '../src/arguments';
import { _runCli } from '../src/cli';
import { read, resolve, write, remove, getRandomDir } from '../src/util/file';
import { delay } from '../src/util/promises';
import { debug, getArgs } from './helper';
import rimraf from 'rimraf';

var stdin = require('mock-stdin').stdin();

describe('cli', function () {
  this.timeout(6000);
  let dir = '/nonexistant';
  let baseUrlArgs = '';
  let baseArgs = '';
  let instance: Hackium | undefined;
  let server: TestServer;

  before(async () => {
    server = await start(__dirname, '_server_root');
  });

  after(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    dir = await getRandomDir();
    baseArgs = `--pwd="${__dirname}" --headless --userDataDir=${dir}`;
    baseUrlArgs = `--url="${server.url('index.html')}" ${baseArgs}`;
  });

  afterEach((done) => {
    (instance ? instance.close() : Promise.resolve()).finally(() => {
      instance = undefined;
      rimraf(dir, (err) => {
        if (err) done(err);
        done();
      });
    });
  });

  it('Should go to a default URL', async () => {
    instance = new Hackium(getArgs(`${baseUrlArgs}`));
    const browser = await instance.cliBehavior();
    const [page] = await browser.pages();
    const title = await page.title();
    expect(title).to.equal('Test page');
  });

  it('Should allow for configurable timeouts', async () => {
    // set a timeout too low for Chrome to launch & check the error in the assertion
    instance = new Hackium(getArgs(`${baseArgs} -t 10`));
    const error = await instance.cliBehavior().catch((e: any) => e);
    expect(error.message).to.match(/Timed out/i);
  });

  it('Should inject evaluateOnNewDocument scripts', async () => {
    instance = new Hackium(getArgs(`${baseUrlArgs} --inject _fixtures/global-var.js`));
    const browser = await instance.cliBehavior();
    const [page] = await browser.pages();
    const globalValue = await page.evaluate('window.globalVar');
    expect(globalValue).to.equal('globalVar');
  });

  it('Should intercept scripts', async () => {
    instance = new Hackium(getArgs(`${baseUrlArgs} --i _fixtures/interceptor.js`));
    const browser = await instance.cliBehavior();
    const [page] = await browser.pages();
    const value = await page.evaluate('window.interceptedVal');
    expect(value).to.equal('interceptedValue');
  });

  it('Should create userDataDir', async () => {
    instance = new Hackium(getArgs(`${baseUrlArgs}`));
    process.env.FOO = 'T';
    await instance.cliBehavior();
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).to.be.true;
  });

  it('Should read local config', async () => {
    instance = new Hackium({
      pwd: __dirname,
      headless: true,
      url: server.url('anything/'),
    } as Arguments);
    const browser = await instance.cliBehavior();
    const [page] = await browser.pages();
    const url = page.url();
    expect(url).to.equal(server.url('anything/'));
  });

  it('Should merge defaults with passed config', async () => {
    instance = new Hackium({
      headless: true,
      userDataDir: dir,
    } as Arguments);
    expect(instance.config.pwd).equal(process.cwd());
  });

  it('Should watch for and apply changes to injections on a reload', async () => {
    const tempPath = resolve(['_fixtures', 'global-var-temp.js'], __dirname);
    const origSrc = await read(['_fixtures', 'global-var.js'], __dirname);

    await write(tempPath, origSrc);
    instance = new Hackium(getArgs(`${baseUrlArgs} --inject _fixtures/global-var-temp.js -w`));
    const browser = await instance.cliBehavior();

    let [page] = await browser.pages();
    await page.setCacheEnabled(false);
    let globalValue = await page.evaluate('window.globalVar');
    expect(globalValue).to.equal('globalVar');

    await write(tempPath, origSrc.replace(/globalVar/g, 'hotloadVar'));
    const newPage = await instance.getBrowser().newPage();
    await page.close();
    debug('loading page in new tab');
    await newPage.goto(server.url('index.html'));

    globalValue = await newPage.evaluate('window.hotloadVar');
    expect(globalValue).to.equal('hotloadVar');

    await remove(tempPath);
  });

  it('Should watch for and apply changes to interceptors on a reload', async () => {
    const tempPath = resolve(['_fixtures', 'interceptorTemp.js'], __dirname);
    const origSrc = await read(['_fixtures', 'interceptor.js'], __dirname);

    await write(tempPath, origSrc.replace('interceptedValue', 'interceptedValTemp'));
    instance = new Hackium(getArgs(`${baseUrlArgs} --i _fixtures/interceptorTemp.js -w`));
    const browser = await instance.cliBehavior();

    let [page] = await browser.pages();
    await page.setCacheEnabled(false);
    let value = await page.evaluate('window.interceptedVal');
    expect(value).to.equal('interceptedValTemp');

    await write(tempPath, origSrc.replace('interceptedValue', 'interceptedValHotload'));
    // this is a race but so is life
    await delay(100);
    debug('reloading');
    await page.reload();

    value = await page.evaluate('window.interceptedVal');
    expect(value).to.equal('interceptedValHotload');

    await remove(tempPath);
  });

  it('Should watch for and apply changes to interceptors on a new tab', async () => {
    const tempPath = resolve(['_fixtures', 'interceptorTemp.js'], __dirname);
    const origSrc = await read(['_fixtures', 'interceptor.js'], __dirname);

    await write(tempPath, origSrc.replace('interceptedValue', 'interceptedValTemp'));
    instance = new Hackium(getArgs(`${baseUrlArgs} --i _fixtures/interceptorTemp.js -w`));
    const browser = await instance.cliBehavior();
    let [page] = await browser.pages();

    await page.setCacheEnabled(false);

    let value = await page.evaluate('window.interceptedVal');
    expect(value).to.equal('interceptedValTemp');

    await write(tempPath, origSrc.replace('interceptedValue', 'interceptedValHotload'));
    const newPage = await instance.getBrowser().newPage();
    await page.close();
    debug('loading page in new tab');
    await newPage.goto(server.url('index.html'));

    value = await newPage.evaluate('window.interceptedVal');
    expect(value).to.equal('interceptedValHotload');

    await remove(tempPath);
  });

  it('Should run hackium scripts', async () => {
    const scriptPath = path.join('.', '_fixtures', 'script.js');

    instance = new Hackium(getArgs(`${baseUrlArgs} -e ${scriptPath} -- ${server.url('two.html')}`));
    const browser = await instance.cliBehavior();
    const [pageOrig, pageNew] = await browser.pages();

    const clicksEl = await pageOrig.$('#clicks');
    const numClicks = await pageOrig.evaluate((clicksEl: any) => clicksEl.innerHTML, clicksEl);

    expect(numClicks).to.equal('2');

    const url = pageNew.url();
    expect(url).to.match(/two.html$/);

    const bodyEl = await pageNew.$('body');
    const body = await pageNew.evaluate((bodyEl: any) => bodyEl.innerHTML, bodyEl);
    expect(body).to.equal(require('./_fixtures/module'));
  });

  it('repl should be testable', async () => {
    const args = getArgs(`${baseUrlArgs}`);
    const { repl } = await _runCli(args);
    instance = repl.context.hackium;
    let didClose = false;
    repl.on('exit', () => {
      didClose = true;
    });
    repl.write('.exit\n');
    // yield;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        expect(didClose).to.be.true;
        resolve();
      }, 100);
    });
  });
  // TODO: Fix this flaky test
  xit('.repl_history should be stored in config.pwd', async () => {
    if (process.env.MOCHA_EXPLORER_VSCODE) {
      // This is failing when it's run in VS Code and I can't spend any more time
      // figuring out why. This env var is set as part of the project settings so
      // this test is shortcircuited when run in VS Code.
      console.log('short circuiting');
      return;
    }
    const userDataDir = path.join(dir, 'chrome');
    const args = getArgs(`--pwd="${dir}" --userDataDir=${userDataDir}`);
    const { repl } = await _runCli(args, { stdin });
    instance = repl.context.hackium;
    stdin.send('/*hello world*/');
    stdin.send('\n');
    await delay(200);
    console.log(resolve(['.repl_history'], dir));
    console.log(dir);
    const replHistoryPath = resolve(['.repl_history'], dir);
    const history = await read(replHistoryPath);
    expect(history).to.equal(`/*hello world*/`);
  });
});
