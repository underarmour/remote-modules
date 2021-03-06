/* eslint no-sync:0 */

import assert from 'assert';
import Path from 'path';
import Url from 'url';
import { createContext } from 'vm';
import { createHash } from 'crypto';

import * as babylon from '@babel/parser';
import ASTQ from 'astq';
import stripAnsi from 'strip-ansi';
import got from 'got';
import { JSDOM } from 'jsdom';
import { assert as chaiAssert } from 'chai';
import sinon from 'sinon';
import cheerio from 'cheerio';

import Server from '../src/server';
import Installer from '../src/server/installer';
import ResourceFactory from '../src/server/installer/resource';
import ContextFactory, { getPackageId } from '../src/server/installer/context';
import createParser from '../src/server/installer/resource/adapters/default/parser';
import Client from '../src/client';
import RemoteLoader from '../src/client/loader';
import Registry from '../src/client/registry';
import ConfigStore from '../src/lib/config-store';
import * as resolver from '../src/lib/resolver';
import * as helpers from '../src/lib/helpers';
import calculatePID from '../src/lib/helpers/pid';
import identity from '../src/lib/helpers/identity';
import last from '../src/lib/helpers/last';
import noop from '../src/lib/helpers/noop';
import escapeRegExp from '../src/lib/helpers/escapeRegExp';
import {
	rimrafAsync,
	readFileAsync,
	readJSONAsync,
	writeFileAsync,
	writeJSONAsync
} from '../src/lib/helpers/fs';

const baseInstallerOptions = {
	root: 'dev/remote-package'
};

const C = new ConfigStore(baseInstallerOptions).use();

async function getDisposer(fn, initializer, disposer = noop) {
	const cursor = await initializer();
	let result;
	try {
		result = await fn(cursor);
	} catch (err) {
		throw err;
	} finally {
		await disposer(cursor);
	}
	return result;
}

async function getServer(fn, opts = C, disposer = noop) {
	return getDisposer(
		fn,
		async () => {
			const server = new Server(opts);
			await server.listen();
			return server;
		},
		async server => {
			await disposer(server);
			return server.close();
		}
	);
}

async function getResourceFactory(fn, opts = C, disposer) {
	return getDisposer(fn, () => new ResourceFactory(opts), disposer);
}

async function getInstaller(fn, opts = C, disposer) {
	return getDisposer(fn, () => new Installer(opts), disposer);
}

async function getClient(fn, opts = {}, disposer) {
	return getDisposer(
		fn,
		() =>
			new Client({
				uri: C.getRoot().server.uri,
				...opts
			}),
		disposer
	);
}

async function getLoader(fn, opts = {}, disposer) {
	return getDisposer(
		fn,
		() =>
			new RemoteLoader({
				uri: C.server.uri,
				...opts
			}),
		disposer
	);
}

function getWindow(url, fn) {
	return getDisposer(
		fn,
		async () => {
			const res = await got(url);
			const { window } = new JSDOM(res.body, {
				url,
				runScripts: 'dangerously',
				resources: 'usable'
			});

			await new Promise(resolve => {
				window.addEventListener('load', resolve);
			});

			return window;
		},
		window => window.close()
	);
}

function getExternalRequire(c = C) {
	const { resolve } = new ContextFactory(c);
	// eslint-disable-next-line global-require, import/no-dynamic-require
	return request => require(resolve(request));
}

async function simulateChange(file, c = C) {
	const json = await readJSONAsync(`${c.output}/.__resources__.json`);
	delete json.cache.find(value => value.moduleId.endsWith(file)).sourceChecksum;
	return writeJSONAsync(`${c.output}/.__resources__.json`, json);
}

