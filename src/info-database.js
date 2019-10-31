const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const urlLib = require('url');
const {safeFilename} = require('./lib/utils');
const scpperDB = require('./scpper-db');
const Resource = require('./lib/resource');
const {systemLinks, systemPrefixes, metaTags} = require('./system-links');

function isEmpty(arr) {
	return !(arr && (typeof arr === 'object') && Object.keys(arr).length > 0);
}

class WikiDataLookup {
	constructor(app, opts = {}) {
		/** @type {import("puppeteer").Browser} */
		this.browser = app.browser;

		const cacheOpts = {
			stats: true,
			path: 'cache',
			// one month default cache time
			maxAge: 30 * 24 * 60 * 60 * 1000,
			...(opts.cache)
		};

		this.options = {
			headless: false,
			debug: true,
			audioAdaptationsUrl: 'http://scp-wiki.wikidot.com/printer--friendly/audio-adaptations',
			hubsUrl: 'http://www.scp-wiki.net/system:page-tags/tag/hub#pages',
			authorsUrl: 'http://scp-wiki.wikidot.com/system:page-tags/tag/author',
			artworkUrl: 'http://scp-wiki.wikidot.com/system:page-tags/tag/artwork',
			ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Googlebot Chrome/76.0.3809.132 Safari/537.36',
			...opts,
			cache: cacheOpts
		};
	}
	async initialize() {
		// not actually necessary if loading lazily
		await Promise.all([
			this.loadMetaPages(),
			this.loadCache()
		]);
	}
	async loadCache() {
		if (!this.options.cache.stats) {
			return;
		}

		this.statCache = new Map();
		try {
			// make sure directory exists
			await fs.mkdir(this.options.cache.path, {recursive: true});
			const statFiles = await fs.readdir(this.options.cache.path, { withFileTypes: true });
			for (let file of statFiles) {
				// only valid entries
				if (!file.isFile || !file.name.endsWith('.json')) {
					continue;
				}
				const pageId = file.name.split('_')[0];
				this.statCache.set(pageId, file.name);
			}
		} catch (err) {
			console.warn('Unable to load stats cache', err);
		}
	}
	async saveCachedStats(stats) {
		stats.lastCached = new Date();
		// make name safe
		const filename = `${stats.id}_${stats.pageName}.json`
			.replace(/[ <>():"\/\\|?*\x00-\x1F]/g, '_');
		const filepath = path.join(this.options.cache.path, filename);
		try {
			await fs.writeFile(filepath, JSON.stringify(stats, null, '  '));
		} catch (err) {
			console.warn('failed to write stats to cache', err);
		}
	}
	async getCachedStats(pageId) {
		const cacheOpts = this.options.cache;
		if (!cacheOpts.stats) {
			return;
		}
		if (!this.statCache) {
			await this.loadCache();
		}
		//  make sure in cache
		const filename = this.statCache.get(`${pageId}`.replace(/[ <>():"\/\\|?*\x00-\x1F]/g, '_'));
		if (!filename) {
			return;
		}
		try {
			const raw = await fs.readFile(path.join(cacheOpts.path, filename));
			const stats = JSON.parse(raw.toString());
			const age = (new Date()).getTime() - (new Date(stats.lastCached)).getTime();
			// don't return if stale
			if (age <= cacheOpts.maxAge) {
				return stats;
			}
		} catch (err) {
			console.warn(`Failed to get cache data for ${pageId}`, err);
		}
	}
	async getStats(pageName, pageId) {
		const {stats: cacheEnabled} = this.options.cache;
		// check if exists
		if (pageId && cacheEnabled) {
			const result = await this.getCachedStats(pageId);
			if (result) {
				return result;
			}
		}

		try {
			const result = await (
				pageId ? scpperDB.getByPageId(pageId) : scpperDB.getByTitle(pageName)
			);
			result.pageName = pageName;

			if (cacheEnabled) {
				await this.saveCachedStats(result);
			}

			return result;
		} catch (err) {
			console.error(`Failed to get stats for ${pageName} ${pageId}`, err);
			return {
				pageName,
				author: '',
				date: '',
				rating: '',
				score: ''
			};
		}
	}
	async getCachedList(listName) {
		// __meta__authors
		const data = await this.getCachedStats(`meta--${listName}`);
		if (data) {
			return data.list;
		};
	}
	async saveCachedList(listName, list) {
		await this.saveCachedStats({
			id: `meta--${listName}`,
			pageName: 'list',
			list
		});
	}
	async loadMetaPages() {
		await Promise.all([
			this.loadAdaptationList(),
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

		const page = await this.browser.newPage();
		page.setUserAgent(this.options.ua);
		await page.goto(this.options.authorsUrl);
		this.authorsList = await page.$$eval('.pages-list-item a', links => {
			const out = {};
			links.forEach(el => {
				const pageName = (el.getAttribute('href') || '').slice(1);
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

		const page = await this.browser.newPage();
		page.setUserAgent(this.options.ua);
		await page.goto(this.options.artworkUrl);
		this.artworksList = await page.$$eval('.pages-list-item a', links => {
			const out = {};
			links.forEach(el => {
				const pageName = (el.getAttribute('href') || '').slice(1);
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

		const page = await this.browser.newPage();
		page.setUserAgent(this.options.ua);
		await page.goto(this.options.hubsUrl);
		this.hubList = await page.$$eval('.pages-list-item a', links => {
			const out = {};
			links.forEach(el => {
				const pageName = (el.getAttribute('href') || '').slice(1);
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

		const page = await this.browser.newPage();
		page.setUserAgent(this.options.ua);
		await page.goto(this.options.audioAdaptationsUrl, {
			waitUntil: ['load', 'domcontentloaded']
		});
		this.audioAdaptations = await page.$$eval('.wiki-content-table tr', rows => {
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
				const pageName = rawHref.slice(1);
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
	async getLinksFromUrl(url, options = {}) {
		const {
			selector = 'body',
			startSelector,
			endSelector,
			sameDomain = true
		} = options;

		const page = await this.browser.newPage();
		await page.goto(url, { waitUntil: 'load'});
		throw new Error('Not Implemented');
	}
	async getLinksByTag(tag) {
		const url = tag.startsWith('http') ? tag : `http://www.scp-wiki.net/system:page-tags/tag/${tag}`;
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
