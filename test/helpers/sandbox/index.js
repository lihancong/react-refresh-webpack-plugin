const path = require('path');
const fse = require('fs-extra');
const getPort = require('get-port');
const { nanoid } = require('nanoid');
const { getIndexHTML, getPackageJson, getWDSConfig } = require('./configs');
const { killTestProcess, spawnWebpackServe } = require('./spawn');

// Extends the timeout for tests using the sandbox
jest.setTimeout(1000 * 60);

// Setup a global "queue" of cleanup handlers to allow auto-teardown of tests,
// even when they did not run the cleanup function.
/** @type {Map<string, function(): Promise<void>>} */
const cleanupHandlers = new Map();
afterEach(async () => {
  for (const [, callback] of cleanupHandlers) {
    await callback();
  }
});

/**
 * Logs output to the console (only in debug mode).
 * @param {...*} args
 * @returns {void}
 */
const log = (...args) => {
  if (__DEBUG__) {
    console.log(...args);
  }
};

/**
 * Pause current asynchronous execution for provided milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * @typedef {Object} SandboxSession
 * @property {boolean} didFullRefresh
 * @property {*[]} errors
 * @property {*[]} logs
 * @property {function(): void} resetState
 * @property {function(string, string): Promise<void>} write
 * @property {function(string, string): Promise<void>} patch
 * @property {function(string): Promise<void>} remove
 * @property {function(*, ...*=): Promise<*>} evaluate
 * @property {function(): Promise<void>} reload
 */

const rootSandboxDir = path.join(__dirname, '../..', '__tmp__');

/**
 * Creates a Webpack and Puppeteer backed sandbox to execute HMR operations on.
 * @param {Object} [options]
 * @param {boolean} [options.esModule]
 * @param {string} [options.id]
 * @param {Map<string, string>} [options.initialFiles]
 * @returns {Promise<[SandboxSession, function(): Promise<void>]>}
 */