describe('resolver', () => {
	it('should prefer core modules over installed packages unless otherwise specified', () => {
		const { rootDir } = C;
		// eslint-disable-next-line global-require
		const testPackageJSON = require('../dev/remote-package/package.json');
		assert(
			testPackageJSON.dependencies.assert,
			'Expected remote-package to have assert dependency'
		);
		assert(testPackageJSON.dependencies.util, 'Expected remote-package to have util dependency');
		assert(
			!testPackageJSON.dependencies.path,
			'Expected remote-package to not have path dependency'
		);
		assert(
			resolver
				.resolveSync('assert', { core: { assert: false }, rootDir })
				.includes('node_modules/'),
			'Expected assert to be resolved to installed package'
		);
		assert.equal(
			resolver.resolveSync('assert', { rootDir }),
			'assert',
			'Expected assert to be resolved to core module'
		);
		assert.equal(
			resolver.resolveSync('util', { rootDir }),
			'util',
			'Expected util to be resolved to core module'
		);
		assert.equal(
			resolver.resolveSync('path', { rootDir }),
			'path',
			'Expected path to be resolved to core module'
		);
	});

	it('should traverse lookup paths for local modules', () => {
		const { rootDir } = C;
		assert.deepEqual(resolver.diffPaths(rootDir), [rootDir]);
		assert.deepEqual(resolver.diffPaths(rootDir, `${rootDir}/`), [rootDir]);
	});

	it('should traverse lookup paths for npm modules', () => {
		const baseDir = C.rootDir;
		const target = resolver.resolveSync('react', { baseDir });
		const paths = resolver.diffPaths(baseDir, Path.dirname(target));
		assert.deepEqual(paths, [Path.dirname(target), Path.join(baseDir, 'node_modules'), baseDir]);
	});

	it('should never traverse above rootDir', () => {
		const { rootDir } = C;
		const target = resolver.resolveSync('react', { rootDir });
		const baseDir = Path.dirname(target);
		const paths = resolver.diffPaths(rootDir, baseDir);
		assert.strictEqual(last(paths), rootDir);
		assert.throws(
			() =>
				resolver.resolveSync('react', {
					rootDir,
					isFile: file => {
						assert(file.startsWith(rootDir));
						return false;
					}
				}),
			/Cannot find module/
		);
	});

	it('should traverse nested module directories', () => {
		const { rootDir } = C;
		const baseDir = Path.resolve(C.rootDir, 'node_modules/fbjs/lib');
		const resolvedBasedir = Path.dirname(baseDir);

		const paths = resolver.diffPaths(rootDir, baseDir);

		assert.strictEqual(paths[0], baseDir);
		assert.strictEqual(last(paths), rootDir);

		const existsOnlyTop = resolver.resolveSync('core-js/modules/_a-function', { baseDir, rootDir });
		const existsOnlyNested = resolver.resolveSync('core-js/modules/$.a-function', {
			baseDir,
			rootDir
		});
		const existsBothWithBasedir = resolver.resolveSync('core-js/modules/es6.map', {
			baseDir,
			rootDir
		});
		const existsBothSansBasedir = resolver.resolveSync('core-js/modules/es6.map', { rootDir });

		assert(existsOnlyTop.startsWith(rootDir));
		assert.strictEqual(existsOnlyTop.match(/node_modules\//g).length, 1);
		assert(existsOnlyNested.startsWith(resolvedBasedir));
		assert(existsBothWithBasedir.startsWith(resolvedBasedir));
		assert(existsBothSansBasedir.startsWith(rootDir));
		assert.strictEqual(existsBothSansBasedir.match(/node_modules\//g).length, 1);
	});

	it('should resolve relative requests from local modules', () => {
		const { rootDir } = C;
		const parent = resolver.resolveSync('./foo', { rootDir });
		const baseDir = Path.dirname(parent);
		const relativeRequest = '../package';
		const resolvedRelative = resolver.resolveSync(relativeRequest, { rootDir, baseDir });
		assert.throws(() => resolver.resolveSync(relativeRequest, { rootDir }), /Cannot find module/);
		assert.strictEqual(resolvedRelative, Path.resolve(baseDir, `${relativeRequest}.json`));
	});

	it('should resolve relative requests from npm modules', () => {
		const { rootDir } = C;
		const parent = resolver.resolveSync('core-js/es6/map', { rootDir });
		const baseDir = Path.dirname(parent);
		const relativeRequest = '../modules/es6.map';
		const resolvedRelative = resolver.resolveSync(relativeRequest, { rootDir, baseDir });
		assert.throws(() => resolver.resolveSync(relativeRequest, { rootDir }), /Cannot find module/);
		assert.strictEqual(resolvedRelative, Path.resolve(baseDir, `${relativeRequest}.js`));
	});

	it('should optionally resolve non-standard main fields', () => {
		const { rootDir } = C;
		const browser = resolver.resolveSync('.', { rootDir, mainFields: ['browser', 'main'] });
		const mjs = resolver.resolveSync('.', { rootDir, mainFields: ['module', 'main'] });
		const main = resolver.resolveSync('.', { rootDir, mainFields: ['noexist', 'main'] });
		assert(browser.endsWith('/index.browser.js'), 'Failed to resolve browser field');
		assert(mjs.endsWith('/index.mjs'), 'Failed to resolve module field');
		assert(main.endsWith('/index.js'), 'Failed to resolve main field');
	});
});

describe('ConfigStore', () => {
	it('should populate default options', () => {
		const defaultKeys = Object.keys(ConfigStore.getDefaults());
		const opts = { config: null };
		const c = new ConfigStore(opts);
		const env = process.env.BUILD_ENV || process.env.NODE_ENV;
		const calculatedOpts = ConfigStore.getCalculated(c);

		Object.entries(c).forEach(([key, value]) => {
			switch (true) {
				case key === 'adapters':
					assert.deepEqual(
						value.map(({ adapter }) => adapter),
						c.defaults.adapters.map(({ adapter }) => adapter)
					);
					break;
				case key === 'babel':
					assert.deepEqual(value, {
						...c.defaults.babel,
						envName: process.env.BABEL_ENV || env
					});
					break;
				case key === 'define':
					assert.deepEqual(value, {
						...c.defaults.define,
						'process.env.NODE_ENV': env
					});
					break;
				case key === 'middleware':
					assert.deepEqual(value.map(fn => fn.name), c.defaults[key].map(fn => fn.name));
					break;
				case key === 'outputDir':
					assert.strictEqual(value, Path.resolve(c.output));
					break;
				case key === 'rootDir':
					assert.strictEqual(value, Path.resolve(c.root));
					break;
				case key === 'optimize':
					assert.deepEqual(value, {
						// optimize contains some calculated properties
						...calculatedOpts.optimize,
						...helpers.pickDefined(c.defaults.optimize)
					});
					break;
				case key === 'server':
					assert.deepEqual(value, {
						// server contains some calculated properties
						...calculatedOpts.server,
						...helpers.pickDefined(c.defaults.server),
						static: new Set()
					});
					break;
				case key === 'sourceMaps':
				case key === 'uglify':
					assert.equal(value, calculatedOpts[key]);
					break;
				case Object.hasOwnProperty.call(opts, key):
					assert.deepEqual(value, opts[key]);
					break;
				case defaultKeys.includes(key):
					assert.deepEqual(value, c.defaults[key]);
					break;
				default:
					// noop
					break;
			}
		});
	});

	it('should populate preset options', () => {
		[undefined, 'node', 'browser'].forEach(preset => {
			const c = new ConfigStore({ config: null, preset });
			const presetOpts = ConfigStore.getPreset(preset);
			const calculatedOpts = ConfigStore.getCalculated(c);
			Object.entries(presetOpts).forEach(([key, value]) => {
				switch (true) {
					case key === 'mainFields':
						assert.deepEqual(c.mainFields, [...value, ...c.defaults.mainFields]);
						break;
					case key === 'provide':
						assert.deepEqual(c.provide, value);
						break;
					case key === 'middleware': {
						const middlewareNames = c.middleware.map(fn => fn.name);
						value.forEach(fn => {
							chaiAssert.deepInclude(middlewareNames, fn.name);
						});
						break;
					}
					case typeof value === 'object':
						chaiAssert.deepInclude(c[key], value);
						break;
					case Object.hasOwnProperty.call(calculatedOpts, key):
						// skip calculated properties
						break;
					default:
						assert.equal(c[key], value);
						break;
				}
			});
		});
	});

	it('should create the default scope if none are declared', () => {
		const { defaultScope, symbolFor: Scope } = ConfigStore;
		assert(
			new ConfigStore({ config: null }).scopes().includes(defaultScope),
			'Expected ConfigStore to include default scope'
		);
		assert(
			!new ConfigStore({ config: null, [Scope('other')]: {} })
				.scopes()
				.includes(ConfigStore.defaultScope),
			'Expected ConfigStore to not include default scope'
		);
	});

	it('should extend scopes with the root config', () => {
		const Scope = ConfigStore.symbolFor;

		const opts = {
			a: {
				b: true
			},
			b: [0, 1, 2],
			c: {
				d: [0, 1, 2]
			}
		};

		const c = new ConfigStore({
			[Scope('1')]: {
				a: {
					b: false
				}
			},
			[Scope('2')]: {
				b: [1],
				c: {
					d: [1]
				}
			},
			config: null,
			...opts
		});

		chaiAssert.deepInclude(c.use('1'), {
			...opts,
			a: { b: false }
		});

		chaiAssert.deepInclude(c.use('2'), {
			...opts,
			b: [1, 0, 2],
			c: {
				d: [1, 0, 2]
			}
		});
	});

	it('should populate calculated values', async () => {
		/* eslint-disable no-process-env */
		const Scope = ConfigStore.symbolFor;
		const originalENV = { ...process.env };

		// preset = browser / BUILD_ENV = development / NODE_ENV = production
		await getDisposer(
			c => {
				assert.equal(c.define['process.env.BUILD_ENV'], undefined);
				assert.equal(c.define['process.env.NODE_ENV'], 'development');
				assert.equal(c.sourceMaps, 'inline');
				assert.equal(c.uglify, false);
			},
			() => {
				process.env.BUILD_ENV = 'development';
				process.env.NODE_ENV = 'production';
				return new ConfigStore({ config: null, preset: 'browser' });
			},
			() => Object.assign(process.env, originalENV)
		);

		// preset = browser / BUILD_ENV = '' / NODE_ENV = production
		await getDisposer(
			c => {
				assert.equal(c.define['process.env.BUILD_ENV'], undefined);
				assert.equal(c.define['process.env.NODE_ENV'], 'production');
				assert.equal(c.sourceMaps, true);
				assert.deepEqual(c.uglify, {
					compress: { inline: false, expression: true },
					output: { comments: false },
					sourceMap: true
				});
			},
			() => {
				process.env.BUILD_ENV = '';
				process.env.NODE_ENV = 'production';
				return new ConfigStore({ config: null, preset: 'browser' });
			},
			() => Object.assign(process.env, originalENV)
		);

		// preset = node / BUILD_ENV = production / NODE_ENV = ''
		await getDisposer(
			c => {
				assert.equal(c.define['process.env.BUILD_ENV'], undefined);
				assert.equal(c.define['process.env.NODE_ENV'], 'production');
				assert.equal(c.sourceMaps, 'inline');
				assert.equal(c.uglify, false);
			},
			() => {
				process.env.BUILD_ENV = 'production';
				process.env.NODE_ENV = '';
				return new ConfigStore({ config: null, preset: 'node' });
			},
			() => Object.assign(process.env, originalENV)
		);

		// uglify = true / BUILD_ENV = development
		await getDisposer(
			c => {
				assert.equal(c.define['process.env.BUILD_ENV'], undefined);
				assert.equal(c.define['process.env.NODE_ENV'], 'development');
				assert.equal(c.sourceMaps, 'inline');
				assert.deepEqual(c.uglify, {
					compress: { inline: false, expression: true },
					output: { comments: false },
					sourceMap: true
				});
			},
			() => {
				process.env.BUILD_ENV = 'development';
				return new ConfigStore({ config: null, uglify: true });
			},
			() => Object.assign(process.env, originalENV)
		);

		// uglify = { output: { comments: true } } / BUILD_ENV = development
		await getDisposer(
			c => {
				assert.equal(c.define['process.env.BUILD_ENV'], undefined);
				assert.equal(c.define['process.env.NODE_ENV'], 'development');
				assert.equal(c.sourceMaps, 'inline');
				assert.deepEqual(c.uglify, {
					compress: { inline: false, expression: true },
					output: { comments: true },
					sourceMap: true
				});
			},
			() => {
				process.env.BUILD_ENV = 'development';
				return new ConfigStore({
					config: null,
					uglify: {
						output: { comments: true }
					}
				});
			},
			() => Object.assign(process.env, originalENV)
		);

		// sourceMaps: hidden / uglify = { compress: false } / BUILD_ENV = development
		await getDisposer(
			c => {
				assert.equal(c.define['process.env.BUILD_ENV'], undefined);
				assert.equal(c.define['process.env.NODE_ENV'], 'development');
				assert.equal(c.sourceMaps, 'hidden');
				assert.deepEqual(c.uglify, {
					compress: false,
					output: { comments: false },
					sourceMap: true
				});
			},
			() => {
				process.env.BUILD_ENV = 'development';
				return new ConfigStore({
					config: null,
					sourceMaps: 'hidden',
					uglify: { compress: false }
				});
			},
			() => Object.assign(process.env, originalENV)
		);

		// Scopes
		await getDisposer(
			c => {
				assert.equal(c.define['process.env.BUILD_ENV'], undefined);
				assert.equal(c.define['process.env.NODE_ENV'], 'production');
				assert.equal(c.use('default').sourceMaps, true);
				assert.equal(c.use('override').sourceMaps, false);
				assert.deepEqual(c.use('default').uglify, {
					compress: false,
					output: { comments: false },
					sourceMap: true
				});
				assert.deepEqual(c.use('override').uglify, {
					compress: { inline: false, expression: true },
					output: { comments: false },
					sourceMap: false
				});
			},
			() => {
				process.env.BUILD_ENV = 'production';
				return new ConfigStore({
					config: null,
					uglify: { compress: false },
					[Scope('default')]: {
						preset: 'browser'
					},
					[Scope('override')]: {
						sourceMaps: false,
						uglify: { compress: true }
					}
				});
			},
			() => Object.assign(process.env, originalENV)
		);
		/* eslint-enable no-process-env */
	});
});

describe('ResourceFactory', () => {
	it('should return the same resource given identical requests', () =>
		getResourceFactory(factory => {
			assert.strictEqual(factory('react'), factory('react'));
		}));

	it('should return the same resource given different requests for the same origin', () =>
		getResourceFactory(factory => {
			assert.strictEqual(factory('react'), factory('react/index.js'));
		}));

	it('should cache null resources by request', () =>
		getResourceFactory(factory => {
			assert.notStrictEqual(factory('no-exist'), factory('no-exist/index.js'));
		}));
});

describe('NormalResource', () => {
	it('should pass a placeholder test', () => {});
});

describe('Parser', () => {
	it('should print a formatted frame for syntax errors', () => {
		const sourceRoot = Path.resolve('dev/remote-package/tests/parser');
		return Promise.all(
			['es5.js', 'es6.js', 'jsx.jsx'].map(async file => {
				const parser = createParser(C);
				const slug = `./syntax-error/${file}`;
				const origin = Path.join(sourceRoot, slug);
				const source = await readFileAsync(origin);
				assert.throws(
					() => {
						parser.init(slug, origin, sourceRoot);
						parser.load(source);
					},
					err => {
						const [firstLine] = source.split('\n');
						const cleanMessage = stripAnsi(err.message);
						return (
							cleanMessage.includes(slug) &&
							cleanMessage.includes(firstLine) &&
							cleanMessage.includes(`^ ${err.originalMessage}`)
						);
					}
				);
			})
		);
	});
});

describe('Installer', () => {
	/**
	 * FIXME: ADD A TEST FOR THIS!!
	 * The following commands should be functionally equivalent
	 * assuming there are no provided resources outside of root:
	 * remote-modules install --root dev/remote-package --force
	 * remote-modules install dev/remote-package --config dev/remote-package/.modulerc --force
	 */

	it('should visit each resource exactly once during a fresh install', () =>
		getInstaller(async install => {
			const visited = new Set();
			const main = await install(true, resource => {
				assert(!visited.has(resource.pid), `Expected ${resource.slug} to be visited only once`);
				visited.add(resource.pid);
			});
			assert.equal(visited.size, main.getDeepDependencySet(r => r.isNormal()).size + 1);
		}));

	it('should generate deterministic cache JSON', () =>
		getResourceFactory(async factory => {
			async function getResourceJSONChecksum() {
				const json = await readFileAsync(factory.outputPath);
				return createHash('sha512')
					.update(json)
					.digest('base64');
			}
			const expected = await getResourceJSONChecksum();
			await getInstaller(install => install());
			assert.equal(await getResourceJSONChecksum(), expected);
		}));

	it('should generate deterministic cache JSON (unions)', () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styles')]: {
				entry: 'tests/styles',
				preset: 'node',
				extensions: ['.css', '.less', '.sass', '.scss'],
				middleware: [UnionMiddleware()]
			}
		}).use('tests/styles');

		return getResourceFactory(async factory => {
			async function getResourceJSONChecksum() {
				const json = await readFileAsync(factory.outputPath);
				return createHash('sha512')
					.update(json)
					.digest('base64');
			}
			await getInstaller(install => install(true), c);
			const expected = await getResourceJSONChecksum();
			await getInstaller(install => install(), c);
			assert.equal(await getResourceJSONChecksum(), expected);
		}, c);
	});

	it('should generate deterministic JSON modules', async () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/json-modules')]: {
				entry: 'tests/json-modules'
			}
		}).use('tests/json-modules');

		async function getResourceChecksum(slug) {
			const factory = await getResourceFactory(identity, c);
			const { modules } = await factory.getResourceJSON();
			const path = Path.join(Path.dirname(factory.outputPath), modules[slug]);
			const content = await readFileAsync(path);
			return createHash('sha512')
				.update(content)
				.digest('base64');
		}

		const checksum1 = await getInstaller(async install => {
			await install(true);
			return getResourceChecksum('tests/json-modules/test.json');
		}, c);

		// Modify c so the options checksum changes
		c.foo = 'bar';

		const checksum2 = await getInstaller(async install => {
			await install();
			return getResourceChecksum('tests/json-modules/test.json');
		}, c);

		assert.equal(checksum2, checksum1);
	});

	it('should not visit any resources when installing completely from cache', () =>
		getInstaller(install =>
			install(false, resource => {
				assert.fail(`Expected ${resource.slug} to not be visited`);
			})
		));

	it('should not visit any resources when installing completely from cache (unions)', () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styles')]: {
				entry: 'tests/styles',
				preset: 'node',
				extensions: ['.css', '.less', '.sass', '.scss'],
				middleware: [UnionMiddleware()]
			}
		}).use('tests/styles');

		return getInstaller(async install => {
			await install(true);
			return install(false, resource => {
				assert.fail(`Expected ${resource.slug} to not be visited`);
			});
		}, c);
	});

	it('should hydrate the full dependency tree when installing from cache', async () => {
		const freshCount = await getInstaller(
			async install => (await install(true)).getDeepDependencySet().size + 1
		);
		const freshJSONCount = await getResourceFactory(
			async factory => (await factory.getResourceJSON()).cache.length
		);
		const cachedCount = await getInstaller(
			async install => (await install()).getDeepDependencySet().size + 1
		);
		const cachedJSONCount = await getResourceFactory(
			async factory => (await factory.getResourceJSON()).cache.length
		);
		assert.equal(freshCount, freshJSONCount);
		assert.equal(freshCount, cachedCount);
		assert.equal(freshCount, cachedJSONCount);
	});

	it('should hydrate the full dependency tree when installing from cache (unions)', async () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styles')]: {
				entry: 'tests/styles',
				preset: 'node',
				extensions: ['.css', '.less', '.sass', '.scss'],
				middleware: [UnionMiddleware()]
			}
		}).use('tests/styles');

		const freshCount = await getInstaller(
			async install => (await install(true)).getDeepDependencySet().size + 1,
			c
		);
		const freshJSONCount = await getResourceFactory(
			async factory => (await factory.getResourceJSON()).cache.length,
			c
		);
		const cachedCount = await getInstaller(
			async install => (await install()).getDeepDependencySet().size + 1,
			c
		);
		const cachedJSONCount = await getResourceFactory(
			async factory => (await factory.getResourceJSON()).cache.length,
			c
		);

		assert.equal(freshCount, freshJSONCount);
		assert.equal(freshCount, cachedCount);
		assert.equal(freshCount, cachedJSONCount);
	});

	it('should run a partial install on changed files', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests')]: {
				entry: 'tests'
			}
		}).use('tests');

		return getInstaller(async install => {
			const main = await install(true);
			await simulateChange('node-env.js', c);

			let installCount = 0;

			main.resourceFactory.uncache();

			await install(false, () => {
				installCount += 1;
			});

			assert.equal(installCount, 2);
		}, c);
	});

	it('should run a partial install on changed files (unions)', () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styles')]: {
				entry: 'tests/styles',
				preset: 'node',
				extensions: ['.css', '.less', '.sass', '.scss'],
				middleware: [UnionMiddleware()]
			}
		}).use('tests/styles');

		return getInstaller(async install => {
			const main = await install(true);
			await simulateChange('less-as-css.less', c);

			let installCount = 0;

			main.resourceFactory.uncache();

			await install(false, () => {
				installCount += 1;
			});

			assert.equal(installCount, 3);
		}, c);
	});

	it('should not include core modules in the manifest', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/core')]: {
				entry: 'tests/core'
			}
		}).use('tests/core');
		return getServer(async server => {
			await server.install();
			return getLoader(
				async loader => {
					const { manifest } = await loader.load();
					manifest.list().forEach(moduleId => {
						assert(!resolver.isCore(moduleId), 'Expected manifest to not include core modules');
					});
				},
				{ uri: c.server.uri }
			);
		}, c);
	});

	it('should not include external modules in the manifest', () => {
		const { ExternalMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests')]: {
				entry: 'tests',
				middleware: [ExternalMiddleware(ctx => ctx.moduleId.startsWith('lodash.memoize/'))]
			}
		}).use('tests');

		return getServer(async server => {
			await server.install();
			const externalRequire = getExternalRequire(c);
			return getLoader(
				async loader => {
					const { manifest } = await loader.load();
					const externalObject = loader.require('./tests/external.js');
					const externalModule = loader.loadSync(externalObject.request);
					assert.equal(externalModule.external, true);
					assert.strictEqual(externalObject.exports, externalRequire(externalObject.request));
					assert(
						!manifest.exists(externalModule.id),
						'Expected manifest to not include external modules'
					);
				},
				{
					externalRequire,
					uri: c.server.uri
				}
			);
		}, c);
	});

	it("should always add a module's package info to its manifest", () =>
		getServer(async server => {
			await server.install();
			return getLoader(async loader => {
				const { manifest } = await loader.load();
				manifest.list().forEach(moduleId => {
					if (!moduleId.endsWith('package.json')) {
						const packageId = getPackageId(moduleId, C.moduleDirs);
						const module = loader.loadSync(moduleId);
						if (!module.external) {
							assert(
								module.manifest.package(packageId),
								`expected ${packageId} to exist (from ${module.id})`
							);
						}
					}
				});
			});
		}));

	it('should handle circular dependencies', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/circular')]: {
				entry: 'tests/circular'
			}
		}).use('tests/circular');

		return getServer(async server => {
			await server.install();
			return getLoader(
				async loader => {
					const module = await loader.load();
					const list = module.manifest.list();
					assert.equal(new Set(list).size, list.length, 'Expected manifest.list() to be unique');
					module.exec();
				},
				{ uri: c.server.uri }
			);
		}, c);
	});

	it('should handle circular dependencies (unions)', () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/circular')]: {
				entry: 'tests/circular',
				middleware: [UnionMiddleware()]
			}
		}).use('tests/circular');

		return getServer(async server => {
			await server.install();
			return getLoader(
				async loader => {
					const module = await loader.load();
					const list = module.manifest.list();
					assert.equal(new Set(list).size, list.length, 'Expected manifest.list() to be unique');
					module.exec();
				},
				{ uri: c.server.uri }
			);
		}, c);
	});

	it('should honor babelrc hierarchy', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/relay')]: {
				entry: 'tests/relay'
			}
		}).use('tests/relay');

		return getServer(async server => {
			await server.install();
			return getLoader(
				async () => {
					const source = await readFileAsync(`${c.outputDir}/${c.entry}/index.jsx.js`);
					const ast = babylon.parse(source, c.babylon);
					const result = new ASTQ().query(ast, '// * [ @async == true ]');
					assert(result.length > 0, 'Expected compiled output to contain async functions');
				},
				{ uri: c.server.uri }
			);
		}, c);
	});

	it('should gracefully drop null resources when strict = false', () => {
		const { NullMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/null-resources')]: {
				entry: 'tests/null-resources',
				middleware: [NullMiddleware(/^react$/)]
			}
		}).use('tests/null-resources');

		async function assertions(loader) {
			const nullResources = await loader.import();
			const { manifest } = loader.loadSync();
			assert.throws(nullResources, /Cannot find module/);
			assert.deepEqual(manifest.list(), []);
		}

		return getServer(async server => {
			// fresh install
			await server.install(true);
			await getLoader(assertions, { uri: c.server.uri });

			// cached install
			await server.install();
			await getLoader(assertions, { uri: c.server.uri });
		}, c);
	});

	it('should throw on null resources when strict = true', () => {
		const { NullMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/null-resources')]: {
				entry: 'tests/null-resources',
				middleware: [NullMiddleware(/^react$/)],
				strict: true
			}
		}).use('tests/null-resources');

		return getInstaller(async install => {
			let error;
			try {
				await install(true);
			} catch (err) {
				error = err;
			}
			assert.equal(error.code, 'MODULE_NOT_FOUND');
		}, c);
	});

	it('should NOT throw on resources matched by NullMiddleware when strict = true', async () => {
		const { NullMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/null-resources')]: {
				entry: 'tests/null-resources',
				middleware: [NullMiddleware(ctx => ctx.packageId !== '.')],
				strict: true
			}
		}).use('tests/null-resources');

		// fresh install
		await getInstaller(install => install(true), c);

		// cached install
		await getInstaller(install => install(), c);
	});

	it('should evaluate require.resolve', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/require.resolve')]: {
				entry: 'tests/require.resolve'
			}
		}).use('tests/require.resolve');

		async function assertions(loader) {
			const requireResolve = await loader.import();
			const entryModule = await loader.load();
			return Promise.all(
				Object.entries(requireResolve).map(async ([request, fn]) => {
					if (request === 'no-exist') {
						assert.throws(fn, /Cannot find module/);
					} else {
						const formatted = helpers.isRelativePath(request)
							? `./${Path.join(Path.dirname(c.entry), request)}`
							: request;
						const { moduleId: expected } = await loader.resolveAsync(formatted, entryModule);
						assert(!/\.resolve\(/.test(String(fn)), 'Expected require.resolve to be evaluated');
						assert.equal(fn(), expected);
					}
				})
			);
		}

		return getServer(async server => {
			// fresh install
			await server.install(true);
			await getLoader(assertions, { uri: c.server.uri });

			// cached install
			await server.install();
			await getLoader(assertions, { uri: c.server.uri });
		}, c);
	});

	it('should evaluate defined values', () => {
		const r = Math.random();
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests')]: {
				entry: 'tests',
				define: {
					'process.browser': true,
					'process.env.BUILD_ENV': 'production',
					'process.config.variables.someNonExistentVar': r,
					'global.INCLUDE_LODASH_UNION': true
				}
			}
		}).use('tests');

		return getServer(async server => {
			await server.install();
			return getLoader(
				async loader => {
					const { define, nodeEnv } = await loader.import();
					assert.notEqual(nodeEnv, ConfigStore.getEnv());
					assert.equal(nodeEnv, 'production');
					assert.equal(define.replace, r);
					assert.strictEqual(define.eval, loader.require('lodash.union/index.js'));
				},
				{ uri: c.server.uri }
			);
		}, c);
	});

	it('should inject provided values only when referenced', () => {
		const provide = {
			normal: 'import normal from "./node-env"',
			external: 'import { inspect as external } from "util"',
			reference: 'setTimeout',
			numericLiteral: Math.random(),
			booleanLiteral: true,
			stringLiteral: JSON.stringify('This is a string with spaces')
		};

		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/provide')]: {
				entry: 'tests/provide',
				provide: {
					...ConfigStore.getPreset('browser').provide,
					...provide
				}
			}
		}).use('tests/provide');

		const externalRequire = getExternalRequire(c);

		async function assertions(loader) {
			const getProvided = await loader.import();
			Object.entries(getProvided()).forEach(([key, value]) => {
				switch (key) {
					case 'normal': {
						const formatted = `./${Path.join(Path.dirname(c.entry), './node-env.js')}`;
						assert.equal(value, loader.require(formatted));
						break;
					}
					case 'external':
						assert.equal(value, loader.require('util').inspect);
						break;
					case 'reference':
					case 'stringLiteral':
						// eslint-disable-next-line no-eval
						assert.equal(value, eval(provide[key]));
						break;
					default:
						assert.equal(value, provide[key]);
						break;
				}
			});
		}

		return getServer(async server => {
			// fresh install
			await server.install(true);
			await getLoader(assertions, {
				externalRequire,
				uri: c.server.uri
			});

			// cached install
			await server.install();
			await getLoader(assertions, {
				externalRequire,
				uri: c.server.uri
			});
		}, c);
	});

	it('should evaluate and remove dead code', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/dead-code')]: {
				entry: 'tests/dead-code',
				preset: 'node',
				define: {
					'process.env.BUILD_ENV': 'production'
				},
				mainFields: ['module'],
				uglify: false
			}
		}).use('tests/dead-code');

		async function assertions(loader) {
			const { assignedExports, maybeRequireLater, removed } = await loader.import();
			const { manifest } = loader.loadSync();
			assert.strictEqual(assignedExports, await loader.import('isomorphic-fetch'));
			// FIXME: should be able to just call loader.import('universal-router')
			assert.strictEqual(maybeRequireLater(), await loader.import('universal-router/main.mjs'));
			manifest.list().forEach(moduleId => {
				removed.forEach(value => {
					assert(!moduleId.includes(value), `Expected manifest to not include ${value}`);
				});
			});
		}

		return getServer(async server => {
			// fresh install
			await server.install(true);
			await getLoader(assertions, { uri: c.server.uri });

			// cached install
			await server.install();
			await getLoader(assertions, { uri: c.server.uri });
		}, c);
	});

	it('should recursively evaluate middleware to resolve the final request', () => {
		const { ExternalMiddleware, RewriteMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/rewrite')]: {
				entry: 'tests/rewrite',
				core: {
					assert: false,
					util: false
				},
				middleware: [
					ExternalMiddleware(/^(path|util)/),
					RewriteMiddleware(/^rewrite-core$/, () => 'rewrite-core-1'),
					RewriteMiddleware(/^rewrite-core-1$/, () => 'rewrite-core-2'),
					RewriteMiddleware(/^rewrite-core-2$/, () => 'path'),
					RewriteMiddleware(/^rewrite-installed$/, () => 'rewrite-installed-1'),
					RewriteMiddleware(/^rewrite-installed-1$/, () => 'rewrite-installed-2'),
					RewriteMiddleware(/^rewrite-installed-2$/, () => 'assert'),
					RewriteMiddleware(/^rewrite-installed-external$/, () => 'rewrite-installed-external-1'),
					RewriteMiddleware(/^rewrite-installed-external-1$/, () => 'rewrite-installed-external-2'),
					RewriteMiddleware(/^rewrite-installed-external-2$/, () => 'util')
				]
			}
		}).use('tests/rewrite');

		const externalRequire = getExternalRequire(c);

		async function assertions(loader) {
			const getRewrites = await loader.import();
			const rewrites = getRewrites();
			// eslint-disable-next-line global-require
			assert.strictEqual(rewrites.path, require('path'));
			assert.strictEqual(rewrites.util, externalRequire('util'));
			// eslint-disable-next-line global-require
			assert.notStrictEqual(rewrites.util, require('util'));
			assert.notStrictEqual(rewrites.assert, externalRequire('assert'));
		}

		return getServer(async server => {
			// fresh install
			await server.install(true);
			await getLoader(assertions, {
				externalRequire,
				uri: c.server.uri
			});

			// cached install
			await server.install();
			await getLoader(assertions, {
				externalRequire,
				uri: c.server.uri
			});
		}, c);
	});

	it('should transform dynamic imports', async () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			entry: 'tests/dynamic-imports',
			[ConfigStore.symbolFor('native')]: {
				babel: {
					babelrc: false
				}
			},
			[ConfigStore.symbolFor('fast-async')]: {
				babel: {
					presets: [
						[
							require.resolve('../dev/remote-package/node_modules/@babel/preset-env'),
							{
								exclude: [
									// use fast-async instead
									'transform-async-to-generator',
									'transform-regenerator'
								],
								modules: false,
								targets: {
									browsers: ['safari 8']
								}
							}
						]
					],
					plugins: [
						[require.resolve('../dev/remote-package/node_modules/fast-async'), { spec: true }]
					]
				}
			}
		});

		async function assertions(loader) {
			const dynamicImports = await loader.import();
			const { manifest } = await loader.load();
			assert(!manifest.exists('./import.js'), 'Expected manifest to not include ./import.js');
			assert(
				!manifest.exists(
					'./system.import.js',
					'Expected manifest to not include ./system.import.js'
				)
			);
			assert.notEqual(dynamicImports.import, 'import');
			assert.notEqual(dynamicImports.importExpression, 'import');
			assert.notEqual(dynamicImports.system, 'System.import');
			assert.equal(await dynamicImports.import, 'import');
			assert.equal(await dynamicImports.importExpression, 'import');
			assert.equal(await dynamicImports.system, 'System.import');
		}

		// native async await
		await getServer(async server => {
			await server.install();
			return getLoader(
				async loader => {
					await assertions(loader);
					const source = await readFileAsync(`${c.use('native').outputDir}/${c.entry}/index.js`);
					const ast = babylon.parse(source, c.babylon);
					const result = new ASTQ().query(ast, '// * [ @async == true ]');
					assert(result.length > 0, 'Expected compiled output to contain async functions');
				},
				{ uri: c.use('native').server.uri }
			);
		}, c.use('native'));

		// transformed async await
		await getServer(async server => {
			await server.install();
			return getLoader(
				async loader => {
					await assertions(loader);
					const source = await readFileAsync(
						`${c.use('fast-async').outputDir}/${c.entry}/index.js`
					);
					const ast = babylon.parse(source, c.babylon);
					const result = new ASTQ().query(ast, '// * [ @async == true ]');
					assert(result.length === 0, 'Expected compiled output to not contain async functions');
				},
				{ uri: c.use('fast-async').server.uri }
			);
		}, c.use('fast-async'));
	});

	it('should support styled-components', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styled-components')]: {
				entry: 'tests/styled-components',
				preset: 'node',
				define: {
					'process.env.NODE_ENV': 'production'
				}
			}
		}).use('tests/styled-components');

		return getServer(async server => {
			await server.install();
			return getLoader(
				async loader => {
					const { default: rendered } = await loader.import();
					const expectedPartial = 'class="image styled-components__StyledImage-';
					assert(
						rendered.includes(expectedPartial),
						`Expected '${rendered}' to include '${expectedPartial}'`
					);
				},
				{ uri: c.server.uri }
			);
		}, c);
	});

	it('should support typescript', async () => {
		const configVariants = [
			{
				uglify: {
					output: {
						beautify: true
					}
				}
			},
			{
				optimize: {
					deadCode: false
				}
			},
			{
				env: 'production'
			},
			{
				babel: {
					presets: [
						[
							Path.resolve('dev/remote-package/node_modules/@babel/preset-env'),
							{
								modules: false,
								targets: {
									node: 'current'
								},
								useBuiltIns: 'usage'
							}
						]
					]
				}
			}
		];

		for (const variant of configVariants) {
			const { ScriptAdapter } = ConfigStore.adapters;
			const c = new ConfigStore({
				...baseInstallerOptions,
				[ConfigStore.symbolFor('tests/typescript')]: {
					entry: 'tests/typescript',
					preset: 'node',
					adapters: [
						{
							test: ({ extension }) => /\.tsx?$/.test(extension),
							adapter: ScriptAdapter
						}
					],
					babylon: {
						plugins: ['typescript']
					},
					extensions: ['.ts', '.tsx'],
					...variant
				}
			}).use('tests/typescript');

			// eslint-disable-next-line no-await-in-loop
			await getServer(async server => {
				await server.install();
				return getLoader(
					async loader => {
						const $ = cheerio.load(await loader.import());
						assert.equal($('.Stateful').length, 1);
						assert.equal($('.Stateless').length, 1);
					},
					{ uri: c.server.uri }
				);
			}, c);
		}
	});

	it('should support source maps', async () => {
		const resourceIds = [
			'tests/source-maps/index.jsx',
			'tests/source-maps/data.json',
			'tests/source-maps/styles.css',
			'tests/source-maps/styles.less',
			'tests/source-maps/styles.sass',
			'tests/source-maps/styles.scss',
			'node_modules/react/index.js',
			'node_modules/slick-carousel/slick/slick-theme.css',
			'node_modules/slick-carousel/slick/slick-theme.less',
			'node_modules/slick-carousel/slick/slick-theme.scss'
		];

		const configVariants = [
			{
				variant: null,
				assertions: async (server, loader) => {
					await Promise.all(
						resourceIds.map(async resourceId => {
							const resourceURL = loader.getResourceURLFromID(resourceId);
							const sourceMapURL = `${resourceURL}.map`;
							const { body } = await got(resourceURL);
							try {
								await got(sourceMapURL);
							} catch (_err) {
								// noop
							}
							assert(
								body.includes('# sourceMappingURL=data:'),
								`Expected '${resourceId}' to include inline source map`
							);
							assert.equal(body.match(/# sourceMappingURL=/g).length, 1);
						})
					);
					assert.equal(server.statusCounts.get(200), resourceIds.length);
					assert.equal(server.statusCounts.get(404), resourceIds.length);
				}
			},
			{
				variant: { sourceMaps: false },
				assertions: async (server, loader) => {
					await Promise.all(
						resourceIds.map(async resourceId => {
							const resourceURL = loader.getResourceURLFromID(resourceId);
							const sourceMapURL = `${resourceURL}.map`;
							const { body } = await got(resourceURL);
							try {
								await got(sourceMapURL);
							} catch (_err) {
								// noop
							}
							assert(
								!body.includes('# sourceMappingURL='),
								`Expected '${resourceId}' to not include source map url`
							);
						})
					);
					assert.equal(server.statusCounts.get(200), resourceIds.length);
					assert.equal(server.statusCounts.get(404), resourceIds.length);
				}
			},
			{
				variant: { sourceMaps: true },
				assertions: async (server, loader) => {
					await Promise.all(
						resourceIds.map(async resourceId => {
							const resourceURL = loader.getResourceURLFromID(resourceId);
							const sourceMapURL = `${resourceURL}.map`;
							const { body } = await got(resourceURL);
							await got(sourceMapURL);
							assert(
								body.includes(`# sourceMappingURL=${sourceMapURL}`),
								`Expected '${resourceId}' to include source map url`
							);
							assert.equal(body.match(/# sourceMappingURL=/g).length, 1);
						})
					);
					assert.equal(server.statusCounts.get(200), resourceIds.length * 2);
					assert.equal(server.statusCounts.get(404), undefined);
				}
			},
			{
				variant: { sourceMaps: 'hidden' },
				assertions: async (server, loader) => {
					await Promise.all(
						resourceIds.map(async resourceId => {
							const resourceURL = loader.getResourceURLFromID(resourceId);
							const sourceMapURL = `${resourceURL}.map`;
							const { body } = await got(resourceURL);
							assert(
								!body.includes('# sourceMappingURL='),
								`Expected '${resourceId}' to not include source map url`
							);
							await got(sourceMapURL);
						})
					);
					assert.equal(server.statusCounts.get(200), resourceIds.length * 2);
					assert.equal(server.statusCounts.get(404), undefined);
				}
			},
			{
				variant: {
					middleware: [
						// FIXME: Source maps are incompatible with unions
						// see https://github.com/bernardmcmanus/remote-modules/issues/26
						ConfigStore.middleware.UnionMiddleware()
					]
				},
				assertions: async (server, loader) => {
					await Promise.all(
						resourceIds.map(async resourceId => {
							const resourceURL = loader.getResourceURLFromID(resourceId);
							const { body } = await got(resourceURL);
							assert(
								!body.includes('# sourceMappingURL='),
								`Expected '${resourceId}' to not include source map url`
							);
						})
					);
					assert.equal(server.statusCounts.get(200), resourceIds.length);
					assert.equal(server.statusCounts.get(404), undefined);
				}
			}
		];

		configVariants.push(
			...configVariants.map(({ variant, assertions }) => ({
				get variant() {
					return { ...variant, uglify: true };
				},
				get assertions() {
					return assertions;
				}
			}))
		);

		for (const { variant, assertions } of configVariants) {
			const c = new ConfigStore({
				...baseInstallerOptions,
				[ConfigStore.symbolFor('tests/source-maps')]: {
					entry: 'tests/source-maps',
					...variant
				}
			}).use('tests/source-maps');

			// eslint-disable-next-line no-await-in-loop
			await getServer(async server => {
				await server.install(true);
				return getLoader(loader => assertions(server, loader), { uri: c.server.uri });
			}, c);
		}
	});

	it('should apply environment-based babel transforms', () => {
		const { NullMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styled-components')]: {
				entry: 'tests/styled-components',
				preset: 'node',
				babel: {
					envName: 'production'
				},
				define: {
					'process.env.NODE_ENV': 'production'
				},
				middleware: [NullMiddleware(/^react-helmet$/), NullMiddleware(/^styled-components$/)]
			}
		}).use('tests/styled-components');

		return getServer(async server => {
			await server.install();
			return getLoader(
				async loader => {
					const { manifest } = await loader.load();
					// prop-types should be removed by a production transform
					assert(
						!manifest.exists('prop-types/index.js'),
						"Expected 'prop-types/index.js' to not exist"
					);
				},
				{ uri: c.server.uri }
			);
		}, c);
	});

	it('should gracefully handle removed dependencies when installing from cache', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/cached-install')]: {
				entry: 'tests/cached-install'
			}
		}).use('tests/cached-install');

		return getDisposer(
			() =>
				getServer(async server => {
					// fresh install
					const [mainResource] = await server.install(true);

					await getLoader(
						async loader => {
							const mainModule = await loader.load();
							assert(
								mainModule.manifest.exists(`./${c.entry}/asdf.js`),
								`Expected resource './${c.entry}/asdf.js' to exist`
							);
						},
						{ uri: c.server.uri }
					);

					await rimrafAsync(`${c.entryDir}/asdf.js`);

					mainResource.contextFactory.uncache();
					mainResource.resourceFactory.uncache();

					// FIXME: Why??
					await new Promise(resolve => setTimeout(resolve, 1000));

					// cached install
					let callCount = 0;
					await server.install(false, () => {
						callCount += 1;
					});

					assert.equal(callCount, 1);

					return getLoader(
						async loader => {
							const mainModule = await loader.load();
							assert(
								!mainModule.manifest.exists(`./${c.entry}/asdf.js`),
								`Expected resource './${c.entry}/asdf.js' to not exist`
							);

							let error;
							try {
								await loader.import();
							} catch (err) {
								error = err;
							}
							assert.equal(error.message, "Cannot find module './asdf'");
							assert(!loader.context[`pid:${calculatePID(`./${c.entry}/asdf.js`)}`]);
						},
						{ uri: c.server.uri }
					);
				}, c),
			() => writeFileAsync(`${c.entryDir}/asdf.js`, 'module.exports = "asdf";\n'),
			() => rimrafAsync(`${c.entryDir}/asdf.js`)
		);
	});

	it('should gracefully handle removed dependencies when installing from cache (unions)', () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/cached-install/unions')]: {
				entry: 'tests/cached-install',
				middleware: [UnionMiddleware()]
			}
		}).use('tests/cached-install/unions');

		return getDisposer(
			() =>
				getServer(async server => {
					// fresh install
					const [mainResource] = await server.install(true);

					await getLoader(
						async loader => {
							const mainModule = await loader.load();
							assert(
								mainModule.manifest.exists(`./${c.entry}/asdf.js`),
								`Expected resource './${c.entry}/asdf.js' to exist`
							);
						},
						{ uri: c.server.uri }
					);

					await rimrafAsync(`${c.entryDir}/asdf.js`);

					mainResource.contextFactory.uncache();
					mainResource.resourceFactory.uncache();

					// FIXME: Why??
					await new Promise(resolve => setTimeout(resolve, 1000));

					// cached install
					let callCount = 0;
					await server.install(false, () => {
						callCount += 1;
					});

					assert.equal(callCount, 1);

					return getLoader(
						async loader => {
							const mainModule = await loader.load();
							assert(
								!mainModule.manifest.exists(`./${c.entry}/asdf.js`),
								`Expected resource './${c.entry}/asdf.js' to not exist`
							);

							let error;
							try {
								await loader.import();
							} catch (err) {
								error = err;
							}
							assert.equal(error.message, "Cannot find module './asdf'");
							assert(!loader.context[`pid:${calculatePID(`./${c.entry}/asdf.js`)}`]);
						},
						{ uri: c.server.uri }
					);
				}, c),
			() => writeFileAsync(`${c.entryDir}/asdf.js`, 'module.exports = "asdf";\n'),
			() => rimrafAsync(`${c.entryDir}/asdf.js`)
		);
	});
});

