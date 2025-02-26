const config = require('../book-config');
const {escape} = require('../lib/utils');
const DocPart = require('../lib/doc-part');

function formatDocPart(docPart, options) {
	const {
		bookPath,
		title = 'Section',
		titleHTML,
		chapters = []
	} = docPart;

	return `<li class="toc-doc-part"><a href="${bookPath}">${titleHTML || escape(title)}</a>${
		''
		}<ol class="toc-list">${
			chapters
					.map((chapter, j) => {
						// NOTE not trying to use book chapter numbers because docparts messes that up
						//const chapterIndex = index + j;
						return formatChapter(chapter, '', options);
					})
					.join('\n')
		}</ol></li>`;
}
function formatChapter(chapter, chapterIndex, options = {}) {
	const {includeRating = true} = options;

	if (chapter instanceof DocPart) {
		return formatDocPart(chapter, options);
	}
	const {
		bookPath,
		title = `Chapter ${chapterIndex || ''}`,
		stats: { rating } = {}
	} = chapter;

	const author = Array.isArray(chapter.author) ? chapter.author.join(', ') : chapter.author;
	const authorEl = author ? ` — <small class="toc-author">${ escape(author) }</small>` : '';

	const meta = (includeRating && rating) ? `(Rating: ${escape(rating)})` : '';

	return `<li class="toc-chapter"><a href="${bookPath}">${escape(title)}${authorEl} <small class="toc-meta">${meta}</small></a></li>`;
}

function genPage(data, title, html) {
	const {
		id,
		lang = 'en',
		stylesheets = ['css/base.css', 'css/style.css', 'css/fonts.css']
	} = data;

	let stylesheetHTML = stylesheets
		.map(path => `<link rel="stylesheet" type="text/css" href="${path}" />`)
		.join('');

	if (config.has('input.customCSS')) {
		stylesheetHTML += `<style>${config.get('input.customCSS')}</style>`;
	}

	return `<?xml version="1.0" encoding="UTF-8"?>
	<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${ lang }" lang="${ lang }">
	<head>
		<title>${ escape(title) }</title>
		<meta charset="UTF-8" />${
			stylesheetHTML
		}<meta name="EPB-UUID" content="${ id }" />
	</head>
	<body dir="ltr">${
		html
	}</body>
	</html>`;
}

/**
 *
 * @param {*} data
 * @param {import('../..').BookOptions} options
 */
function genToc(data, options = {}) {
	const {
		toc: {
			title: tocTitle = 'Table Of Contents',
			prefacePath = 'preface.xhtml',
			appendixPath = 'appendix.xhtml'
		},
		layout: {
			nested: chapters = [],
			chapters: allChapters = [],
			appendix: supplemental = []
		}
	} = data;

	const firstChapter = chapters.length > 0 ? chapters[0] : {};

	let chapterIndex = 1;

	const html = `<div class="toc-body">
	<nav id="toc" epub:type="toc">
		<h1>Contents</h1>
		<ol class="toc-list">${
				chapters
					.map((chapter, index) => {
						// NOTE TODO doc parts will mess up this count
						try {
							const result = formatChapter(chapter, chapterIndex, options);
							if (!(chapter instanceof DocPart)) {
								chapterIndex += 1;
							}
							return result;
						} catch (err) {
							console.error(`Error formatting chapter at ${chapter?.url || chapter.message} - ${err}`)
							return ''
						}
					})
					.join('\n')

		}<li class="toc-doc-part"><a href="${appendixPath}">Appendix</a>${
			''
			// <ol class="toc-list">${
			// supplemental.map(chapter => {
			// 	return formatChapter(chapter);
			// }).join('\n')
			//</ol>
		}</li>
		</ol>
	</nav>
	<nav epub:type="landmarks" id="guide" hidden="hidden">
		<h2>Guide</h2>
		<ol class="toc-list">
			<li><a epub:type="toc" href="#toc">${ tocTitle }</a></li>
			<li><a epub:type="frontmatter" href="${prefacePath}">Preface</a></li>
			<li><a epub:type="bodymatter" href="${ firstChapter.bookPath }">Begin Reading</a></li>
			<li><a epub:type="backmatter" href="${appendixPath}">Appendix</a></li>
		</ol>
	</nav>
</div>`;

	return genPage(data, tocTitle, html);
}

function genAppendix(data, options) {
	const {
		layout: {
			appendix: supplemental = []
		}
	} = data;

	const html = `<h1>Appendix</h1>
<ol class="toc-list">${
	supplemental
		.map((c, i) => {
			try {
				return formatChapter(c, i, options);
			} catch (err) {
				console.error(`Error formatting chapter at ${c?.url || c.message} - ${err}`)
				return ''
			}
		})
		.join('\n')
}</ol>`

	return genPage(data, 'Appendix', html);
}

module.exports = {
	genToc,
	genAppendix
};