async function getSandbox({ esModule = false, id = nanoid(), initialFiles = new Map() } = {}) {
  const port = await getPort();

  // Get sandbox directory paths
  const sandboxDir = path.join(rootSandboxDir, id);
  const srcDir = path.join(sandboxDir, 'src');
  const publicDir = path.join(sandboxDir, 'public');
  // In case of an ID clash, remove the existing sandbox directory
  await fse.remove(sandboxDir);
  // Create the sandbox source directory
  await fse.mkdirp(srcDir);
  // Create the sandbox public directory
  await fse.mkdirp(publicDir);

  // Write necessary files to sandbox
  await fse.writeFile(path.join(sandboxDir, 'webpack.config.js'), getWDSConfig(srcDir));
  await fse.writeFile(path.join(publicDir, 'index.html'), getIndexHTML(port));
  await fse.writeFile(path.join(srcDir, 'package.json'), getPackageJson(esModule));
  await fse.writeFile(
    path.join(srcDir, 'index.js'),
    esModule
      ? `export default function Sandbox() { return 'new sandbox'; }`
      : "module.exports = function Sandbox() { return 'new sandbox'; };"
  );

  // Write initial files to sandbox
  for (const [filePath, fileContent] of initialFiles.entries()) {
    await fse.writeFile(path.join(srcDir, filePath), fileContent);
  }

  // TODO: Add handling for webpack-hot-middleware and webpack-plugin-serve
  const app = await spawnWebpackServe(port, { public: publicDir, root: sandboxDir, src: srcDir });
  /** @type {import('puppeteer').Page} */
  const page = await browser.newPage();

  await page.goto(`http://localhost:${port}/`);

  let didFullRefresh = false;
  /** @type {string[]} */
  let errors = [];
  /** @type {string[]} */
  let logs = [];

  // Expose logging and hot callbacks to the page
  // FIXME: Puppeteer version stuck at v10 due to issues with detached frames
  //  Ref: https://github.com/puppeteer/puppeteer/issues/7814
  await Promise.all([
    page.exposeFunction('log', (...args) => {
      logs.push(args.join(' '));
    }),
    page.exposeFunction('onHotAcceptError', (errorMessage) => {
      errors.push(errorMessage);
    }),
    page.exposeFunction('onHotSuccess', () => {
      page.emit('hotSuccess');
    }),
  ]);

  // Reset testing logs and errors on any navigation.
  // This is done for the main frame only,
  // because child frames (e.g. iframes) might attach to the document,
  // which will cause this event to fire.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      resetState();
    }
  });

  /** @returns {void} */
  function resetState() {
    errors = [];
    logs = [];
  }

  async function cleanupSandbox() {
    try {
      await page.close();
      await killTestProcess(app);

      if (!__DEBUG__) {
        await fse.remove(sandboxDir);
      }

      // Remove current cleanup handler from the global queue since it has been called
      cleanupHandlers.delete(id);
    } catch (e) {
      // Do nothing
    }
  }

  // Cache the cleanup handler for global cleanup
  // This is done in case tests fail and async handlers are kept alive
  cleanupHandlers.set(id, cleanupSandbox);

  return [
    {
      /** @type {boolean} */
      get didFullRefresh() {
        return didFullRefresh;
      },
      /** @type {*[]} */
      get errors() {
        return errors;
      },
      /** @type {*[]} */
      get logs() {
        return logs;
      },
      /** @returns {void} */
      resetState,
      /**
       * @param {string} fileName
       * @param {string} content
       * @returns {Promise<void>}
       */
      async write(fileName, content) {
        // Update the file on filesystem
        const fullFileName = path.join(srcDir, fileName);
        const directory = path.dirname(fullFileName);
        await fse.mkdirp(directory);
        await fse.writeFile(fullFileName, content);
      },
      /**
       * @param {string} fileName
       * @param {string} content
       * @returns {Promise<void>}
       */
      async patch(fileName, content) {
        // Register an event for HMR completion
        let hmrStatus = 'pending';
        // Parallelize file writing and event listening to prevent race conditions
        await Promise.all([
          this.write(fileName, content),
          new Promise((resolve) => {
            const hmrTimeout = setTimeout(() => {
              hmrStatus = 'timeout';
              resolve();
            }, 30 * 1000);

            // Frame Navigate and Hot Success events have to be exclusive,
            // so we remove the other listener when one of them is triggered.

            /**
             * @param {import('puppeteer').Frame} frame
             * @returns {void}
             */
            const onFrameNavigate = (frame) => {
              if (frame === page.mainFrame()) {
                page.off('hotSuccess', onHotSuccess);
                clearTimeout(hmrTimeout);
                hmrStatus = 'reloaded';
                resolve();
              }
            };

            /**
             * @returns {void}
             */
            const onHotSuccess = () => {
              page.off('framenavigated', onFrameNavigate);
              clearTimeout(hmrTimeout);
              hmrStatus = 'success';
              resolve();
            };

            // Make sure that the event listener is bound to trigger only once
            page.once('framenavigated', onFrameNavigate);
            page.once('hotSuccess', onHotSuccess);
          }),
        ]);

        if (hmrStatus === 'reloaded') {
          log('Application reloaded.');
          didFullRefresh = didFullRefresh || true;
        } else if (hmrStatus === 'success') {
          log('Hot update complete.');
        } else {
          throw new Error(`Application is in an inconsistent state: ${hmrStatus}.`);
        }

        // Slow down tests to wait for re-rendering
        await sleep(1000);
      },
      /**
       * @param {string} fileName
       * @returns {Promise<void>}
       */
      async remove(fileName) {
        const fullFileName = path.join(srcDir, fileName);
        await fse.remove(fullFileName);
      },
      /**
       * @param {*} fn
       * @param {...*} restArgs
       * @returns {Promise<*>}
       */
      async evaluate(fn, ...restArgs) {
        if (typeof fn === 'function') {
          return await page.evaluate(fn, ...restArgs);
        } else {
          throw new Error('You must pass a function to be evaluated in the browser!');
        }
      },
      /** @returns {Promise<void>} */
      async reload() {
        await page.reload({ waitUntil: 'networkidle2' });
        didFullRefresh = false;
      },
    },
    cleanupSandbox,
  ];
}

module.exports = getSandbox;