describe('Server', () => {
	it('should send moduleId, pid, and resource type in the response headers', () =>
		getServer(async server => {
			await server.install();
			return getLoader(async loader => {
				const { manifest } = await loader.load();
				return Promise.all(
					manifest.list().map(async moduleId => {
						const request = moduleId.replace(Path.extname(moduleId), '');
						const url = loader.getResourceURLFromID(request);
						const { headers } = await loader.fetch(url);
						assert.strictEqual(headers['x-module-id'], moduleId);
						assert.strictEqual(Number(headers['x-pointer-id']), manifest.getPid(moduleId));
						assert.strictEqual(headers['x-resource-type'], manifest.getType(moduleId));
					})
				);
			});
		}));

	it('should respond with a 404 if the requested module does not exist', () =>
		getServer(async server => {
			await server.install();
			return getLoader(async loader => {
				const url = loader.getResourceURLFromID('no-exist');
				const res = await loader.fetch(url);
				assert.equal(res.status, 404);
			});
		}));

	it('should load static assets from the first scope where they exist', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/request-attributes/node')]: {
				entry: 'tests/request-attributes',
				preset: 'node',
				extensions: ['.css', '.less']
			},
			[ConfigStore.symbolFor('tests/request-attributes/browser')]: {
				entry: 'tests/request-attributes',
				preset: 'browser',
				extensions: ['.css', '.less'],
				server: {
					static: ['dist/client.browser.js?(.map)']
				}
			}
		});

		return getServer(async server => {
			await server.install();

			// sanity check
			let error;
			await got(
				`${
					c.use('tests/request-attributes/browser').server.uri
				}/_/:./tests/request-attributes/images/static.gif`
			);
			try {
				await got(
					`${
						c.use('tests/request-attributes/node').server.uri
					}/_/:./tests/request-attributes/images/static.gif`
				);
			} catch (err) {
				error = err;
			}
			assert.equal(error.statusCode, 404);
			server.statusCounts.clear();

			await getWindow(
				`${c.use('tests/request-attributes/browser').server.uri}/browser?auto=false`,
				async window => window.client.import(window.IMPORT_REQUEST)
			);

			await getLoader(
				async loader => {
					const html = await loader.import();
					[loader.resolveURL('./tests/request-attributes/images/dynamic/')].forEach(value => {
						assert(html.includes(value), `Expected html to include '${value}'`);
					});

					const { body: css } = await got(
						loader.resolveURL('./tests/request-attributes/styles.css')
					);
					[
						Url.parse(loader.resolveURL('./tests/request-attributes/images/stylesheet-href.gif'))
							.pathname,
						'/@static/tests/request-attributes/images/stylesheet-static.gif'
					].forEach(value => {
						assert(css.includes(value), `Expected css to include '${value}'`);
					});
				},
				{
					uri: c.use('tests/request-attributes/node').server.uri
				}
			);
			assert.equal(server.statusCounts.get(302), undefined);
			assert.equal(server.statusCounts.get(404), undefined);
		}, c);
	});
});

