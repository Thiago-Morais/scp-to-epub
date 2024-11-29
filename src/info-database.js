const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path/posix');
const urlLib = require('url');
const {safeFilename, debug} = require('./lib/utils');
const scpperDB = require('./scpper-db');
const Resource = require('./lib/resource');
const DiskCache = require('./lib/disk-cache');
const {systemLinks, systemPrefixes, metaTags} = require('./system-links');
const config = require('./book-config');
const { maybeMirrorUrl } = require('./lib/kiwiki-cache');

function isEmpty(arr) {
	return !(arr && (typeof arr === 'object') && Object.keys(arr).length > 0);
}

class WikiDataLookup {
	/**
	 *
	 * @param {import('./book-maker')} app
	 * @param {import('..').BookMakerConfig} opts
	 */
	constructor(app, opts = {}) {
		/** @type {import("puppeteer").Browser} */
		this.browser = app.browser;

		const cacheOpts = {
			stats: true,
			path: path.join(__dirname, '../cache'),
			// one month default cache time
			maxAge: 30 * 24 * 60 * 60 * 1000,
			...(opts.cache)
		};

		const defaultOrigin = opts.defaultOrigin || 'http://www.scpwiki.com';

		this.options = {
			headless: false,
			debug: true,
			audioAdaptationsUrl: `${new URL('printer--friendly/audio-adaptations', defaultOrigin)}`,
			hubsUrl: `${new URL('/system:page-tags/tag/hub', defaultOrigin)}`,
			authorsUrl: `${new URL('/system:page-tags/tag/author', defaultOrigin)}`,
			artworkUrl: `${new URL('/system:page-tags/tag/artwork', defaultOrigin)}`,
			ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/77.0.3865.90 Safari/537.36',
            enableStats: true,
			...opts,
			cache: cacheOpts
		};

		if (this.options.cache.stats) {
			this.diskCache = new DiskCache({
				...cacheOpts,
				cacheInMemory: false
			});
		}
	}
    // only store stats lazily
    statCache = new Map();
    #whenLoaded = undefined;
	async loadCache(force = false) {
        if (!this.options.cache.stats) {
            return;
        }
        if (this.#whenLoaded && !force) {
            return this.#whenLoaded;
        }
        this.#whenLoaded = (async () => {
            debug('Reading stat cache entries from disk');
            await this.diskCache.initialize();

            

            // try {
            //     // this.diskCache._cache.forEach((value, diskKey) => {
            //     //     if (!diskKey.endsWith('.json')) {
            //     //         return;
            //     //     }
            //     //     if (path.dirname(diskKey) !== 'stats') {
            //     //         return;
            //     //     }
            //     //     const [pageId] = path.basename(value.path)
            //     //         .split('_');
            //     //     this.statCache.set(pageId, diskKey);
            //     // });
            //     // const statsPath = path.join(this.options.cache.path, 'stats');
            //     // // make sure directory exists
            //     // await fs.mkdir(statsPath, {recursive: true});
            //     // const statFiles = await fs.readdir(statsPath, { withFileTypes: true });
            //     // for (let file of statFiles) {
            //     // 	// only valid entries
            //     // 	if (!file.isFile || !file.name.endsWith('.json')) {
            //     // 		continue;
            //     // 	}
            //     // 	const pageId = file.name.split('_')[0];
            //     // 	this.statCache.set(pageId, file.name);
            //     // }
            // } catch (err) {
            //     console.warn('Unable to load stats cache', err);
            // }
        })();
        return this.#whenLoaded;
	}
	async saveCachedStats(stats) {
        const content = JSON.stringify(stats, null, '  ');

        const diskKey = this.#asCacheKey(stats.id, stats.pageName);
		await this.diskCache.set(diskKey, content);
        this.statCache.set(diskKey, stats);

		// const statsPath = path.join(this.options.cache.path, 'stats');

		// stats.lastCached = new Date();
		// // make name safe
		// const filename = `${stats.id}_${stats.pageName}.json`
		// 	.replace(/[ <>():"\/\\|?*\x00-\x1F]/g, '_');
		// const filepath = path.join(statsPath, filename);
		// try {
		// 	await fs.writeFile(filepath, JSON.stringify(stats, null, '  '));
		// } catch (err) {
		// 	console.warn('failed to write stats to cache', err);
		// }
	}
    #asCacheKey(pageId, pageName = 'list') {
        pageName = `${pageName}`.slice(0, 80);
        return path.posix.join('stats', safeFilename(`${pageId}_${pageName}.json`, '.json'));
    }
	async getCachedStats(pageId, pageName) {
		const cacheOpts = this.options.cache;
		if (!cacheOpts.stats) {
			return;
		}

        await this.loadCache();

		//  make sure in cache
		const diskId = this.#asCacheKey(pageId, pageName);

		const cacheEntry = await this.diskCache.get(diskId);

		if (!cacheEntry?.content) {
			return;
		}

        let raw = cacheEntry.content;
        if (typeof raw === 'object' && !(raw instanceof Buffer) && Array.isArray(raw.list)) {
            return raw;
        }
        let stats;
        try {
            stats = JSON.parse(raw.toString());
        } catch (error) {
            console.warn(`Failed to parse cache data for ${pageId}`, error);
            return;
        }

        const lastCached = stats.lastCached || cacheEntry.modified;
        const age = Date.now() - new Date(lastCached).getTime();
		// don't return if stale
        if (!isNaN(age) && age > cacheOpts.maxAge) {
            return undefined;
        }
        return stats;
	}
	async getStats(pageName, pageId) {
        if (!this.options.enableStats) {
            return {
				pageName
			};
        }

		const {stats: cacheEnabled} = this.options.cache;
		// check if exists
		if (pageId && cacheEnabled) {
			const result = await this.getCachedStats(pageId, pageName);
			if (result) {
				return result;
			}
		}

		try {
			const result = await (
				pageId ? scpperDB.getByPageId(pageId) : scpperDB.getByTitle(pageName)
			);
			if (!result) {
				console.warn(`No response for page ${pageId} ${pageName}`);
				return {
					pageName
				};
			}
			result.pageName = pageName;

			if (cacheEnabled) {
				await this.saveCachedStats(result);
			}

			return result;
		} catch (err) {
			console.error(`Failed to get stats for ${pageName} ${pageId}`, err);
			return {
				pageName
			};
		}
	}
	getCachedList = async (listName) => {
        const pageId = `meta--${listName}`;
        const cacheKey = this.#asCacheKey(pageId, 'list');
        let data = this.statCache.get(cacheKey);
        
        // __meta__authors
        if (!data) {
            data = await this.getCachedStats(pageId, 'list')
            data && this.statCache.set(cacheKey, data);
        }
		return data?.list;
	}
	async saveCachedList(listName, list) {
		await this.saveCachedStats({
			id: `meta--${listName}`,
			pageName: 'list',
			list
		});
	}
	async loadMetaPages() {
        debug('Loading metadata pages');
        await this.loadCache();
        await this.loadAdaptationList();
		await Promise.all([
			this.loadAuthorsList(),
			this.loadArtworksList(),
			this.loadHubsList()
		])
	}
	async loadAuthorsList() {
        if (!isEmpty(this.authorsList)) {
			return this.authorsList;
		}
		try {
			const cachedAuthors = await this.getCachedList('authors');
			if (cachedAuthors) {
				this.authorsList = cachedAuthors;
				return this.authorsList;
			}
		} catch (err) {
			console.warn('Failure loading cached author list', err);
		}
        debug('Loading authors meta list');
		const page = await this.browser.newPage();
		page.setUserAgent(this.options.ua);
        const url = await maybeMirrorUrl(this.options.authorsUrl);
		await page.goto(url);
		this.authorsList = await page.$$eval('.pages-list-item a', links => {
            function maybeEscape(unsafe) {
                if (unsafe == void 0) { return unsafe; }
                if (typeof unsafe !== "string") {unsafe = `${unsafe}`;}
                return unsafe.replace(/[<"']/g, function(x) {
                  switch (x) {case "<":return "&lt;";case '"':return "&quot;";default:return "&#039;"; }
                }).replace(/&(?!(?:apos|quot|[gl]t|amp);|#)/g, "&amp;");
            }
			const out = {};
			links.forEach(el => {
				const pageName = maybeEscape(el.getAttribute('href') || '').slice(1);
				if (!pageName) {
					return;
				}
				out[pageName] = el.innerHTML;
			});
			return out;
		});
		await page.close();
		await this.saveCachedList('authors', this.authorsList);
		return this.authorsList;
	}
	async loadArtworksList() {
        if (!isEmpty(this.artworksList)) {
			return this.artworksList;
		}

		try {
			const cachedList = await this.getCachedList('artworks');
			if (cachedList) {
				this.artworksList = cachedList;
				return this.artworksList;
			}
		} catch (err) {
			console.warn('Failure loading cached artworks list', err);
		}
        debug('loading artworks meta list');
		const page = await this.browser.newPage();
		page.setUserAgent(this.options.ua);
        const url = await maybeMirrorUrl(this.options.artworkUrl);
		await page.goto(url);
		this.artworksList = await page.$$eval('.pages-list-item a', links => {
            function maybeEscape(unsafe) {
                if (unsafe == void 0) { return unsafe; }
                if (typeof unsafe !== "string") {unsafe = `${unsafe}`;}
                return unsafe.replace(/[<"']/g, function(x) {
                  switch (x) {case "<":return "&lt;";case '"':return "&quot;";default:return "&#039;"; }
                }).replace(/&(?!(?:apos|quot|[gl]t|amp);|#)/g, "&amp;");
            }
			const out = {};
			links.forEach(el => {
				const pageName = maybeEscape(el.getAttribute('href') || '').slice(1);
				if (!pageName) {
					return;
				}
				out[pageName] = el.innerHTML;
			});
			return out;
		});
		await page.close();
		await this.saveCachedList('artworks', this.artworksList);
		return this.artworksList;
	}
	async loadHubsList() {
		if (!isEmpty(this.hubList)) {
			return this.hubList;
		}

		try {
			const cachedList = await this.getCachedList('hubs');
			if (cachedList) {
				this.hubList = cachedList;
				return this.hubList;
			}
		} catch (err) {
			console.warn('Failure loading cached hubs list', err);
		}
        debug('loading cached hubs list');
		const page = await this.browser.newPage();
		page.setUserAgent(this.options.ua);
        const url = await maybeMirrorUrl(this.options.hubsUrl);
		await page.goto(url);
		this.hubList = await page.$$eval('.pages-list-item a', links => {
            function maybeEscape(unsafe) {
                if (unsafe == void 0) { return unsafe; }
                if (typeof unsafe !== "string") {unsafe = `${unsafe}`;}
                return unsafe.replace(/[<"']/g, function(x) {
                  switch (x) {case "<":return "&lt;";case '"':return "&quot;";default:return "&#039;"; }
                }).replace(/&(?!(?:apos|quot|[gl]t|amp);|#)/g, "&amp;");
            }
			const out = {};
			links.forEach(el => {
				const pageName = maybeEscape(el.getAttribute('href') || '').slice(1);
				if (!pageName) {
					return;
				}
				out[pageName] = el.innerHTML;
			});
			return out;
		});
		await page.close();
		await this.saveCachedList('hubs', this.hubList);
		return this.hubList;
	}
	async loadAdaptationList() {
		if (!isEmpty(this.audioAdaptations)) {
			return this.audioAdaptations;
		}

		try {
			const cachedList = await this.getCachedList('audio');
			if (cachedList) {
				this.audioAdaptations = cachedList;
				return this.audioAdaptations;
			}
		} catch (err) {
			console.warn('Failure loading cached audio adaptations list', err);
		}
        debug('loading audio adaptations meta page');
		const page = await this.browser.newPage();
		page.setUserAgent(this.options.ua);
        const url = await maybeMirrorUrl(this.options.audioAdaptationsUrl);
		await page.goto(url, {
			waitUntil: ['load', 'domcontentloaded']
		});
		this.audioAdaptations = await page.$$eval('.wiki-content-table tr', rows => {
            function maybeEscape(unsafe) {
                if (unsafe == void 0) { return unsafe; }
                if (typeof unsafe !== "string") {unsafe = `${unsafe}`;}
                return unsafe.replace(/[<"']/g, function(x) {
                  switch (x) {case "<":return "&lt;";case '"':return "&quot;";default:return "&#039;"; }
                }).replace(/&(?!(?:apos|quot|[gl]t|amp);|#)/g, "&amp;");
            }

			const thisUrl = document.location.pathname;
			const out = {};
			console.log('found these rows', rows);
			rows.forEach(row => {
				const wikiLink = row.querySelector('td:first-child > a');
				const links = row.querySelectorAll('td:last-child a');
				// invalid line
				if (!wikiLink || !links || links.length < 1) {
					return;
				}
				const rawHref = wikiLink.getAttribute('href') || '';
				if (!rawHref || rawHref.startsWith(thisUrl)) {
					console.log('bad!', rawHref);
					return;
				}
				const pageName = maybeEscape(rawHref).slice(1);
				console.log('found', pageName);
				const payload = [...links].map(a => {
					return {
						title: a.textContent,
						// @ts-ignore
						url: a.href
					};
				});
				out[pageName] = payload;
			});
			return out;
		});
		await page.close();
		await this.saveCachedList('audio', this.audioAdaptations);
		return this.audioAdaptations;
	}
	async extractPartOfPage(content, selector = 'body', options = {}) {
		const page = await this.browser.newPage();
		const result = await page.evaluate((content, selector, options) => {
			const {
				startSelector,
				startText,
				endSelector,
				endText
			} = options;

			const doc = (new DOMParser()).parseFromString(content, 'application/xhtml+xml');

			let context = document.querySelector(selector);
			if (!context) {
				return '';
			}

			if (startSelector) {
				let startEl = [...context.querySelectorAll(startSelector)].find(el => {
					// if start text specified then use that one
					if (typeof startText === 'string') {
						return el.textContent.includes(startText);
					}
					if (startText instanceof RegExp) {
						return startText.test(el.textContent);
					}
					return true;
				});
				// remove everything before this in context
				do {
					while (startEl.previousSibling) {
						startEl.previousSibling.remove();
					}
					startEl = startEl.parentNode;
				} while(startEl !== context);
			}

			if (endSelector) {
				let endEl = [...context.querySelectorAll(endSelector)].find(el => {
					// if start text specified then use that one
					if (typeof endText === 'string') {
						return el.textContent.includes(endText);
					}
					if (endText instanceof RegExp) {
						return endText.test(el.textContent);
					}
					return true;
				});
				// remove everything after this in context
				do {
					while (endEl.nextSibling) {
						endEl.nextSibling.remove();
					}
					endEl = endEl.parentNode;
				} while(endEl !== context);
			}

			return context.outerHTML();
		}, options);
	}
	async getLinksByTag(tag) {
		let url = tag.startsWith('http') ? tag : `http://www.scpwiki.com/system:page-tags/tag/${tag}`;
        url = await maybeMirrorUrl(url);
		const page = await this.browser.newPage();
		await page.goto(url, { waitUntil: 'load'});
		const links = await page.$$eval('#tagged-pages-list .pages-list-item a[href]', links => {
			return [...links].map(el => {
				return {
					url: /** @type {HTMLAnchorElement} */(el).href,
					title: el.textContent
				};
			});
		});
		await page.close();
		return links;
	}
	_normalizeUrl(url) {
		let pageName = `${url}`;

		// canononical
		if (pageName.startsWith('scp-wiki')) {
			pageName = `http://${pageName}`;
		}
		// absolute
		if (pageName.startsWith('http')) {
			pageName = urlLib.parse(pageName).pathname;
		}
		// relative
		if (pageName.startsWith('/')) {
			pageName = pageName.slice(1);
		}
		return pageName;
	}
	async checkIsHub(url) {
		if (!this.hubList) {
			await this.loadHubsList();
		}
		return !!this.hubList[this._normalizeUrl(url)];
	}
	async getAdaptations(url) {
		if (!this.audioAdaptations) {
			await this.loadAdaptationList();
		}
		return this.audioAdaptations[this._normalizeUrl(url)] || [];
	}
	getAdaptationsSync(url) {
		if (url instanceof Resource) {
			// @ts-ignore
			url = url.url;
		}
		return this.audioAdaptations[this._normalizeUrl(url)] || [];
	}
	isSystem(url) {
		if (url instanceof Resource) {
			// @ts-ignore
			url = url.url;
		}
		const pageName = this._normalizeUrl(url);
		return systemPrefixes.some(p => pageName.startsWith(p)) || systemLinks.includes(pageName);
	}
	isMeta(url) {
		if (url instanceof Resource) {
			// @ts-ignore
			url = url.url;
		}
		const pageName = this._normalizeUrl(url);
		return (
			// systemLinks.includes(pageName) ||
			(pageName in this.hubList) ||
			(pageName in this.authorsList) ||
			(pageName in this.artworksList) ||
			pageName.startsWith('fragment:')
		);
	}
	hasMetaTag(tags) {
		if (!Array.isArray(tags)) {
			tags = [tags];
		}
		return tags.some(tag => metaTags.includes(tag));
	}
	isHub(url) {
		if (url instanceof Resource) {
			// @ts-ignore
			url = url.url;
		}

		if (!this.hubList) {
			throw new Error('Called before initialized');
		}
		// we want "scp-178" style
		return !!this.hubList[this._normalizeUrl(url)];
	}
}

module.exports = WikiDataLookup;