describe('Watcher', () => {
	async function alterWatchedFile({ watcher }, fn) {
		await new Promise(resolve => setTimeout(resolve, watcher.options.interval));
		return fn();
	}

	it('should watch the dependency tree for changes', async () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);
		const counts = new WeakMap();

		return getServer(async server => {
			const [main] = await server.install(false, resource => {
				if (!counts.has(resource)) {
					counts.set(resource, 0);
				}
				counts.set(resource, counts.get(resource) + 1);
			});
			await alterWatchedFile(server, async () =>
				writeFileAsync(main.origin, await readFileAsync(main.origin))
			);
			await new Promise(resolve => server.watcher.once('update', resolve));
			assert.equal(counts.get(main), 2);
		}, c);
	});

	it('should watch the dependency tree for changes (unions)', async () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				middleware: [UnionMiddleware()],
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);
		const counts = new WeakMap();

		return getServer(async server => {
			const [main] = await server.install(false, resource => {
				if (!counts.has(resource)) {
					counts.set(resource, 0);
				}
				counts.set(resource, counts.get(resource) + 1);
			});
			await alterWatchedFile(server, async () =>
				writeFileAsync(main.origin, await readFileAsync(main.origin))
			);
			await new Promise(resolve => server.watcher.once('update', resolve));
			assert.equal(counts.get(main), 2);
		}, c);
	});

	it('should only watch resources in the dependency tree', async () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);
		let count = 0;

		return getServer(async server => {
			const [main] = await server.install(false, () => {
				count += 1;
			});

			const lastResource = last([...main.getDeepDependencySet()]);

			await alterWatchedFile(server, async () =>
				writeFileAsync(
					Path.join(lastResource.getOriginDir(), 'react.js'),
					await readFileAsync(Path.join(lastResource.getOriginDir(), 'react.js'))
				)
			);

			await new Promise(resolve => setTimeout(resolve, 200));

			assert.equal(count, main.getDeepDependencySet().size + 1);
		}, c);
	});

	it('should only watch resources in the dependency tree (unions)', async () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				middleware: [UnionMiddleware()],
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);
		let count = 0;

		return getServer(async server => {
			const [main] = await server.install(false, () => {
				count += 1;
			});

			const lastResource = last([...main.getDeepDependencySet()]);

			await alterWatchedFile(server, async () =>
				writeFileAsync(
					Path.join(lastResource.getOriginDir(), 'react.js'),
					await readFileAsync(Path.join(lastResource.getOriginDir(), 'react.js'))
				)
			);

			await new Promise(resolve => setTimeout(resolve, 200));

			assert.equal(count, main.getDeepDependencySet().size + 1);
		}, c);
	});

	it('should propagate changes up the dependency tree', async () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);

		return getServer(async server => {
			let main = null;
			let lastResource = null;
			let count = 0;

			[main] = await server.install(false, resource => {
				if (main && resource !== main) {
					count += 1;
				}
			});

			const dependencyArray = [...main.getDeepDependencySet()];
			const [firstResource] = dependencyArray;

			lastResource = last(dependencyArray);

			await alterWatchedFile(server, async () =>
				writeFileAsync(lastResource.origin, await readFileAsync(lastResource.origin))
			);

			await new Promise(resolve => server.watcher.once('update', resolve));

			assert.equal(count, firstResource.getDeepDependencySet().size + 1);
		}, c);
	});

	it('should propagate changes up the dependency tree (unions)', async () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				middleware: [UnionMiddleware()],
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);

		return getServer(async server => {
			let main = null;
			let lastResource = null;
			let count = 0;

			[main] = await server.install(false, resource => {
				if (main && resource !== main) {
					count += 1;
				}
			});

			const dependencyArray = [...main.getDeepDependencySet()];
			const [firstResource] = dependencyArray;

			lastResource = last(dependencyArray);

			await alterWatchedFile(server, async () =>
				writeFileAsync(lastResource.origin, await readFileAsync(lastResource.origin))
			);

			await new Promise(resolve => server.watcher.once('update', resolve));

			assert.equal(count, firstResource.getDeepDependencySet().size + 1);
		}, c);
	});

	it('should watch dynamically added resources', async () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);

		return getServer(async server => {
			const addedResourcePath = Path.join(c.entryDir, './dir/dir/dir/react.js');
			const changedResourcePath = Path.join(c.entryDir, './dir/dir/dir/index.js');
			const changedResourceSource = await readFileAsync(changedResourcePath);
			const counts = new WeakMap();

			const [main] = await server.install(false, resource => {
				if (!counts.has(resource)) {
					counts.set(resource, 0);
				}
				counts.set(resource, counts.get(resource) + 1);
			});

			return alterWatchedFile(server, () =>
				getDisposer(
					async () => {
						await new Promise(resolve => server.watcher.once('update', resolve));

						const dependencyArray = [...main.getDeepDependencySet()];
						const addedResource = dependencyArray.find(
							({ origin }) => origin === addedResourcePath
						);

						assert(addedResource, `Expected ${addedResourcePath} to be in dependency tree`);

						await alterWatchedFile(server, () =>
							writeFileAsync(addedResource.origin, addedResource.source)
						);

						await new Promise(resolve => server.watcher.once('update', resolve));

						assert.equal(counts.get(addedResource), 2);
					},
					() =>
						writeFileAsync(
							changedResourcePath,
							`${changedResourceSource}\nexports.react = require('./react');`
						),
					() => writeFileAsync(changedResourcePath, changedResourceSource)
				)
			);
		}, c);
	});

	it('should watch dynamically added resources (unions)', async () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				middleware: [UnionMiddleware()],
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);

		return getServer(async server => {
			const addedResourcePath = Path.join(c.entryDir, './dir/dir/dir/react.js');
			const changedResourcePath = Path.join(c.entryDir, './dir/dir/dir/index.js');
			const changedResourceSource = await readFileAsync(changedResourcePath);
			const counts = new WeakMap();

			const [main] = await server.install(false, resource => {
				if (!counts.has(resource)) {
					counts.set(resource, 0);
				}
				counts.set(resource, counts.get(resource) + 1);
			});

			return alterWatchedFile(server, () =>
				getDisposer(
					async () => {
						await new Promise(resolve => server.watcher.once('update', resolve));

						const dependencyArray = [...main.getDeepDependencySet()];
						const addedResource = dependencyArray.find(
							({ origin }) => origin === addedResourcePath
						);

						assert(addedResource, `Expected ${addedResourcePath} to be in dependency tree`);

						await alterWatchedFile(server, () =>
							writeFileAsync(addedResource.origin, addedResource.source)
						);

						await new Promise(resolve => server.watcher.once('update', resolve));

						assert.equal(counts.get(addedResource), 2);
					},
					() =>
						writeFileAsync(
							changedResourcePath,
							`${changedResourceSource}\nexports.react = require('./react');`
						),
					() => writeFileAsync(changedResourcePath, changedResourceSource)
				)
			);
		}, c);
	});

	it('should gracefully drop orphaned resources', async () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);

		return getServer(async server => {
			const changedResourcePath = Path.join(c.entryDir, './dir/dir/dir/index.js');
			const changedResourceSource = await readFileAsync(changedResourcePath);

			return getDisposer(
				async () => {
					const [main] = await server.install();

					const dependencyArray = [...main.getDeepDependencySet()];
					const changedResource = dependencyArray.find(
						({ origin }) => origin === changedResourcePath
					);
					const orphanedResource = dependencyArray[dependencyArray.indexOf(changedResource) + 1];

					await alterWatchedFile(server, () =>
						writeFileAsync(changedResourcePath, changedResourceSource)
					);

					await new Promise(resolve => server.watcher.once('update', resolve));

					assert.equal(orphanedResource.dependents.size, 0);

					assert(
						!orphanedResource.dependencyOf(changedResource),
						`Expected ${orphanedResource.moduleId} to not be a dependency of ${
							changedResource.moduleId
						}`
					);

					assert(
						!orphanedResource.dependencyOf(main),
						`Expected ${orphanedResource.moduleId} to not be a dependency of ${main.moduleId}`
					);

					assert(
						!changedResource.dependencies.has(orphanedResource),
						`Expected ${orphanedResource.moduleId} to not be a dependency of ${main.moduleId}`
					);
				},
				() =>
					writeFileAsync(
						changedResourcePath,
						`${changedResourceSource}\nexports.react = require('./react');`
					),
				() => writeFileAsync(changedResourcePath, changedResourceSource)
			);
		}, c);
	});

	it('should gracefully drop orphaned resources (unions)', async () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				middleware: [UnionMiddleware()],
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);

		return getServer(async server => {
			const changedResourcePath = Path.join(c.entryDir, './dir/dir/dir/index.js');
			const changedResourceSource = await readFileAsync(changedResourcePath);

			return getDisposer(
				async () => {
					const [main] = await server.install();

					const dependencyArray = [...main.getDeepDependencySet()];
					const changedResource = dependencyArray.find(
						({ origin }) => origin === changedResourcePath
					);
					const orphanedResource = dependencyArray[dependencyArray.indexOf(changedResource) + 1];

					await alterWatchedFile(server, () =>
						writeFileAsync(changedResourcePath, changedResourceSource)
					);

					await new Promise(resolve => server.watcher.once('update', resolve));

					assert.equal(orphanedResource.dependents.size, 0);

					assert(
						!orphanedResource.dependencyOf(changedResource),
						`Expected ${orphanedResource.moduleId} to not be a dependency of ${
							changedResource.moduleId
						}`
					);

					assert(
						!orphanedResource.dependencyOf(main),
						`Expected ${orphanedResource.moduleId} to not be a dependency of ${main.moduleId}`
					);

					assert(
						!changedResource.dependencies.has(orphanedResource),
						`Expected ${orphanedResource.moduleId} to not be a dependency of ${main.moduleId}`
					);
				},
				() =>
					writeFileAsync(
						changedResourcePath,
						`${changedResourceSource}\nexports.react = require('./react');`
					),
				() => writeFileAsync(changedResourcePath, changedResourceSource)
			);
		}, c);
	});

	it('should gracefully drop deleted resources', async () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);

		return getServer(async server => {
			const changedResourcePath = Path.join(c.entryDir, './dir/dir/dir/index.js');
			const changedResourceSource = await readFileAsync(changedResourcePath);

			return getDisposer(
				async () => {
					const deletedResourcePath = Path.join(c.entryDir, './dir/dir/dir/react.js');
					const deletedResourceSource = await readFileAsync(deletedResourcePath);
					const [main] = await server.install();

					const dependencyArray = [...main.getDeepDependencySet()];
					const changedResource = dependencyArray.find(
						({ origin }) => origin === changedResourcePath
					);
					const preDeletedResource = dependencyArray.find(
						({ origin }) => origin === deletedResourcePath
					);

					return alterWatchedFile(server, () =>
						getDisposer(
							async () => {
								await new Promise(resolve => server.watcher.once('update', resolve));

								const deletedResource = last([...main.getDeepDependencySet()]);

								assert(
									deletedResource.isNull,
									`Expected ${deletedResource.moduleId} to be a NullResource`
								);

								preDeletedResource.getDeepDependencySet(undefined, true).forEach(resource => {
									assert(
										!resource.dependencyOf(deletedResource),
										`Expected ${resource.moduleId} to not be a dependency of ${
											deletedResource.moduleId
										}`
									);
									assert(
										!resource.dependencyOf(changedResource),
										`Expected ${resource.moduleId} to not be a dependency of ${
											changedResource.moduleId
										}`
									);
									assert(
										!resource.dependencyOf(main),
										`Expected ${resource.moduleId} to not be a dependency of ${main.moduleId}`
									);
								});
							},
							() => rimrafAsync(deletedResourcePath),
							() => writeFileAsync(deletedResourcePath, deletedResourceSource)
						)
					);
				},
				() =>
					writeFileAsync(
						changedResourcePath,
						`${changedResourceSource}\nexports.react = require('./react');`
					),
				() => writeFileAsync(changedResourcePath, changedResourceSource)
			);
		}, c);
	});

	it('should gracefully drop deleted resources (unions)', async () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				middleware: [UnionMiddleware()],
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);

		return getServer(async server => {
			const changedResourcePath = Path.join(c.entryDir, './dir/dir/dir/index.js');
			const changedResourceSource = await readFileAsync(changedResourcePath);

			return getDisposer(
				async () => {
					const deletedResourcePath = Path.join(c.entryDir, './dir/dir/dir/react.js');
					const deletedResourceSource = await readFileAsync(deletedResourcePath);
					const [main] = await server.install();

					const dependencyArray = [...main.getDeepDependencySet()];
					const changedResource = dependencyArray.find(
						({ origin }) => origin === changedResourcePath
					);
					const preDeletedResource = dependencyArray.find(
						({ origin }) => origin === deletedResourcePath
					);

					return alterWatchedFile(server, () =>
						getDisposer(
							async () => {
								await new Promise(resolve => server.watcher.once('update', resolve));

								const deletedResource = last([...main.getDeepDependencySet()]);

								assert(
									deletedResource.isNull,
									`Expected ${deletedResource.moduleId} to be a NullResource`
								);

								preDeletedResource.getDeepDependencySet(undefined, true).forEach(resource => {
									assert(
										!resource.dependencyOf(deletedResource),
										`Expected ${resource.moduleId} to not be a dependency of ${
											deletedResource.moduleId
										}`
									);
									assert(
										!resource.dependencyOf(changedResource),
										`Expected ${resource.moduleId} to not be a dependency of ${
											changedResource.moduleId
										}`
									);
									assert(
										!resource.dependencyOf(main),
										`Expected ${resource.moduleId} to not be a dependency of ${main.moduleId}`
									);
								});
							},
							() => rimrafAsync(deletedResourcePath),
							() => writeFileAsync(deletedResourcePath, deletedResourceSource)
						)
					);
				},
				() =>
					writeFileAsync(
						changedResourcePath,
						`${changedResourceSource}\nexports.react = require('./react');`
					),
				() => writeFileAsync(changedResourcePath, changedResourceSource)
			);
		}, c);
	});

	it('should gracefully recover after an install fails', async () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);

		return getServer(async server => {
			const changedResourcePath = Path.join(c.entryDir, './dir/dir/dir/index.js');
			const changedResourceSource = await readFileAsync(changedResourcePath);

			const [main] = await server.install();

			return alterWatchedFile(server, () =>
				getDisposer(
					async () => {
						await new Promise(resolve => server.watcher.once('error', resolve));

						const initialDependencySetSize = main.getDeepDependencySet(undefined, true).size;

						await alterWatchedFile(server, () =>
							writeFileAsync(
								changedResourcePath,
								`${changedResourceSource}\nexports.react = require('./react');`
							)
						);

						await new Promise(resolve => server.watcher.once('update', resolve));

						assert(
							main.getDeepDependencySet().size > initialDependencySetSize,
							'Expected final dependency set size to be greater than initial size'
						);
					},
					() => writeFileAsync(changedResourcePath, `${changedResourceSource}@`),
					() => writeFileAsync(changedResourcePath, changedResourceSource)
				)
			);
		}, c);
	});

	it('should gracefully recover after an install fails (unions)', async () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/watcher')]: {
				entry: 'tests/watcher',
				middleware: [UnionMiddleware()],
				watch: true
			}
		}).use('tests/watcher');

		await getResourceFactory(factory => factory.reset(), c);

		return getServer(async server => {
			const changedResourcePath = Path.join(c.entryDir, './dir/dir/dir/index.js');
			const changedResourceSource = await readFileAsync(changedResourcePath);

			const [main] = await server.install();

			return alterWatchedFile(server, () =>
				getDisposer(
					async () => {
						await new Promise(resolve => server.watcher.once('error', resolve));

						const initialDependencySetSize = main.getDeepDependencySet(undefined, true).size;

						await alterWatchedFile(server, () =>
							writeFileAsync(
								changedResourcePath,
								`${changedResourceSource}\nexports.react = require('./react');`
							)
						);

						await new Promise(resolve => server.watcher.once('update', resolve));

						assert(
							main.getDeepDependencySet().size > initialDependencySetSize,
							'Expected final dependency set size to be greater than initial size'
						);
					},
					() => writeFileAsync(changedResourcePath, `${changedResourceSource}@`),
					() => writeFileAsync(changedResourcePath, changedResourceSource)
				)
			);
		}, c);
	});
});

describe('Client', () => {
	it('should use the default scope if a namespace is not specified', () =>
		getServer(async server => {
			await server.install();
			return getClient(async client => {
				const request = 'react';
				const args = await Promise.all([
					client.import(request),
					client.import(`<${C.scopeKey}>/${request}`)
				]);
				assert.strictEqual(...args);
			});
		}));

	it('should manage a collection of loaders', () =>
		getServer(async server => {
			await server.install();
			return getClient(async client => {
				assert(client.loaders instanceof Map);
				assert.deepEqual(
					Object.keys(await client.import(`<a/${C.scopeKey}>`)),
					Object.keys(await client.import(`<b/${C.scopeKey}>`))
				);
				assert.notStrictEqual(
					await client.import(`<a/${C.scopeKey}>/react`),
					await client.import(`<b/${C.scopeKey}>/react`)
				);
			});
		}));

	it('should instantiate one loader per namespace', () =>
		getServer(async server => {
			await server.install();
			return getClient(async client => {
				const loaderA = client.use(`a/${C.scopeKey}`);
				const loaderB = client.use(`b/${C.scopeKey}`);
				assert.notStrictEqual(loaderA, loaderB);
				assert(loaderA instanceof RemoteLoader);
				assert(loaderA instanceof loaderB.constructor);
				assert.strictEqual(loaderA, client.use(`a/${C.scopeKey}`));
				assert.strictEqual(client.loaders.size, 2);
			});
		}));

	it('should optionally share a registry between loader instances', () =>
		getServer(async server => {
			await server.install();
			const registry = new Registry(3e5);
			return getClient(
				async client => {
					assert.strictEqual(
						await client.import(`<a/${C.scopeKey}>/react`),
						await client.import(`<b/${C.scopeKey}>/react`)
					);
				},
				{ registry }
			);
		}));

	it('should optionally share context between loader instances', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('context')]: {
				entry: 'tests/loader'
			}
		}).use('context');

		return getServer(async server => {
			await server.install();
			const context = createContext({ ...global });
			return getClient(
				async client => {
					assert.strictEqual(
						await client.import(`<a/${c.scopeKey}>/:./tests/loader/context`),
						await client.import(`<b/${c.scopeKey}>/:./tests/loader/context`)
					);
				},
				{
					context,
					uri: c.getRoot().server.uri
				}
			);
		}, c);
	});

	it('should handle baseURLs other than /', () =>
		getServer(async server => {
			await server.install();
			const uri = `${C.getRoot().server.uri}/fragments`;
			return getClient(
				async client => {
					assert.equal(
						(await client.import(`<a/${C.scopeKey}>`)).hello,
						(await client.import(`<b/${C.scopeKey}>`)).hello
					);
					assert.notStrictEqual(
						await client.import(`<a/${C.scopeKey}>/react`),
						await client.import(`<b/${C.scopeKey}>/react`)
					);
				},
				{ uri }
			);
		}));

	it('should render static tags given an import request', () => {
		const basePath = '/fragments';
		const uri = `${C.getRoot().server.uri}${basePath}`;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('renderStatic')]: {
				entry: 'tests/styles',
				extensions: ['.css', '.less', '.sass', '.scss'],
				server: {
					uri: `${uri}/test`
				}
			}
		}).use('renderStatic');

		return getServer(async server => {
			await server.install();
			return getClient(
				async client => {
					const importRequest = `test/${c.scopeKey}`;
					const namespace = `${basePath}/${importRequest}`;
					const html = await client.renderStatic(`<${importRequest}>`);
					const scripts = html.match(/(<script.+><\/script>)/g) || [];
					const stylesheets = html.match(/(<link.+rel="stylesheet".*\/?>)/g) || [];

					assert(scripts.length > 0, 'Expected scripts to have length > 0');
					assert(stylesheets.length > 0, 'Expected stylesheets to have length > 0');

					scripts.forEach(tag => {
						const regexp = new RegExp(`^<script.+src="${escapeRegExp(namespace)}/_/`);
						assert(regexp.test(tag), `Expected ${tag} to match ${regexp}`);
					});

					stylesheets.forEach(tag => {
						const regexp = new RegExp(`^<link.+href="${escapeRegExp(namespace)}/_/`);
						assert(regexp.test(tag), `Expected ${tag} to match ${regexp}`);
					});
				},
				{ uri }
			);
		}, c);
	});

	it('should render static tags given an import request (unions)', () => {
		const basePath = '/fragments';
		const uri = `${C.getRoot().server.uri}${basePath}`;
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('renderStatic')]: {
				entry: 'tests/styles',
				extensions: ['.css', '.less', '.sass', '.scss'],
				middleware: [UnionMiddleware()],
				server: {
					uri: `${uri}/test`
				}
			}
		}).use('renderStatic');

		return getServer(async server => {
			await server.install();
			return getClient(
				async client => {
					const importRequest = `test/${c.scopeKey}`;
					const namespace = `${basePath}/${importRequest}`;
					const html = await client.renderStatic(`<${importRequest}>`);
					const scripts = html.match(/(<script.+><\/script>)/g) || [];
					const stylesheets = html.match(/(<link.+rel="stylesheet".*\/?>)/g) || [];

					assert(scripts.length > 0, 'Expected scripts to have length > 0');
					assert(stylesheets.length > 0, 'Expected stylesheets to have length > 0');

					scripts.forEach(tag => {
						const regexp = new RegExp(`^<script.+src="${escapeRegExp(namespace)}/_/~/`);
						assert(regexp.test(tag), `Expected ${tag} to match ${regexp}`);
					});

					stylesheets.forEach(tag => {
						const regexp = new RegExp(`^<link.+href="${escapeRegExp(namespace)}/_/~/`);
						assert(regexp.test(tag), `Expected ${tag} to match ${regexp}`);
					});
				},
				{ uri }
			);
		}, c);
	});

	it('should render only static tags of the requested type', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			entry: 'tests/styles',
			extensions: ['.css', '.less', '.sass', '.scss']
		}).use();

		function countScripts(html) {
			return (html.match(/(<script.+><\/script>)/g) || []).length;
		}

		function countLinks(html) {
			return (html.match(/(<link.+\/>)/g) || []).length;
		}

		return getServer(async server => {
			await server.install();
			return getClient(
				async client => {
					let html = await client.renderStatic();
					const scriptCount = countScripts(html);
					const linkCount = countLinks(html);
					html = await client.renderStatic(undefined, 'js');
					assert.equal(countScripts(html) + countLinks(html), scriptCount);
					html = await client.renderStatic(undefined, 'css');
					assert.equal(countScripts(html) + countLinks(html), linkCount);
				},
				{ uri: c.server.uri }
			);
		}, c);
	});

	it('should not call loader.reset if there is no previous active loader', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/circular')]: {
				entry: 'tests/circular'
			}
		}).use('tests/circular');

		return getDisposer(
			stub =>
				getServer(async server => {
					await server.install();
					await getClient(async client => {
						await client.reset();
						assert.equal(stub.callCount, 0);
					});
				}, c),
			() => sinon.stub(RemoteLoader.prototype, 'reset'),
			stub => stub.restore()
		);
	});

	it('should call loader.reset if the next loader is NOT the same as the previous', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/circular')]: {
				entry: 'tests/circular'
			}
		}).use('tests/circular');

		return getDisposer(
			stub =>
				getServer(async server => {
					await server.install();
					await getClient(async client => {
						await client.import(`<a/${c.scopeKey}>`);
						await client.import(`<b/${c.scopeKey}>`);
						assert.equal(stub.callCount, 1);
					});
				}, c),
			() => sinon.stub(RemoteLoader.prototype, 'reset'),
			stub => stub.restore()
		);
	});

	it('should NOT call loader.reset if the next loader is the same as the previous', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/circular')]: {
				entry: 'tests/circular'
			}
		}).use('tests/circular');

		return getDisposer(
			stub =>
				getServer(async server => {
					await server.install();
					await getClient(async client => {
						await client.import(`<${c.scopeKey}>`);
						await client.import(`<${c.scopeKey}>`);
						assert.equal(stub.callCount, 0);
					});
				}, c),
			() => sinon.stub(RemoteLoader.prototype, 'reset'),
			stub => stub.restore()
		);
	});
});

describe('RemoteLoader', () => {
	it('should never resolve a pid to a string', () =>
		getLoader(async loader => {
			assert.equal(loader.resolvePid('no-exist/index.js'), undefined);
		}));

	it('should generate resource URLs', () =>
		getServer(async server => {
			await server.install();
			return getLoader(async loader => {
				const { manifest } = await loader.load();
				manifest.list().forEach(moduleId => {
					const url = loader.getResourceURLFromID(moduleId);
					const { pathname } = Url.parse(url);
					if (helpers.isRelativePath(moduleId)) {
						assert(!moduleId.startsWith(':'), `Expected ${moduleId} to not start with ':'`);
						assert(
							pathname.startsWith(`/${C.scopeKey}/_/:`),
							`Expected ${pathname} to start with ':'`
						);
						assert.equal(pathname, `/${C.scopeKey}/_/:${moduleId}`);
					} else {
						assert.equal(pathname, `/${C.scopeKey}/_/${moduleId}`);
					}
				});
			});
		}));

	it('should load a remote module', () =>
		getServer(async server => {
			await server.install();
			return getLoader(async loader => {
				const remotePackage = await loader.import('./package.json');
				// eslint-disable-next-line global-require, import/no-dynamic-require
				const localPackage = require(`../${C.root}/package.json`);
				assert.deepEqual(remotePackage, localPackage);
				assert.notStrictEqual(remotePackage, localPackage);
			});
		}));

	it('should run in the global context by default', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/loader')]: {
				entry: 'tests/loader'
			}
		}).use('tests/loader');

		// Just in case it was loaded prior to this
		delete global.loadCount;

		return getServer(async server => {
			await server.install();
			await getLoader(
				async loader => {
					const { loadCount } = await loader.import();
					assert.equal(loadCount, 1);
				},
				{ uri: c.server.uri }
			);
			await getLoader(
				async loader => {
					const { loadCount } = await loader.import();
					assert.equal(loadCount, 2);
				},
				{ uri: c.server.uri }
			);
			assert.equal(global.loadCount, 2);
			delete global.loadCount;
		}, c);
	});

	it('should optionally run in a new context', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/loader')]: {
				entry: 'tests/loader'
			}
		}).use('tests/loader');

		return getServer(async server => {
			await server.install();
			await Promise.all([
				getLoader(loader => loader.import('./tests/loader/context'), {
					context: createContext({ global: {} }),
					uri: c.server.uri
				}),
				getLoader(loader => loader.import('./tests/loader/context'), {
					context: createContext({ global: {} }),
					uri: c.server.uri
				})
			]).then(([a, b]) => {
				assert.notStrictEqual(a, b);
			});
		}, c);
	});

	it('should not pollute the module context', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/loader')]: {
				entry: 'tests/loader'
			}
		}).use('tests/loader');

		return getServer(async server => {
			await server.install();
			const context = createContext({ global: {} });
			await getLoader(loader => loader.import(), { context, uri: c.server.uri });
			Object.keys(context).forEach(key => {
				assert(!key.startsWith('pid:'), 'Expected Loader to not pollute the module context');
			});
		}, c);
	});

	it('should not pollute the module context (unions)', () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/loader')]: {
				entry: 'tests/loader',
				middleware: [UnionMiddleware()]
			}
		}).use('tests/loader');

		return getServer(async server => {
			await server.install();
			const context = createContext({ global: {} });
			await getLoader(loader => loader.import(), { context, uri: c.server.uri });
			Object.keys(context).forEach(key => {
				assert(!key.startsWith('pid:'), 'Expected Loader to not pollute the module context');
			});
		}, c);
	});

	it('should never initialize the same module more than once', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/loader')]: {
				entry: 'tests/loader'
			}
		}).use('tests/loader');

		return getServer(async server => {
			await server.install();
			return getLoader(
				async loader => {
					const exports = await Promise.all(
						[
							undefined,
							'',
							':./tests/loader',
							'./tests/loader',
							':./tests/loader/index',
							'./tests/loader/index',
							':./tests/loader/index.js',
							'./tests/loader/index.js'
						].map(request => loader.import(request))
					);

					while (exports.length > 1) {
						const args = [exports.shift(), exports[0]];
						assert.strictEqual(...args);
					}
				},
				{
					context: createContext({ global: {} }),
					uri: c.server.uri
				}
			);
		}, c);
	});

	it('should never initialize the same module more than once (unions)', () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/loader')]: {
				entry: 'tests/loader',
				middleware: [UnionMiddleware()]
			}
		}).use('tests/loader');

		return getServer(async server => {
			await server.install();
			return getLoader(
				async loader => {
					const exports = await Promise.all(
						[
							undefined,
							'',
							':./tests/loader',
							'./tests/loader',
							':./tests/loader/index',
							'./tests/loader/index',
							':./tests/loader/index.js',
							'./tests/loader/index.js'
						].map(request => loader.import(request))
					);

					while (exports.length > 1) {
						const args = [exports.shift(), exports[0]];
						assert.strictEqual(...args);
					}
				},
				{
					context: createContext({ global: {} }),
					uri: c.server.uri
				}
			);
		}, c);
	});

	it('should re-throw on each require if a module initializer throws an error', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/loader')]: {
				entry: 'tests/loader'
			}
		}).use('tests/loader');

		return getServer(async server => {
			await server.install();
			return getLoader(
				async loader => {
					const { throwError, loadCount } = await loader.import();
					assert.throws(throwError, /error!/);
					assert.throws(throwError, /error!/);
					assert.throws(throwError, /error!/);
					assert.equal(loadCount, 1);
				},
				{
					context: createContext({ global: {} }),
					uri: c.server.uri
				}
			);
		}, c);
	});

	it('should always fetch modules from source when forceLoad === true', () =>
		getServer(async server => {
			await server.install();
			await getLoader(async loader => {
				assert.strictEqual(await loader.import('react'), await loader.import('react'));
			});
			return getLoader(
				async loader => {
					assert.notStrictEqual(await loader.import('react'), await loader.import('react'));
				},
				{ forceLoad: true }
			);
		}));

	it('should be able to load non-entrypoint files', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/circular')]: {
				entry: 'tests/circular'
			}
		}).use('tests/circular');

		return getServer(async server => {
			await server.install();
			return getLoader(
				async loader => {
					assert.deepEqual(await loader.import('./tests/circular/circular'), {});
				},
				{
					uri: c.server.uri
				}
			);
		}, c);
	});

	it('should be able to load non-entrypoint files (unions)', () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/circular')]: {
				entry: 'tests/circular',
				middleware: [UnionMiddleware()]
			}
		}).use('tests/circular');

		return getServer(async server => {
			await server.install();
			return getLoader(
				async loader => {
					assert.deepEqual(await loader.import('./tests/circular/circular'), {});
				},
				{
					uri: c.server.uri
				}
			);
		}, c);
	});

	it('should never load the same module twice', () =>
		getServer(
			async server => {
				await server.install();
				return getLoader(async loader => {
					const moduleGroupGetters = [
						() => [
							loader.import(),
							loader.import(':'),
							loader.import('.'),
							loader.import(':.'),
							loader.import('./'),
							loader.import(':./'),
							loader.import('./index'),
							loader.import(':./index'),
							loader.import('./index.js'),
							loader.import(':./index.js')
						],
						() => [
							loader.import('react'),
							loader.import('react/index'),
							loader.import('react/index.js'),
							loader.import('./index').then(({ React }) => React)
						],
						() => [
							loader.import('react-helmet'),
							loader.import('react-helmet/lib/Helmet'),
							loader.import('react-helmet/lib/Helmet.js'),
							loader.import('./index.js').then(({ ReactHelmet }) => ReactHelmet)
						]
					];

					// Make sure these are all fetched concurrently
					await Promise.all(moduleGroupGetters.reduce((acc, fn) => [...acc, ...fn()], []));

					await Promise.all(
						moduleGroupGetters.map(async fn => {
							const modules = await Promise.all(fn());
							while (modules.length > 1) {
								const args = [modules.shift(), modules[0]];
								assert.strictEqual(...args);
							}
						})
					);
				});
			},
			{
				...baseInstallerOptions,
				mainFields: ['main']
			}
		));

	it('should handle baseURLs other than /', () =>
		getServer(async server => {
			await server.install();
			const uri = `${C.getRoot().server.uri}/fragments/name/${C.scopeKey}`;
			return getLoader(
				async loader => {
					const { hello } = await loader.import();
					assert.strictEqual(hello, 'world!');
				},
				{ uri }
			);
		}));

	it('should load and render stylesheets in browser', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styles')]: {
				entry: 'tests/styles',
				preset: 'browser',
				extensions: ['.css', '.less', '.sass', '.scss'],
				server: {
					static: ['dist/client.browser.js?(.map)']
				}
			}
		}).use('tests/styles');

		function getAssertionsPredicate(expectedCounts) {
			return async ({ client, document, IMPORT_REQUEST }) => {
				function countStylesheets() {
					return document.querySelectorAll(
						'style[data-remote-modules],link[data-remote-modules][rel=stylesheet]'
					).length;
				}

				function countScripts() {
					return document.querySelectorAll('script[data-remote-modules]').length;
				}

				assert.equal(countStylesheets(), expectedCounts.css.initial);
				assert.equal(countScripts(), expectedCounts.js.initial + expectedCounts.json.initial);

				await client.import(IMPORT_REQUEST).then(render => render());

				assert.equal(countStylesheets(), expectedCounts.css.final);
				assert.equal(countScripts(), expectedCounts.js.final + expectedCounts.json.final);

				// Make sure dynamic imports were not added to the manifest
				const { manifest } = await client.use(c.scopeKey).load();
				assert(
					!manifest.exists('react-dom/index.js'),
					'Expected manifest to not include react-dom/index.js'
				);
			};
		}

		return getServer(async server => {
			const [main] = await server.install();
			const resources = [main, ...main.getDeepDependencySet()];
			const expectedCounts = {
				css: {
					initial: resources.filter(r => !r.async && r.adapter.outputType === 'css').length,
					final: resources.filter(r => r.adapter.outputType === 'css').length
				},
				js: {
					initial: resources.filter(r => !r.async && r.adapter.outputType === 'js').length,
					final: resources.filter(r => r.adapter.outputType === 'js').length
				},
				json: {
					initial: 1,
					final: 2
				}
			};

			// static, canonical
			await getWindow(`${c.server.uri}/browser?auto=false`, getAssertionsPredicate(expectedCounts));

			// dynamic, canonical
			await getWindow(
				`${c.server.uri}/browser?auto=false&dynamic=1`,
				getAssertionsPredicate({
					css: { ...expectedCounts.css, initial: 0 },
					js: { ...expectedCounts.js, initial: 0 },
					json: { ...expectedCounts.json, initial: 0 }
				})
			);

			// static, non-canonical
			await getWindow(
				`${c.server.uri}/browser?auto=false&import=<${c.scopeKey}>/:./${c.entry}`,
				getAssertionsPredicate(expectedCounts)
			);

			// dynamic, non-canonical
			await getWindow(
				`${c.server.uri}/browser?auto=false&dynamic=1&import=<${c.scopeKey}>/:./${c.entry}`,
				getAssertionsPredicate({
					css: { ...expectedCounts.css, initial: 0 },
					js: { ...expectedCounts.js, initial: 0 },
					json: { ...expectedCounts.json, initial: 0 }
				})
			);

			assert.equal(server.statusCounts.get(302), undefined);
			assert.equal(server.statusCounts.get(404), undefined);
		}, c);
	});

	it('should load and render stylesheets in browser (unions)', () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styles')]: {
				entry: 'tests/styles',
				preset: 'browser',
				extensions: ['.css', '.less', '.sass', '.scss'],
				middleware: [UnionMiddleware()],
				server: {
					static: ['dist/client.browser.js?(.map)']
				}
			}
		}).use('tests/styles');

		function getAssertionsPredicate(expectedCounts) {
			return async ({ client, document, IMPORT_REQUEST }) => {
				function countStylesheets() {
					return document.querySelectorAll(
						'style[data-remote-modules],link[data-remote-modules][rel=stylesheet]'
					).length;
				}

				function countScripts() {
					return document.querySelectorAll('script[data-remote-modules]').length;
				}

				assert.equal(countStylesheets(), expectedCounts.css.initial);
				assert.equal(countScripts(), expectedCounts.js.initial + expectedCounts.json.initial);

				await client.import(IMPORT_REQUEST).then(render => render());

				assert.equal(countStylesheets(), expectedCounts.css.final);
				assert.equal(countScripts(), expectedCounts.js.final + expectedCounts.json.final);

				// Make sure dynamic imports were not added to the manifest
				const { manifest } = await client.use(c.scopeKey).load();
				assert(
					!manifest.exists('react-dom/index.js'),
					'Expected manifest to not include react-dom/index.js'
				);
			};
		}

		function countUnions(resources) {
			return resources.reduce((acc, resource) => {
				acc.add(resource.union);
				return acc;
			}, new Set()).size;
		}

		return getServer(async server => {
			const [main] = await server.install();
			const resources = [main, ...main.getDeepDependencySet()];
			const expectedCounts = {
				css: {
					initial: countUnions(resources.filter(r => !r.async && r.adapter.outputType === 'css')),
					final: countUnions(resources.filter(r => r.adapter.outputType === 'css'))
				},
				js: {
					initial: countUnions(resources.filter(r => !r.async && r.adapter.outputType === 'js')),
					final: countUnions(resources.filter(r => r.adapter.outputType === 'js'))
				},
				json: {
					initial: 1,
					final: 2
				}
			};

			// static, canonical
			await getWindow(`${c.server.uri}/browser?auto=false`, getAssertionsPredicate(expectedCounts));

			// dynamic, canonical
			await getWindow(
				`${c.server.uri}/browser?auto=false&dynamic=1`,
				getAssertionsPredicate({
					css: { ...expectedCounts.css, initial: 0 },
					js: { ...expectedCounts.js, initial: 0 },
					json: { ...expectedCounts.json, initial: 0 }
				})
			);

			// static, non-canonical
			await getWindow(
				`${c.server.uri}/browser?auto=false&import=<${c.scopeKey}>/:./${c.entry}`,
				getAssertionsPredicate(expectedCounts)
			);

			// dynamic, non-canonical
			await getWindow(
				`${c.server.uri}/browser?auto=false&dynamic=1&import=<${c.scopeKey}>/:./${c.entry}`,
				getAssertionsPredicate({
					css: { ...expectedCounts.css, initial: 0 },
					js: { ...expectedCounts.js, initial: 0 },
					json: { ...expectedCounts.json, initial: 0 }
				})
			);

			assert.equal(server.statusCounts.get(302), undefined);
			assert.equal(server.statusCounts.get(404), undefined);
		}, c);
	});

	it('should NOT attempt to render stylesheets on node', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styles')]: {
				entry: 'tests/styles',
				preset: 'node',
				extensions: ['.css', '.less', '.sass', '.scss']
			}
		}).use('tests/styles');

		return getServer(async server => {
			await server.install();
			await getClient(async client => {
				await client.import(`<${c.scopeKey}>`).then(render => render());
				const { manifest } = await client.use(c.scopeKey).load();
				// Make sure only script resources were added to the manifest
				for (const moduleId of manifest.list()) {
					assert.equal(manifest.getType(moduleId), 'js');
				}
				// Make sure dynamic imports were not added to the manifest
				assert(
					!manifest.exists('react-dom/server.js'),
					'Expected manifest to not include react-dom/server.js'
				);
			});
			assert.equal(server.statusCounts.get(302), undefined);
			assert.equal(server.statusCounts.get(404), undefined);
		}, c);
	});

	it('should NOT attempt to render stylesheets on node (unions)', () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styles')]: {
				entry: 'tests/styles',
				preset: 'node',
				extensions: ['.css', '.less', '.sass', '.scss'],
				middleware: [UnionMiddleware()]
			}
		}).use('tests/styles');

		return getServer(async server => {
			await server.install();
			await getClient(async client => {
				await client.import(`<${c.scopeKey}>`).then(render => render());
				const { manifest } = await client.use(c.scopeKey).load();
				// Make sure only script resources were added to the manifest
				for (const moduleId of manifest.list()) {
					assert.equal(manifest.getType(moduleId), 'js');
				}
				// Make sure dynamic imports were not added to the manifest
				assert(
					!manifest.exists('react-dom/server.js'),
					'Expected manifest to not include react-dom/server.js'
				);
			});
			assert.equal(server.statusCounts.get(302), undefined);
			assert.equal(server.statusCounts.get(404), undefined);
		}, c);
	});

	it('should support SPA request flow in browser', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styles')]: {
				entry: 'tests/styles',
				preset: 'browser',
				extensions: ['.css', '.less', '.sass', '.scss'],
				server: {
					static: ['dist/client.browser.js?(.map)']
				}
			}
		}).use('tests/styles');

		function getAssertionsPredicate(expectedCounts) {
			return async ({ client, document, IMPORT_REQUEST }) => {
				function countStylesheets() {
					return document.querySelectorAll(
						'style[data-remote-modules],link[data-remote-modules][rel=stylesheet]'
					).length;
				}

				function countScripts() {
					return document.querySelectorAll('script[data-remote-modules]').length;
				}

				assert.equal(countStylesheets(), expectedCounts.css.initial);
				assert.equal(countScripts(), expectedCounts.js.initial + expectedCounts.json.initial);

				await client.import(IMPORT_REQUEST).then(render => render());

				assert.equal(countStylesheets(), expectedCounts.css.final);
				assert.equal(countScripts(), expectedCounts.js.final + expectedCounts.json.final);

				await client.reset();

				assert.equal(countStylesheets(), 0);
				assert.equal(countScripts(), 0);

				await client.import(IMPORT_REQUEST).then(render => render());

				assert.equal(countStylesheets(), expectedCounts.css.final);
				assert.equal(countScripts(), 0);
			};
		}

		return getServer(async server => {
			const [main] = await server.install();
			const resources = [main, ...main.getDeepDependencySet()];
			const expectedCounts = {
				css: {
					initial: resources.filter(r => !r.async && r.adapter.outputType === 'css').length,
					final: resources.filter(r => r.adapter.outputType === 'css').length
				},
				js: {
					initial: resources.filter(r => !r.async && r.adapter.outputType === 'js').length,
					final: resources.filter(r => r.adapter.outputType === 'js').length
				},
				json: {
					initial: 1,
					final: 2
				}
			};

			// static
			await getWindow(`${c.server.uri}/browser?auto=false`, getAssertionsPredicate(expectedCounts));

			// dynamic
			await getWindow(
				`${c.server.uri}/browser?auto=false&dynamic=1`,
				getAssertionsPredicate({
					css: { ...expectedCounts.css, initial: 0 },
					js: { ...expectedCounts.js, initial: 0 },
					json: { ...expectedCounts.json, initial: 0 }
				})
			);

			assert.equal(server.statusCounts.get(302), undefined);
			assert.equal(server.statusCounts.get(404), undefined);
		}, c);
	});

	it('should support SPA request flow in browser (unions)', () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styles')]: {
				entry: 'tests/styles',
				preset: 'browser',
				extensions: ['.css', '.less', '.sass', '.scss'],
				middleware: [UnionMiddleware()],
				server: {
					static: ['dist/client.browser.js?(.map)']
				}
			}
		}).use('tests/styles');

		function getAssertionsPredicate(expectedCounts) {
			return async ({ client, document, IMPORT_REQUEST }) => {
				function countStylesheets() {
					return document.querySelectorAll(
						'style[data-remote-modules],link[data-remote-modules][rel=stylesheet]'
					).length;
				}

				function countScripts() {
					return document.querySelectorAll('script[data-remote-modules]').length;
				}

				assert.equal(countStylesheets(), expectedCounts.css.initial);
				assert.equal(countScripts(), expectedCounts.js.initial + expectedCounts.json.initial);

				await client.import(IMPORT_REQUEST).then(render => render());

				assert.equal(countStylesheets(), expectedCounts.css.final);
				assert.equal(countScripts(), expectedCounts.js.final + expectedCounts.json.final);

				await client.reset();

				assert.equal(countStylesheets(), 0);
				assert.equal(countScripts(), 0);

				await client.import(IMPORT_REQUEST).then(render => render());

				assert.equal(countStylesheets(), expectedCounts.css.final);
				assert.equal(countScripts(), 0);
			};
		}

		function countUnions(resources) {
			return resources.reduce((acc, resource) => {
				acc.add(resource.union);
				return acc;
			}, new Set()).size;
		}

		return getServer(async server => {
			const [main] = await server.install();
			const resources = [main, ...main.getDeepDependencySet()];
			const expectedCounts = {
				css: {
					initial: countUnions(resources.filter(r => !r.async && r.adapter.outputType === 'css')),
					final: countUnions(resources.filter(r => r.adapter.outputType === 'css'))
				},
				js: {
					initial: countUnions(resources.filter(r => !r.async && r.adapter.outputType === 'js')),
					final: countUnions(resources.filter(r => r.adapter.outputType === 'js'))
				},
				json: {
					initial: 1,
					final: 2
				}
			};

			// static
			await getWindow(`${c.server.uri}/browser?auto=false`, getAssertionsPredicate(expectedCounts));

			// dynamic
			await getWindow(
				`${c.server.uri}/browser?auto=false&dynamic=1`,
				getAssertionsPredicate({
					css: { ...expectedCounts.css, initial: 0 },
					js: { ...expectedCounts.js, initial: 0 },
					json: { ...expectedCounts.json, initial: 0 }
				})
			);

			assert.equal(server.statusCounts.get(302), undefined);
			assert.equal(server.statusCounts.get(404), undefined);
		}, c);
	});

	it('should support stylesheet entrypoints', () => {
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styles')]: {
				entry: 'tests/styles',
				preset: 'browser',
				extensions: ['.css', '.less', '.sass', '.scss'],
				server: {
					static: ['dist/client.browser.js?(.map)']
				}
			}
		}).use('tests/styles');

		const entrypointId = './tests/styles/styles.less';

		function getAssertionsPredicate(expectedStyleCount) {
			return async ({ client, document, IMPORT_SCOPE }) => {
				function countStylesheets() {
					return document.querySelectorAll(
						'style[data-remote-modules],link[data-remote-modules][rel=stylesheet]'
					).length;
				}

				function countScripts() {
					return document.querySelectorAll('script[data-remote-modules]').length;
				}

				await client.import(`<${IMPORT_SCOPE}>`);
				await client.reset();

				assert.equal(countStylesheets(), 0);
				assert.equal(countScripts(), 0);

				await client.import(`<${IMPORT_SCOPE}>/:${entrypointId}`);

				assert.equal(countStylesheets(), expectedStyleCount);
				assert.equal(countScripts(), 1);
			};
		}

		return getServer(async server => {
			const [main] = await server.install();
			const entrypoint = main.resourceFactory(`./${Path.basename(entrypointId)}`, main);
			const resources = [entrypoint, ...entrypoint.getDeepDependencySet()];
			const expectedStyleCount = resources.filter(r => r.adapter.outputType === 'css').length;

			// static
			await getWindow(
				`${c.server.uri}/browser?auto=false`,
				getAssertionsPredicate(expectedStyleCount)
			);

			// dynamic
			await getWindow(
				`${c.server.uri}/browser?auto=false&dynamic=1`,
				getAssertionsPredicate(expectedStyleCount)
			);

			assert.equal(server.statusCounts.get(302), undefined);
			assert.equal(server.statusCounts.get(404), undefined);
		}, c);
	});

	it('should support stylesheet entrypoints (unions)', () => {
		const { UnionMiddleware } = ConfigStore.middleware;
		const c = new ConfigStore({
			...baseInstallerOptions,
			[ConfigStore.symbolFor('tests/styles')]: {
				entry: 'tests/styles',
				preset: 'browser',
				extensions: ['.css', '.less', '.sass', '.scss'],
				middleware: [UnionMiddleware()],
				server: {
					static: ['dist/client.browser.js?(.map)']
				}
			}
		}).use('tests/styles');

		const entrypointId = './tests/styles/styles.less';

		function getAssertionsPredicate(expectedStyleCount) {
			return async ({ client, document, IMPORT_SCOPE }) => {
				function countStylesheets() {
					return document.querySelectorAll(
						'style[data-remote-modules],link[data-remote-modules][rel=stylesheet]'
					).length;
				}

				function countScripts() {
					return document.querySelectorAll('script[data-remote-modules]').length;
				}

				await client.import(`<${IMPORT_SCOPE}>`);
				await client.reset();

				assert.equal(countStylesheets(), 0);
				assert.equal(countScripts(), 0);

				await client.import(`<${IMPORT_SCOPE}>/:${entrypointId}`);

				assert.equal(countStylesheets(), expectedStyleCount);
				assert.equal(countScripts(), 1);
			};
		}

		function countUnions(resources) {
			return resources.reduce((acc, resource) => {
				acc.add(resource.union);
				return acc;
			}, new Set()).size;
		}

		return getServer(async server => {
			const [main] = await server.install();
			const entrypoint = main.resourceFactory(`./${Path.basename(entrypointId)}`, main);
			const resources = [entrypoint, ...entrypoint.getDeepDependencySet()];
			const expectedStyleCount = countUnions(resources.filter(r => r.adapter.outputType === 'css'));

			// static
			await getWindow(
				`${c.server.uri}/browser?auto=false`,
				getAssertionsPredicate(expectedStyleCount)
			);

			// dynamic
			await getWindow(
				`${c.server.uri}/browser?auto=false&dynamic=1`,
				getAssertionsPredicate(expectedStyleCount)
			);

			assert.equal(server.statusCounts.get(302), undefined);
			assert.equal(server.statusCounts.get(404), undefined);
		}, c);
	});
});
